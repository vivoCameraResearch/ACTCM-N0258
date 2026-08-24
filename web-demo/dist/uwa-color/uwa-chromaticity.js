// Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
//  uwa-chromaticity.js — 由色度坐标构造 RGB<->XYZ 及跨色域转换矩阵
//
//  Clean-room 实现，不含任何第三方源码。算法与本项目 Python 参考实现
//  algorithm/uwa_gaincurve_ccm.py §2 (primaries_to_xyz) 完全一致：
//    1) 每个原色 (x, y) 的 XYZ 方向向量取 [x/y, 1, (1-x-y)/y]
//    2) 以三原色方向向量为列构成矩阵 M
//    3) 解 M * S = XYZ_white 得各原色缩放系数 S
//    4) RGB(线性) -> XYZ 矩阵 = M * diag(S)
//  色度坐标数值来源：
//    * sRGB / BT.709 : IEC 61966-2-1 / ITU-R BT.709-6
//    * Display-P3    : SMPTE EG 432-1（D65 白点）
//    * BT.2020       : ITU-R BT.2020-2
// ============================================================================

// 色度坐标扁平数组约定：[rx, ry, gx, gy, bx, by, wx, wy]
const uwaColorSpaceChromaticities = function (primaries) {
  if (primaries === kPrimariesSRGB) {
    return [0.640, 0.330, 0.300, 0.600, 0.150, 0.060, 0.3127, 0.3290];
  }
  if (primaries === kPrimariesP3) {
    return [0.680, 0.320, 0.265, 0.690, 0.150, 0.060, 0.3127, 0.3290];
  }
  if (primaries === kPrimariesRec2020) {
    return [0.708, 0.292, 0.170, 0.797, 0.131, 0.046, 0.3127, 0.3290];
  }
  throw new Error('uwaColorSpaceChromaticities: 未知的 colour_primaries 编号 ' + primaries);
};

// 3x3 行主序矩阵求逆（伴随矩阵 / 行列式）
function uwaMat3Inverse(m) {
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const A =  (e * i - f * h), B = -(d * i - f * g), C =  (d * h - e * g);
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('uwaMat3Inverse: 矩阵不可逆');
  const s = 1 / det;
  return [
    [ A * s,               -(b * i - c * h) * s,  (b * f - c * e) * s],
    [ B * s,                (a * i - c * g) * s, -(a * f - c * d) * s],
    [ C * s,               -(a * h - b * g) * s,  (a * e - b * d) * s],
  ];
}

// 3x3 行主序矩阵相乘
function uwaMat3Multiply(x, y) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; ++r)
    for (let c = 0; c < 3; ++c)
      out[r][c] = x[r][0] * y[0][c] + x[r][1] * y[1][c] + x[r][2] * y[2][c];
  return out;
}

// 由色度坐标构造 线性RGB -> XYZ 矩阵（行主序），对应 Python primaries_to_xyz
const uwaRgbToXyzMatrix = function (chromaticities) {
  const xyzOf = (x, y) => [x / y, 1.0, (1.0 - x - y) / y];
  const r = xyzOf(chromaticities[0], chromaticities[1]);
  const g = xyzOf(chromaticities[2], chromaticities[3]);
  const b = xyzOf(chromaticities[4], chromaticities[5]);
  const w = xyzOf(chromaticities[6], chromaticities[7]);

  // M 以三原色为列
  const M = [
    [r[0], g[0], b[0]],
    [r[1], g[1], b[1]],
    [r[2], g[2], b[2]],
  ];

  // 解 M * S = W，得到三原色的缩放系数
  const Minv = uwaMat3Inverse(M);
  const S = [
    Minv[0][0] * w[0] + Minv[0][1] * w[1] + Minv[0][2] * w[2],
    Minv[1][0] * w[0] + Minv[1][1] * w[1] + Minv[1][2] * w[2],
    Minv[2][0] * w[0] + Minv[2][1] * w[1] + Minv[2][2] * w[2],
  ];

  // M * diag(S)：按列缩放
  return [
    [M[0][0] * S[0], M[0][1] * S[1], M[0][2] * S[2]],
    [M[1][0] * S[0], M[1][1] * S[1], M[1][2] * S[2]],
    [M[2][0] * S[0], M[2][1] * S[1], M[2][2] * S[2]],
  ];
};

// 亮度权重 = RGB->XYZ 矩阵的 Y 行（归一化），对应 Python luma_weights()
const uwaLumaWeights = function (chromaticities) {
  const m = uwaRgbToXyzMatrix(chromaticities)[1];
  const sum = m[0] + m[1] + m[2];
  return [m[0] / sum, m[1] / sum, m[2] / sum];
};

// 跨色域转换矩阵，以 WebGL uniformMatrix3fv 所需的列主序扁平数组返回。
// 本项目涉及的 sRGB / Display-P3 / BT.2020 白点同为 D65，故无需色适应变换（CAT）。
const uwaRgbConversionMatrixColMajor = function (srcChromaticities, dstChromaticities) {
  const srcToXyz = uwaRgbToXyzMatrix(srcChromaticities);
  const xyzToDst = uwaMat3Inverse(uwaRgbToXyzMatrix(dstChromaticities));
  const m = uwaMat3Multiply(xyzToDst, srcToXyz);
  // 行主序 -> 列主序
  return [
    m[0][0], m[1][0], m[2][0],
    m[0][1], m[1][1], m[2][1],
    m[0][2], m[1][2], m[2][2],
  ];
};
