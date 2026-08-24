// Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
//  uwa-transfer.js — 传递函数（GLSL）与 CICP 编号常量
//
//  Clean-room 实现，不含任何第三方源码。公式来源均为公开标准，并与本项目的
//  Python 参考实现 algorithm/uwa_gaincurve_ccm.py §1 逐项对齐：
//    * PQ    : SMPTE ST 2084:2014 附件 A（常数 m1 / m2 / c1 / c2 / c3）
//    * sRGB  : IEC 61966-2-1:1999
//    * BT.709 / BT.2020 : ITU-R BT.709-6 / BT.2020-2 OETF
//    * HLG   : ITU-R BT.2100-2 表 5
//    * 编号  : ITU-T H.273 (CICP) transfer_characteristics / colour_primaries
// ============================================================================

// ---- transfer_characteristics（ITU-T H.273 表 3）----
const kTransferRec709        = 1;
const kTransferG22           = 4;
const kTransferG28           = 6;
const kTransferSRGB          = 13;
const kTransferRec2020_10bit = 14;
const kTransferRec2020_12bit = 15;
const kTransferPQ            = 16;
const kTransferHLG           = 18;

// ---- colour_primaries（ITU-T H.273 表 2）----
const kPrimariesRec709  = 1;
const kPrimariesSRGB    = 1;
const kPrimariesRec2020 = 9;
const kPrimariesP3      = 12;

// GLSL 片段：供片元着色器 include。约定 transferToLinear 输出为"归一化线性光"，
// 即 PQ 下 1.0 对应 10000 cd/m^2，HLG 下 1.0 对应 1000 cd/m^2 的 OOTF 前信号。
const kUwaTransferGLSL = `
const int kTransferRec709        = 1;
const int kTransferG22           = 4;
const int kTransferG28           = 6;
const int kTransferSRGB          = 13;
const int kTransferRec2020_10bit = 14;
const int kTransferRec2020_12bit = 15;
const int kTransferPQ            = 16;
const int kTransferHLG           = 18;

// ---- PQ 常数（ST 2084 附件 A）----
const float kPqM1 = 2610.0 / 16384.0;
const float kPqM2 = 2523.0 / 4096.0 * 128.0;
const float kPqC1 = 3424.0 / 4096.0;
const float kPqC2 = 2413.0 / 4096.0 * 32.0;
const float kPqC3 = 2392.0 / 4096.0 * 32.0;

// ---- HLG 常数（BT.2100-2 表 5）----
const float kHlgA = 0.17883277;
const float kHlgB = 1.0 - 4.0 * kHlgA;          // = 0.28466892
const float kHlgC = 0.5 - kHlgA * log(4.0 * kHlgA);

// 电光转换：编码码值 -> 归一化线性光
float transferToLinear(float x, int transfer) {
  // 纯幂函数族：BT.709 / BT.2020 的 OETF 逆函数在显示端按 gamma 近似处理
  if (transfer == kTransferRec709 ||
      transfer == kTransferRec2020_10bit ||
      transfer == kTransferRec2020_12bit) {
    return x < 0.081 ? x / 4.5
                     : pow((x + 0.099) / 1.099, 1.0 / 0.45);
  }
  if (transfer == kTransferG22) return pow(x, 2.2);
  if (transfer == kTransferG28) return pow(x, 2.8);
  if (transfer == kTransferSRGB) {
    return x <= 0.04045 ? x / 12.92
                        : pow((x + 0.055) / 1.055, 2.4);
  }
  if (transfer == kTransferPQ) {
    // ST 2084: Y = ( max(E'^(1/m2) - c1, 0) / (c2 - c3 * E'^(1/m2)) )^(1/m1)
    float e = pow(max(x, 0.0), 1.0 / kPqM2);
    float num = max(e - kPqC1, 0.0);
    float den = max(kPqC2 - kPqC3 * e, 1e-9);
    return pow(num / den, 1.0 / kPqM1);
  }
  if (transfer == kTransferHLG) {
    // BT.2100 HLG 逆 OETF（场景光域，归一化到 [0,1]）
    return x <= 0.5 ? (x * x) / 3.0
                    : (exp((x - kHlgC) / kHlgA) + kHlgB) / 12.0;
  }
  return x;
}

// 光电转换：归一化线性光 -> 编码码值
float transferFromLinear(float x, int transfer) {
  if (transfer == kTransferRec709 ||
      transfer == kTransferRec2020_10bit ||
      transfer == kTransferRec2020_12bit) {
    return x < 0.018 ? 4.5 * x
                     : 1.099 * pow(x, 0.45) - 0.099;
  }
  if (transfer == kTransferG22) return pow(x, 1.0 / 2.2);
  if (transfer == kTransferG28) return pow(x, 1.0 / 2.8);
  if (transfer == kTransferSRGB) {
    return x <= 0.0031308 ? x * 12.92
                          : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
  }
  if (transfer == kTransferPQ) {
    // ST 2084: E' = ( (c1 + c2 * Y^m1) / (1 + c3 * Y^m1) )^m2
    float y = pow(max(x, 0.0), kPqM1);
    return pow((kPqC1 + kPqC2 * y) / (1.0 + kPqC3 * y), kPqM2);
  }
  if (transfer == kTransferHLG) {
    return x <= 1.0 / 12.0 ? sqrt(3.0 * x)
                           : kHlgA * log(12.0 * x - kHlgB) + kHlgC;
  }
  return x;
}
`;
