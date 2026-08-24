// Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
// SPDX-License-Identifier: Apache-2.0

// gainCurve 指标计算 (CPU 侧) — 移植自 uwa_gaincurve_ccm.py §2/§10
// CIELAB 色相偏移 ΔH° + 亮度漂移 |Y_out/Y_intended - 1|

import { CONFIG, P3_LUMA_WEIGHTS } from "./gaincurve-metadata.js";
import { pchipSlopes } from "./pchip.js";

// ---- Display-P3 → XYZ 矩阵 ----
function primariesToXyz(rxy, gxy, bxy, wxy) {
  const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
  const Xr = xyz(rxy), Xg = xyz(gxy), Xb = xyz(bxy);
  const M = [
    [Xr[0], Xg[0], Xb[0]],
    [Xr[1], Xg[1], Xb[1]],
    [Xr[2], Xg[2], Xb[2]],
  ];
  const Wn = xyz(wxy);
  const S = solve3(M, Wn);
  return M.map((row, i) => row.map(v => v * S[i]));
}
function solve3(M, b) {
  // Cramer
  const det = m3det(M);
  const inv = [
    (b[0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (b[1] * M[2][2] - M[1][2] * b[2]) + M[0][2] * (b[1] * M[2][1] - M[1][1] * b[2])) / det,
    (M[0][0] * (b[1] * M[2][2] - M[1][2] * b[2]) - b[0] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * b[2] - b[1] * M[2][0])) / det,
    (M[0][0] * (M[1][1] * b[2] - b[1] * M[2][1]) - M[0][1] * (M[1][0] * b[2] - b[1] * M[2][0]) + b[0] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det,
  ];
  return inv;
}
function m3det(M) {
  return M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
       - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
       + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
}

const P3_R = [0.68, 0.32], P3_G = [0.265, 0.69], P3_B = [0.15, 0.06], D65 = [0.3127, 0.329];
const M_P3_XYZ = primariesToXyz(P3_R, P3_G, P3_B, D65);
const LUMA_W = [M_P3_XYZ[1][0], M_P3_XYZ[1][1], M_P3_XYZ[1][2]].map(v => v);
const LUMA_W_NORM = (() => { const s = LUMA_W.reduce((a, b) => a + b, 0); return LUMA_W.map(v => v / s); })();

// ---- PQ EOTF/OETF ----
const _m1 = 2610 / 16384, _m2 = 2523 / 4096 * 128, _c1 = 3424 / 4096, _c2 = 2413 / 4096 * 32, _c3 = 2392 / 4096 * 32;
function pqEotf(E) { const e = Math.min(Math.max(E, 0), 1); const ep = Math.pow(e, 1 / _m2); const num = Math.max(ep - _c1, 0); const den = _c2 - _c3 * ep; return 10000 * Math.pow(num / den, 1 / _m1); }
function pqOetf(L) { const ln = Math.min(Math.max(L, 0), 10000) / 10000; const lm = Math.pow(ln, _m1); return Math.pow((_c1 + _c2 * lm) / (1 + _c3 * lm), _m2); }

// ---- 感知编码 ----
function fPerception(C, mode, lWhite) {
  if (mode === 0) return pqOetf(Math.min(Math.max(C * lWhite, 0), 10000));
  if (mode === 1) return Math.pow(Math.max(C, 0), 1 / 2.4);
  if (mode === 2) return Math.log2(Math.max(C, 1e-6));
  return C; // linear
}
function fPerceptionInv(P, mode, lWhite) {
  if (mode === 0) return pqEotf(Math.min(Math.max(P, 0), 1)) / lWhite;
  if (mode === 1) return Math.pow(Math.max(P, 0), 2.4);
  if (mode === 2) return Math.pow(2, P);
  return P;
}

// ---- Hermite 曲线 (CPU, 与 shader 同构) ----
function evaluateCurve(x, cps, log2Extrap) {
  const n = cps.length;
  if (x <= cps[0].x) return cps[0].y;
  if (x >= cps[n - 1].x) {
    if (log2Extrap) return cps[n - 1].y + Math.log2(cps[n - 1].x / Math.max(x, 1e-12));
    return cps[n - 1].y;
  }
  let i = 0; while (i < n - 1 && !(cps[i].x <= x && x <= cps[i + 1].x)) i++;
  const x0 = cps[i].x, x1 = cps[i + 1].x, y0 = cps[i].y, y1 = cps[i + 1].y;
  const m0 = cps[i].m, m1 = cps[i + 1].m;
  const h = x1 - x0, t = (x - x0) / h;
  const mh0 = m0 * h, mh1 = m1 * h;
  const c3 = 2 * y0 + mh0 - 2 * y1 + mh1, c2 = -3 * y0 + 3 * y1 - 2 * mh0 - mh1, c1 = mh0, c0 = y0;
  return ((c3 * t + c2) * t + c1) * t + c0;
}

// ---- f_common / component_mixing ----
function fCommon(C, k) {
  const cr = C[0], cg = C[1], cb = C[2];
  const cmax = Math.max(...C), cmin = Math.min(...C);
  return cr * k.k_red + cg * k.k_green + cb * k.k_blue + cmax * k.k_max + cmin * k.k_min;
}

// ---- 退白 ----
function applySaturation(Cout, S, mode, lWhite) {
  const Y = Cout[0] * LUMA_W_NORM[0] + Cout[1] * LUMA_W_NORM[1] + Cout[2] * LUMA_W_NORM[2];
  const grey = [Y, Y, Y];
  const P = [
    S * fPerception(Cout[0], mode, lWhite) + (1 - S) * fPerception(grey[0], mode, lWhite),
    S * fPerception(Cout[1], mode, lWhite) + (1 - S) * fPerception(grey[1], mode, lWhite),
    S * fPerception(Cout[2], mode, lWhite) + (1 - S) * fPerception(grey[2], mode, lWhite),
  ];
  return [fPerceptionInv(P[0], mode, lWhite), fPerceptionInv(P[1], mode, lWhite), fPerceptionInv(P[2], mode, lWhite)];
}

// ---- CIELAB ----
function linearP3ToLab(C) {
  const X = C[0] * M_P3_XYZ[0][0] + C[1] * M_P3_XYZ[0][1] + C[2] * M_P3_XYZ[0][2];
  const Y = C[0] * M_P3_XYZ[1][0] + C[1] * M_P3_XYZ[1][1] + C[2] * M_P3_XYZ[1][2];
  const Z = C[0] * M_P3_XYZ[2][0] + C[1] * M_P3_XYZ[2][1] + C[2] * M_P3_XYZ[2][2];
  const W = M_P3_XYZ; const Xn = W[0][0] + W[0][1] + W[0][2], Yn = W[1][0] + W[1][1] + W[1][2], Zn = W[2][0] + W[2][1] + W[2][2];
  const f = t => { const d = 6 / 29; return t > d ** 3 ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29; };
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function hueAngleDeg(C) { const [, a, b] = linearP3ToLab(C); return Math.degrees ? Math.degrees(Math.atan2(b, a)) : (Math.atan2(b, a) * 180 / Math.PI); }
function hueDiff(h1, h2) { let d = (h1 - h2 + 180) % 360 - 180; if (d < -180) d += 360; return Math.abs(d); }

// ---- 单像素完整变换 (对齐 shader 的 UwaToneMapInGainApplicationSpace + UwaApplySaturation) ----
// w: 该视图的插值权重 (Alternate 固定传 1.0 = H_alt 满增益; Target 传当前滑块推出的 w)
// useCoupled=false (新法): k_component=0, 三通道共享标量增益 G, 退白权重
//   S_total=(1-w)*1 + w*S(fc) (baseline-blend, 对齐 ToneMapper.total_saturation)
// useCoupled=true  (2094-50): k_component=0.35, 三通道各自的 M 值对应各自的增益 G_i, 无退白
function transformPixel(Cin, w, gainCps, satCps, useCoupled, mode, lWhite) {
  const k = useCoupled ? CONFIG.K_COUPLED : CONFIG.K_NEW;
  const fc = fCommon(Cin, k); // f_common 不含 k_component 项 (2094-50 公式 9)
  let C1;
  if (!useCoupled) {
    const G = evaluateCurve(fc, gainCps, true);
    C1 = Cin.map(v => v * Math.pow(2, w * G));
  } else {
    const M = Cin.map(v => v * k.k_component + fc);
    const G = M.map(m => evaluateCurve(m, gainCps, true));
    C1 = Cin.map((v, i) => v * Math.pow(2, w * G[i]));
  }
  const S_total = useCoupled ? 1.0 : ((1 - w) * 1.0 + w * evaluateCurve(fc, satCps, true));
  return applySaturation(C1, S_total, mode, lWhite);
}

// ---- 图像采样预处理: 把 WebGL 读回的编码像素解码 + 预算好 hue/chroma/亮度 (只需在图像加载时算一次) ----
// rawFloat: Float32Array, RGBA 交错, 值为编码域 (当前固定按 PQ 解码, 与 state.contentTransfer=PQ 一致)
export function prepareImageSamples(rawFloat, width, height, lWhite) {
  const n = width * height;
  const samples = new Array(n);
  const Yf = C => C[0] * LUMA_W_NORM[0] + C[1] * LUMA_W_NORM[1] + C[2] * LUMA_W_NORM[2];
  for (let i = 0; i < n; i++) {
    const off = i * 4;
    const E = [rawFloat[off], rawFloat[off + 1], rawFloat[off + 2]];
    // pqEotf 已经返回绝对 nits (0-10000), 不要再乘 10000 (与 Python 版 to_gain_application_space 一致)
    const Cin = E.map(e => pqEotf(Math.min(Math.max(e, 0), 1)) / lWhite);
    const [, a0, b0] = linearP3ToLab(Cin);
    samples[i] = { Cin, h0: hueAngleDeg(Cin), chroma: Math.hypot(a0, b0), Yin: Yf(Cin) };
  }
  return samples;
}

// ---- 主指标: 用真实图像采样, 分别算 Alternate vs Base 和 Target vs Base 的平均色相偏移/亮度漂移 ----
// 色相偏移: 按每个像素在 Base 处的色度 (chroma_ab) 加权平均 —— 近灰色像素的色相角在数值上
// 极不稳定 (a,b 都接近 0 时 atan2 给出几乎随机的角度), 用色度加权可自然压低这类噪声的影响,
// 而不需要设一个生硬的阈值剔除像素。
// 亮度漂移: 以新法步骤一的纯标量增益 (2^(w·G_new), 不含退白) 作为"理想只提亮不偏色"的基准,
// 比较 Alternate/Target 实际亮度相对这个基准的偏差 —— 无论当前用新法还是 2094-50 耦合法显示,
// 基准都固定用新法算, 这样才能看出"实际显示效果距离理想有多远"。
export function computeImageMetrics(state) {
  const samples = state.imageSamples;
  const gainCps = state.gainControlPoints;
  const satCps = state.satControlPoints;
  if (!samples || !samples.length || !gainCps || !satCps) return null;

  const mode = state.perceptionMode;
  const lWhite = state.diffuseWhite;
  const hBase = state.hBaseline ?? Math.log2(CONFIG.X_GAIN[CONFIG.X_GAIN.length - 1]);
  const w = (state.hTarget - hBase) / (0 - hBase);
  const Yf = C => C[0] * LUMA_W_NORM[0] + C[1] * LUMA_W_NORM[1] + C[2] * LUMA_W_NORM[2];

  // 同时算两种方法: useCoupled=false (新法) 和 useCoupled=true (2094-50)
  const methods = [
    { key: 'new', useCoupled: false, hueAltW: 0, hueTgtW: 0, lumAltSum: 0, lumTgtSum: 0 },
    { key: 'coupled', useCoupled: true, hueAltW: 0, hueTgtW: 0, lumAltSum: 0, lumTgtSum: 0 },
  ];
  let chromaSum = 0;

  for (const s of samples) {
    const { Cin, h0, chroma, Yin } = s;

    // 亮度基准: 始终用新法的标量增益 (与显示方式无关, 代表"理想只提亮不偏色")
    const fcRef = fCommon(Cin, CONFIG.K_NEW);
    const Gref = evaluateCurve(fcRef, gainCps, true);
    const YintendedAlt = Yin * Math.pow(2, 1.0 * Gref);
    const YintendedTgt = Yin * Math.pow(2, w * Gref);

    for (const m of methods) {
      const Calt = transformPixel(Cin, 1.0, gainCps, satCps, m.useCoupled, mode, lWhite);
      const Ctgt = transformPixel(Cin, w, gainCps, satCps, m.useCoupled, mode, lWhite);

      m.hueAltW += hueDiff(hueAngleDeg(Calt), h0) * chroma;
      m.hueTgtW += hueDiff(hueAngleDeg(Ctgt), h0) * chroma;
      m.lumAltSum += Math.abs(Yf(Calt) / YintendedAlt - 1) * 100;
      m.lumTgtSum += Math.abs(Yf(Ctgt) / YintendedTgt - 1) * 100;
    }
    chromaSum += chroma;
  }

  const n = samples.length;
  const safeChromaSum = chromaSum > 1e-6 ? chromaSum : 1e-6;
  const result = { sampleCount: n };
  for (const m of methods) {
    result[m.key] = {
      altHueDeg: m.hueAltW / safeChromaSum,
      targetHueDeg: m.hueTgtW / safeChromaSum,
      altLumPct: m.lumAltSum / n,
      targetLumPct: m.lumTgtSum / n,
    };
  }
  return result;
}
