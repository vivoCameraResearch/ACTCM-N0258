// Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
//  uwa-headroom-adapt.js — Headroom 自适应插值权重
//
//  Clean-room 实现，不含任何第三方源码。算法与本项目 Python 参考实现
//  algorithm/uwa_gaincurve_ccm.py §5 (ToneMapper._weights) 一致，
//  公式依据为公开标准 SMPTE ST 2094-50 §6.2.5（公式 2-5）。
//
//  要点：把"基准图"（零增益，S=1）按其自身 headroom 插入备用图列表并整体排序，
//  然后在目标 headroom 落入的相邻两项之间做线性插值。目标 headroom 超出
//  列表范围时钳位到端点，保证行为单调可预测。
// ============================================================================

const kUwaBaselineIndex = -1;   // 基准图在 alternateImages 中没有对应项

// 返回 [{index, weight}]，index 为 alternateImages 下标，kUwaBaselineIndex 表示基准图。
// 权重之和恒为 1；命中控制点时只返回单项。
const uwaHeadroomAdaptiveWeights = function (headroomAdaptiveToneMap, hTarget) {
  const meta = headroomAdaptiveToneMap;
  const alternates = meta.alternateImages || [];

  // 1) 合并基准图与全部备用图，按 headroom 升序排列
  const entries = alternates.map((a, i) => ({
    headroom: Number(a.hdrHeadroom),
    index: i,
  }));
  entries.push({
    headroom: Number(meta.baselineHdrHeadroom),
    index: kUwaBaselineIndex,
  });
  entries.sort((a, b) => a.headroom - b.headroom);

  const n = entries.length;
  if (n === 1) return [{ index: entries[0].index, weight: 1.0 }];

  // 2) 钳位目标 headroom 到 [H_min, H_max]
  const hMin = entries[0].headroom;
  const hMax = entries[n - 1].headroom;
  const h = Math.min(Math.max(Number(hTarget), hMin), hMax);

  // 3) 命中某个控制点则直接返回该项
  for (let i = 0; i < n; ++i) {
    if (Math.abs(h - entries[i].headroom) < 1e-12) {
      return [{ index: entries[i].index, weight: 1.0 }];
    }
  }

  // 4) 找到 h 落入的区间 [H_i, H_i+1] 并线性插值
  let i = 0;
  while (i < n - 2 && entries[i + 1].headroom < h) ++i;
  const hI = entries[i].headroom;
  const hJ = entries[i + 1].headroom;
  const wI = (h - hJ) / (hI - hJ);

  return [
    { index: entries[i].index, weight: wI },
    { index: entries[i + 1].index, weight: 1.0 - wI },
  ];
};
