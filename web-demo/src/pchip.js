// Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
// SPDX-License-Identifier: Apache-2.0

// PCHIP 斜率计算 — Fritsch-Butland 单调保形斜率
// 移植自 uwa_gaincurve_ccm.py HermiteCurve._pchip_slopes (2094-50 附录 C.7-C.9)
// 输入: xs, ys (等长数组, xs 非降序)
// 输出: slopes 数组 (与 xs 等长)

export function pchipSlopes(xs, ys) {
  const x = xs.map(Number);
  const y = ys.map(Number);
  const n = x.length;
  const m = new Array(n).fill(0);
  if (n === 1) return m;

  const h = new Array(n - 1);
  const s = new Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    h[i] = x[i + 1] - x[i];
    s[i] = (y[i + 1] - y[i]) / h[i];
  }

  if (n === 2) {
    m[0] = s[0];
    m[1] = s[0];
    return m;
  }

  // 内点
  for (let i = 1; i < n - 1; i += 1) {
    const sPrev = s[i - 1];
    const sCurr = s[i];
    if (Math.sign(sPrev) !== Math.sign(sCurr) || sPrev === 0 || sCurr === 0) {
      m[i] = 0.0;
    } else {
      const w = (2 * h[i - 1] + h[i]) * sPrev + (h[i - 1] + 2 * h[i]) * sCurr;
      m[i] = (3.0 * (h[i - 1] + h[i]) * sPrev * sCurr) / w;
    }
  }

  // 端点 (非中心差分, 与 C.3.9 一致)
  m[0] = ((2 * h[0] + h[1]) * s[0] - h[0] * s[1]) / (h[0] + h[1]);
  if (Math.sign(m[0]) !== Math.sign(s[0])) {
    m[0] = 0.0;
  } else if (Math.sign(s[0]) !== Math.sign(s[1]) && Math.abs(m[0]) > 3 * Math.abs(s[0])) {
    m[0] = 3 * s[0];
  }

  const last = n - 1;
  m[last] = ((2 * h[last - 1] + h[last - 2]) * s[last - 1] - h[last - 1] * s[last - 2]) / (h[last - 1] + h[last - 2]);
  if (Math.sign(m[last]) !== Math.sign(s[last - 1])) {
    m[last] = 0.0;
  } else if (Math.sign(s[last - 1]) !== Math.sign(s[last - 2]) && Math.abs(m[last]) > 3 * Math.abs(s[last - 1])) {
    m[last] = 3 * s[last - 1];
  }

  return m;
}

// 把 (xs, ys) 组装成 ST 2094-50 元数据所需的 controlPoints [{x,y,m}, ...]
export function buildControlPoints(xs, ys) {
  const slopes = pchipSlopes(xs, ys);
  return xs.map((x, i) => ({ x: Number(x), y: Number(ys[i]), m: slopes[i] }));
}
