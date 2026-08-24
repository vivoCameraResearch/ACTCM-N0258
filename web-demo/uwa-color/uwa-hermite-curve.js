// Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
//  uwa-hermite-curve.js — 分段三次 Hermite 曲线求值（Gain Curve / Saturation Curve 共用）
//
//  Clean-room 实现，不含任何第三方源码。算法与本项目 Python 参考实现
//  algorithm/uwa_gaincurve_ccm.py §3 (class HermiteCurve) 一致，公式依据为公开标准
//  SMPTE ST 2094-50 §6.5 与附录 C.3.9（控制点 + PCHIP 单调保形斜率）。
//
//  三段式定义（对应标准公式 12）：
//    x <= x_first : y = y_first                        （低端水平钳位）
//    控制点区间内 : 分段三次 Hermite 插值
//    x >= x_last  : y = y_last + log2(x / x_last)      （高端 log2 外推，保证单调可预测）
//
//  本方案中 Gain Curve 与 Saturation Curve 是同一模型的两个实例，
//  仅控制点与是否启用高端 log2 外推不同。
// ============================================================================

class UwaHermiteCurve {
  // controlPoints: [{x, y, m}, ...]，按 x 升序；m 缺省时按 PCHIP 规则自动补齐。
  // options.log2Extrapolate: 高端是否使用 log2 外推（亮度曲线为 true）
  constructor(controlPoints, options) {
    const opts = options || {};
    this.log2Extrapolate = opts.log2Extrapolate !== false;
    this.points = (controlPoints || []).map((p) => ({
      x: Number(p.x),
      y: Number(p.y),
      m: (p.m === undefined || p.m === null) ? null : Number(p.m),
    }));
    if (this.points.length === 0) {
      throw new Error('UwaHermiteCurve: 控制点为空');
    }
    if (this.points.some((p) => p.m === null)) {
      const slopes = UwaHermiteCurve.pchipSlopes(
        this.points.map((p) => p.x),
        this.points.map((p) => p.y));
      this.points.forEach((p, i) => { if (p.m === null) p.m = slopes[i]; });
    }
  }

  getControlPoints() {
    return this.points.map((p) => ({ x: p.x, y: p.y, m: p.m }));
  }

  // Fritsch-Butland 单调保形斜率（ST 2094-50 附录 C.3.9 / C.7-C.9）
  static pchipSlopes(xs, ys) {
    const n = xs.length;
    const m = new Array(n).fill(0);
    if (n < 2) return m;

    const h = new Array(n - 1);
    const s = new Array(n - 1);
    for (let i = 0; i < n - 1; ++i) {
      h[i] = xs[i + 1] - xs[i];
      s[i] = (ys[i + 1] - ys[i]) / h[i];
    }
    if (n === 2) { m[0] = s[0]; m[1] = s[0]; return m; }
    return UwaHermiteCurve._pchipFinish(m, h, s, n);
  }

  // 内点加权调和平均 + 端点单侧差分限幅
  static _pchipFinish(m, h, s, n) {
    for (let i = 1; i < n - 1; ++i) {
      const sp = s[i - 1], sc = s[i];
      if (Math.sign(sp) !== Math.sign(sc) || sp === 0 || sc === 0) {
        m[i] = 0.0;
      } else {
        const w = (2 * h[i - 1] + h[i]) * sp + (h[i - 1] + 2 * h[i]) * sc;
        m[i] = (3.0 * (h[i - 1] + h[i]) * sp * sc) / w;
      }
    }

    m[0] = ((2 * h[0] + h[1]) * s[0] - h[0] * s[1]) / (h[0] + h[1]);
    if (Math.sign(m[0]) !== Math.sign(s[0])) {
      m[0] = 0.0;
    } else if (Math.sign(s[0]) !== Math.sign(s[1]) &&
               Math.abs(m[0]) > 3 * Math.abs(s[0])) {
      m[0] = 3 * s[0];
    }

    const k = n - 1;
    m[k] = ((2 * h[k - 1] + h[k - 2]) * s[k - 1] - h[k - 1] * s[k - 2]) /
           (h[k - 1] + h[k - 2]);
    if (Math.sign(m[k]) !== Math.sign(s[k - 1])) {
      m[k] = 0.0;
    } else if (Math.sign(s[k - 1]) !== Math.sign(s[k - 2]) &&
               Math.abs(m[k]) > 3 * Math.abs(s[k - 1])) {
      m[k] = 3 * s[k - 1];
    }
    return m;
  }

  // 求值，返回 {x, y, m}；m 为该处斜率 dy/dx
  evaluate(x) {
    const p = this.points;
    const n = p.length;

    if (x <= p[0].x) return { x: x, y: p[0].y, m: 0 };

    if (x >= p[n - 1].x) {
      const last = p[n - 1];
      const y = this.log2Extrapolate
        ? last.y + Math.log2(Math.max(x, 1e-12) / last.x)
        : last.y;
      return { x: x, y: y, m: 0 };
    }

    for (let i = 0; i < n - 1; ++i) {
      if (x <= p[i + 1].x) {
        const x0 = p[i].x, x1 = p[i + 1].x;
        const y0 = p[i].y, y1 = p[i + 1].y;
        const dx = x1 - x0;
        const t = (x - x0) / dx;
        // 归一化到单位区间后的切线
        const m0 = p[i].m * dx;
        const m1 = p[i + 1].m * dx;
        // 三次 Hermite 基函数展开为多项式系数
        const c3 = 2 * y0 + m0 - 2 * y1 + m1;
        const c2 = -3 * y0 + 3 * y1 - 2 * m0 - m1;
        const c1 = m0;
        const c0 = y0;
        return {
          x: x,
          y: c0 + t * (c1 + t * (c2 + t * c3)),
          m: (c1 + 2 * c2 * t + 3 * c3 * t * t) / dx,
        };
      }
    }
    // 理论不可达
    return { x: x, y: p[n - 1].y, m: 0 };
  }
}
