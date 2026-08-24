// Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
// SPDX-License-Identifier: Apache-2.0

// gainCurve CONFIG → ST 2094-50 语义的元数据 JSON
// 移植自 uwa_gaincurve_ccm.py 的 CONFIG 类 + build_tonemapper
import { buildControlPoints } from "./pchip.js";

// ---- gainCurve CONFIG (uwa_gaincurve_ccm.py:31-60) ----
export const CONFIG = {
  L_WHITE: 203.0,
  H_TARGET: 0.0,
  X_GAIN: [0.00, 0.50, 1.00, 1.75, 3.00, 4.50, 6.55],
  Y_GAIN: [0.00, 0.00, -0.152, -0.866, -1.60, -2.174, -2.711],
  X_SAT: [0.00, 0.30, 1.00, 2.89, 4.79, 7.40],
  S_SAT: [1.00, 1.00, 1.00, 0.95, 0.86, 0.63],
  K_NEW: { k_red: 0.0, k_green: 0.0, k_blue: 0.0, k_max: 1.0, k_min: 0.0, k_component: 0.0 },
  K_COUPLED: { k_red: 0.0, k_green: 0.0, k_blue: 0.0, k_max: 0.65, k_min: 0.0, k_component: 0.35 },
  PERCEPTION: "pq",
  LUMA_WEIGHTS: "p3",
};

// Display-P3 (SMPTE EG 432-1, D65) 色度坐标 — gain application space
// [rx,ry, gx,gy, bx,by, wx,wy]
export const P3_CHROMATICITIES = [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329];

// Display-P3 精确亮度权重 (由 primaries_to_xyz 的 Y 行算出)
export const P3_LUMA_WEIGHTS = [0.2290, 0.6917, 0.0793];

// 基准 headroom = log2(X_GAIN[-1]) (峰值/参考白)
export function baselineHeadroom() {
  return Math.log2(CONFIG.X_GAIN[CONFIG.X_GAIN.length - 1]);
}

// 构造一份 ST 2094-50 metadata JSON
// k: CONFIG.K_NEW 或 CONFIG.K_COUPLED
// includeSaturation: 是否在 alternateImages 里附挂 saturation 曲线 (新法=true)
// baselineHdrHeadroomOverride: 加载图像自带的真实 baseline headroom (如 cow.json 的 2.300448)；
//   未提供时退回 CONFIG 默认值 (log2(X_GAIN[-1]))
export function buildMetadata(k, includeSaturation = true, baselineHdrHeadroomOverride = null) {
  const controlPoints = buildControlPoints(CONFIG.X_GAIN, CONFIG.Y_GAIN);
  const alternate = {
    hdrHeadroom: 0.0,
    colorGainFunction: {
      componentMix: {
        red: k.k_red,
        green: k.k_green,
        blue: k.k_blue,
        max: k.k_max,
        min: k.k_min,
        component: k.k_component,
      },
      gainCurve: { controlPoints },
    },
  };

  // saturation 曲线是本提案相对 ST 2094-50 的扩展字段,
  // 挂在 colorGainFunction 上供 renderer 取用
  if (includeSaturation) {
    alternate.colorGainFunction.saturationCurve = {
      controlPoints: buildControlPoints(CONFIG.X_SAT, CONFIG.S_SAT),
    };
  }

  return {
    hdrReferenceWhite: CONFIG.L_WHITE,
    headroomAdaptiveToneMap: {
      gainApplicationChromaticities: P3_CHROMATICITIES,
      baselineHdrHeadroom: baselineHdrHeadroomOverride ?? baselineHeadroom(),
      alternateImages: [alternate],
    },
  };
}

// 新法 metadata (k_component=0 + saturation)
export function newMethodMetadata(baselineHdrHeadroomOverride = null) {
  return buildMetadata(CONFIG.K_NEW, true, baselineHdrHeadroomOverride);
}

// 耦合法 metadata (k_component=0.35, 无 saturation)
export function coupledMethodMetadata(baselineHdrHeadroomOverride = null) {
  return buildMetadata(CONFIG.K_COUPLED, false, baselineHdrHeadroomOverride);
}
