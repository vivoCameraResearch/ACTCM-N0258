// Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
//  uwa-tonemap-gl.js — Gain Curve + Saturation Curve 的 GPU 实现
//
//  Clean-room 实现，不含任何第三方源码。全部公式与本项目 Python 参考实现
//  algorithm/uwa_gaincurve_ccm.py 逐项对齐：
//    * §4 Component Mixing        -> UwaFCommon / UwaComponentMix   （ST 2094-50 公式 9/10）
//    * §3 Gain Curve              -> UwaEvalCurve                   （ST 2094-50 公式 11/12）
//    * §5 Headroom 自适应插值     -> uwa_weight_i / uwa_weight_j    （ST 2094-50 §6.2.5）
//    * §6 感知域退白（本提案新增）-> UwaApplySaturation
//
//  实现说明：控制点数量很少（本方案 ≤ 8），故直接用 uniform 数组传入并在着色器内
//  线性扫描定位区间，无需曲线纹理与二分查找，逻辑更直观、便于逐项对照公式核验。
// ============================================================================

const kUwaMaxControlPoints = 16;

const kUwaToneMapGLSL = `
const int kUwaMaxCp = ` + kUwaMaxControlPoints + `;

// headroom 自适应插值的两个参与项（权重之和为 1；基准图以 n<=0 表示零增益/S=1）
uniform float uwa_weight_i;
uniform float uwa_weight_j;

// component mixing 系数：rgb = (k_red, k_green, k_blue)，mmc = (k_max, k_min, k_component)
uniform vec3 uwa_mix_rgb_i;
uniform vec3 uwa_mix_rgb_j;
uniform vec3 uwa_mix_mmc_i;
uniform vec3 uwa_mix_mmc_j;

// 控制点：每个 vec3 = (x, y, m)
uniform int  uwa_gain_n_i;
uniform int  uwa_gain_n_j;
uniform vec3 uwa_gain_cp_i[kUwaMaxCp];
uniform vec3 uwa_gain_cp_j[kUwaMaxCp];

uniform int  uwa_sat_n_i;
uniform int  uwa_sat_n_j;
uniform vec3 uwa_sat_cp_i[kUwaMaxCp];
uniform vec3 uwa_sat_cp_j[kUwaMaxCp];

// 饱和度曲线自变量所用的 component mixing 系数（对应 Python total_saturation 的 k_for_fc）
uniform vec3 uwa_sat_mix_rgb;
uniform vec3 uwa_sat_mix_mmc;

uniform int  apply_saturation;   // 0 = 仅亮度压缩；1 = 追加感知域退白
uniform vec3 luma_weights;       // 等亮度灰所用的亮度权重
uniform int  perception_mode;    // 0=pq  1=gamma  2=log2  3=linear

// ---- 分段三次 Hermite 求值（ST 2094-50 公式 11/12）----
// 低端水平钳位；区间内三次 Hermite；高端 y_last + log2(x / x_last)。
// n <= 0 表示该项为基准图，直接返回 defaultY（增益曲线取 0，饱和度曲线取 1）。
float UwaEvalCurve(vec3 cp[kUwaMaxCp], int n, float x, float defaultY) {
  if (n <= 0) return defaultY;
  if (n == 1) return cp[0].y;
  if (x <= cp[0].x) return cp[0].y;

  vec3 last = cp[n - 1];
  if (x >= last.x) return last.y + log2(max(x, 1e-9) / last.x);

  for (int s = 0; s < kUwaMaxCp - 1; ++s) {
    if (s >= n - 1) break;
    if (x <= cp[s + 1].x) {
      float x0 = cp[s].x,     x1 = cp[s + 1].x;
      float y0 = cp[s].y,     y1 = cp[s + 1].y;
      float dx = max(x1 - x0, 1e-9);
      float t  = (x - x0) / dx;
      float m0 = cp[s].z * dx;
      float m1 = cp[s + 1].z * dx;
      float c3 =  2.0 * y0 + m0 - 2.0 * y1 + m1;
      float c2 = -3.0 * y0 + 3.0 * y1 - 2.0 * m0 - m1;
      return y0 + t * (m0 + t * (c2 + t * c3));
    }
  }
  return last.y;
}

// ---- Component Mixing（ST 2094-50 公式 9/10）----
// f_common = k_r*R + k_g*G + k_b*B + k_max*max(RGB) + k_min*min(RGB)
float UwaFCommon(vec3 C, vec3 krgb, vec3 kmmc) {
  float cmax = max(C.r, max(C.g, C.b));
  float cmin = min(C.r, min(C.g, C.b));
  return dot(C, krgb) + cmax * kmmc.x + cmin * kmmc.y;
}

// M = C * k_component + f_common
// 本提案取 k_component = 0，三通道自变量相同 -> 同一标量增益 -> 等比缩放，不偏色。
vec3 UwaComponentMix(vec3 C, vec3 krgb, vec3 kmmc) {
  return C * kmmc.z + vec3(UwaFCommon(C, krgb, kmmc));
}

// ---- 单个备用图的逐通道 log2 增益 ----
vec3 UwaLogGain(vec3 C, vec3 krgb, vec3 kmmc,
                vec3 cp[kUwaMaxCp], int n) {
  if (n <= 0) return vec3(0.0);
  vec3 M = UwaComponentMix(C, krgb, kmmc);
  return vec3(UwaEvalCurve(cp, n, M.r, 0.0),
              UwaEvalCurve(cp, n, M.g, 0.0),
              UwaEvalCurve(cp, n, M.b, 0.0));
}

// ---- 步骤一：亮度压缩（ST 2094-50 §6.2.5 插值 + 增益应用）----
vec3 UwaToneMapInGainApplicationSpace(vec3 C) {
  vec3 G = uwa_weight_i * UwaLogGain(C, uwa_mix_rgb_i, uwa_mix_mmc_i,
                                     uwa_gain_cp_i, uwa_gain_n_i)
         + uwa_weight_j * UwaLogGain(C, uwa_mix_rgb_j, uwa_mix_mmc_j,
                                     uwa_gain_cp_j, uwa_gain_n_j);
  return C * exp2(G);
}

// ---- 插值后的总饱和度系数 S_total ----
float UwaTotalSaturation(vec3 C) {
  float fc = UwaFCommon(C, uwa_sat_mix_rgb, uwa_sat_mix_mmc);
  return uwa_weight_i * UwaEvalCurve(uwa_sat_cp_i, uwa_sat_n_i, fc, 1.0)
       + uwa_weight_j * UwaEvalCurve(uwa_sat_cp_j, uwa_sat_n_j, fc, 1.0);
}

// ---- 感知编码 f_perception 及其逆（Python §6）----
// 输入为"增益应用色彩空间"下的相对值，1.0 = HDR 参考白。
float UwaPerceptionFwd(float c) {
  if (perception_mode == 0) {
    return transferFromLinear(
        clamp(c * hdrReferenceWhite / 10000.0, 0.0, 1.0), kTransferPQ);
  }
  if (perception_mode == 1) return pow(max(c, 0.0), 1.0 / 2.4);
  if (perception_mode == 2) return log2(max(c, 1e-6));
  return c;
}

float UwaPerceptionInv(float p) {
  if (perception_mode == 0) {
    return transferToLinear(clamp(p, 0.0, 1.0), kTransferPQ)
           * 10000.0 / hdrReferenceWhite;
  }
  if (perception_mode == 1) return pow(max(p, 0.0), 2.4);
  if (perception_mode == 2) return exp2(p);
  return p;
}

vec3 UwaPerceptionFwd3(vec3 c) {
  return vec3(UwaPerceptionFwd(c.r), UwaPerceptionFwd(c.g), UwaPerceptionFwd(c.b));
}
vec3 UwaPerceptionInv3(vec3 p) {
  return vec3(UwaPerceptionInv(p.r), UwaPerceptionInv(p.g), UwaPerceptionInv(p.b));
}

// ---- 步骤二：感知域退白（本提案相对 ST 2094-50 的核心新增）----
// 在感知域把彩色向量朝"等亮度中性灰"收缩：
//   P = S * f(C_out) + (1 - S) * f(grey),   grey = dot(C_out, luma_weights)
//   C' = f^-1(P)
// 沿灰轴收缩天然保持色相；S 由饱和度曲线按输入亮度给出，与增益曲线正交。
vec3 UwaApplySaturation(vec3 C_in, vec3 C_out) {
  if (apply_saturation == 0) return C_out;
  float S = UwaTotalSaturation(C_in);
  vec3 grey = vec3(dot(C_out, luma_weights));
  vec3 P = S * UwaPerceptionFwd3(C_out) + (1.0 - S) * UwaPerceptionFwd3(grey);
  return UwaPerceptionInv3(P);
}
`;

// ============================================================================
//  JS 侧：把元数据 + 目标 headroom 解析为着色器 uniform
// ============================================================================

// 把 [{x,y,m}, ...] 摊平为 vec3 数组所需的 Float32Array（不足部分补零）
function uwaFlattenControlPoints(controlPoints) {
  const out = new Float32Array(kUwaMaxControlPoints * 3);
  const pts = controlPoints || [];
  const n = Math.min(pts.length, kUwaMaxControlPoints);
  for (let i = 0; i < n; ++i) {
    out[i * 3 + 0] = Number(pts[i].x);
    out[i * 3 + 1] = Number(pts[i].y);
    out[i * 3 + 2] = Number(pts[i].m);
  }
  return { data: out, count: n };
}

// 基准图：无增益曲线、无饱和度曲线，component mixing 取全零
const kUwaBaselineEntry = {
  mixRgb: [0, 0, 0],
  mixMmc: [0, 0, 0],
  gain: { data: new Float32Array(kUwaMaxControlPoints * 3), count: 0 },
  sat:  { data: new Float32Array(kUwaMaxControlPoints * 3), count: 0 },
};

class UwaGainCurveToneMapper {
  // gl: WebGL2RenderingContext；metadata: 见 src/gaincurve-metadata.js
  constructor(gl, metadata) {
    this.gl = gl;
    this.metadata = metadata;
    const hatm = metadata.headroomAdaptiveToneMap;
    this.hatm = hatm;

    // 预解析每个备用图，避免每帧重复摊平
    this.entries = (hatm.alternateImages || []).map((alt) => {
      const cgf = alt.colorGainFunction || {};
      const mix = cgf.componentMix || {};
      return {
        mixRgb: [Number(mix.red) || 0, Number(mix.green) || 0, Number(mix.blue) || 0],
        mixMmc: [Number(mix.max) || 0, Number(mix.min) || 0, Number(mix.component) || 0],
        gain: uwaFlattenControlPoints(cgf.gainCurve && cgf.gainCurve.controlPoints),
        sat: uwaFlattenControlPoints(cgf.saturationCurve && cgf.saturationCurve.controlPoints),
      };
    });
  }

  _entryOf(index) {
    return index === kUwaBaselineIndex ? kUwaBaselineEntry : this.entries[index];
  }

  // 依据目标 headroom 计算插值权重，并写入全部 uniform。
  // 第三个参数保留以兼容旧调用签名（本实现不使用纹理单元）。
  setUniforms(hTarget, program, _unusedTextureUnit) {
    const gl = this.gl;
    const weights = uwaHeadroomAdaptiveWeights(this.hatm, hTarget);

    const a = weights[0];
    const b = weights.length > 1 ? weights[1] : { index: a.index, weight: 0.0 };
    const ea = this._entryOf(a.index);
    const eb = this._entryOf(b.index);

    const loc = (name) => gl.getUniformLocation(program, name);

    gl.uniform1f(loc('uwa_weight_i'), a.weight);
    gl.uniform1f(loc('uwa_weight_j'), b.weight);

    gl.uniform3fv(loc('uwa_mix_rgb_i'), ea.mixRgb);
    gl.uniform3fv(loc('uwa_mix_rgb_j'), eb.mixRgb);
    gl.uniform3fv(loc('uwa_mix_mmc_i'), ea.mixMmc);
    gl.uniform3fv(loc('uwa_mix_mmc_j'), eb.mixMmc);

    gl.uniform1i(loc('uwa_gain_n_i'), ea.gain.count);
    gl.uniform1i(loc('uwa_gain_n_j'), eb.gain.count);
    gl.uniform3fv(loc('uwa_gain_cp_i'), ea.gain.data);
    gl.uniform3fv(loc('uwa_gain_cp_j'), eb.gain.data);

    gl.uniform1i(loc('uwa_sat_n_i'), ea.sat.count);
    gl.uniform1i(loc('uwa_sat_n_j'), eb.sat.count);
    gl.uniform3fv(loc('uwa_sat_cp_i'), ea.sat.data);
    gl.uniform3fv(loc('uwa_sat_cp_j'), eb.sat.data);

    // 饱和度曲线自变量所用的 mixing 系数：取第一个带饱和度曲线的备用图，
    // 使 S_total 的自变量在插值两端保持一致（对应 Python 显式传入 k_for_fc）。
    const satRef = this.entries.find((e) => e.sat.count > 0) || kUwaBaselineEntry;
    gl.uniform3fv(loc('uwa_sat_mix_rgb'), satRef.mixRgb);
    gl.uniform3fv(loc('uwa_sat_mix_mmc'), satRef.mixMmc);
  }
}
