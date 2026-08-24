#!/usr/bin/env python3
# Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
# SPDX-License-Identifier: Apache-2.0
# -*- coding: utf-8 -*-
"""
UWA 轻量化动态元数据（Gain Curve + CCM）方案实现
对应提案 N0258，参考 SMPTE ST 2094-50:2016。

核心思想（与 2094-50 的区别）：
  * 亮度压缩：复用 2094-50 的 Gain Curve（分段三次 Hermite），令 k_component = 0
    -> RGB 获得同一标量增益，等比缩放，无偏色、无亮度漂移。
  * 高光退白：解耦出来，用一条独立的"饱和度曲线"（复用同一 Hermite 模型），
    在感知域(PQ)朝等亮度灰收敛，从数学底层消除偏色。

本脚本同时实现原版 2094-50 的"耦合退白"(k_component != 0) 作为对照，
量化演示附录 A.1 描述的色相偏移问题。

所有曲线控制点见文件顶部 `CONFIG`，可直接编辑后重跑。
"""

import os
import subprocess
import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(BASE_DIR)
OUT_DIR = os.path.join(BASE_DIR, "output")
PNG16_PATH = os.path.join(OUT_DIR, "test_16bit.png")

# 测试素材与 web-demo 共用同一份，避免仓库内重复存放 16MB 图像。
# 也可通过环境变量 UWA_TEST_AVIF 指定任意 HDR AVIF 输入。
AVIF_PATH = os.environ.get(
    "UWA_TEST_AVIF",
    os.path.join(REPO_DIR, "web-demo", "data", "test.avif"),
)

# =============================================================================
#  CONFIG —— 可编辑参数区（曲线控制点均在此处，方便后续调整）
# =============================================================================
class CONFIG:
    # ---- HDR 参考白 & Headroom ----
    L_WHITE = 203.0          # HDR reference white (cd/m^2), BT.2408
    # 基准图 Headroom = log2(内容峰值 / 参考白)；由末控制点 X_GAIN[-1] 推得，见下
    H_TARGET = 0.0           # 目标 headroom：0 = SDR(峰值=参考白)；可设 1.0 得低亮度HDR

    # ---- 步骤一：亮度 Gain Curve（SDR 备用图, H_alt = 0）----
    # x = f_common(相对亮度, 1.0=参考白)，y = log2 增益。斜率 m 由 PCHIP(C.3.9) 自动计算。
    X_GAIN = [0.00, 0.50, 1.00, 1.75, 3.00, 4.50, 6.55]
    Y_GAIN = [0.00, 0.00, -0.152, -0.866, -1.60, -2.174, -2.711]

    # ---- 步骤二：饱和度 Saturation Curve（SDR 备用图, H_alt = 0）----
    # x = f_common(相对亮度)，S = 饱和度系数 ∈ [0,5]（本例用 [0.35,1.0]）。基准图 S≡1。
    X_SAT = [0.00, 0.30, 1.00, 2.89, 4.79, 7.40]
    S_SAT = [1.00, 1.00, 1.00, 0.95, 0.86, 0.63]

    # ---- Component Mixing 权重（2094-50 §6.4，sum=1）----
    # 新方案：k_component = 0（解耦）；用 max 通道作为亮度自变量 f_common。
    K_NEW = dict(k_red=0.0, k_green=0.0, k_blue=0.0, k_max=1.0, k_min=0.0, k_component=0.0)
    # 对照：原版 2094-50 耦合退白，k_component != 0 -> 三通道增益不同 -> 偏色。
    K_COUPLED = dict(k_red=0.0, k_green=0.0, k_blue=0.0, k_max=0.65, k_min=0.0, k_component=0.35)

    # ---- 感知编码 f_perception：'pq' / 'gamma' / 'log2' ----
    PERCEPTION = "pq"

    # ---- W_full 亮度权重：'p3'(精确, 默认) 或 'rec709'(提案示例) ----
    LUMA_WEIGHTS = "p3"

    # ---- 输出预览缩放（长边像素）；None = 原分辨率 ----
    PREVIEW_MAX_SIDE = 2040


# =============================================================================
#  1. PQ 传递函数 (SMPTE ST 2084 / BT.2100)
# =============================================================================
_PQ_m1 = 2610.0 / 16384.0
_PQ_m2 = 2523.0 / 4096.0 * 128.0
_PQ_c1 = 3424.0 / 4096.0
_PQ_c2 = 2413.0 / 4096.0 * 32.0
_PQ_c3 = 2392.0 / 4096.0 * 32.0


def pq_eotf(E):
    """PQ 码值[0,1] -> 绝对亮度 cd/m^2 (峰值 10000)。"""
    E = np.clip(E, 0.0, 1.0)
    Ep = np.power(E, 1.0 / _PQ_m2)
    num = np.maximum(Ep - _PQ_c1, 0.0)
    den = _PQ_c2 - _PQ_c3 * Ep
    return 10000.0 * np.power(num / den, 1.0 / _PQ_m1)


def pq_oetf(L):
    """绝对亮度 cd/m^2 -> PQ 码值[0,1]。"""
    Ln = np.clip(L, 0.0, 10000.0) / 10000.0
    Lm = np.power(Ln, _PQ_m1)
    return np.power((_PQ_c1 + _PQ_c2 * Lm) / (1.0 + _PQ_c3 * Lm), _PQ_m2)


# =============================================================================
#  2. 色彩原色矩阵 (Display-P3 D65) 与亮度权重
# =============================================================================
def primaries_to_xyz(rxy, gxy, bxy, wxy):
    """由原色/白点色度坐标构造 RGB(线性)->XYZ 矩阵。"""
    def xyz(xy):
        x, y = xy
        return np.array([x / y, 1.0, (1.0 - x - y) / y])
    Xr, Xg, Xb = xyz(rxy), xyz(gxy), xyz(bxy)
    M = np.stack([Xr, Xg, Xb], axis=1)
    Wn = xyz(wxy)
    S = np.linalg.solve(M, Wn)
    return M * S


# Display-P3 (SMPTE EG 432-1, D65)
P3_R, P3_G, P3_B = (0.680, 0.320), (0.265, 0.690), (0.150, 0.060)
D65 = (0.3127, 0.3290)
M_P3_XYZ = primaries_to_xyz(P3_R, P3_G, P3_B, D65)


def luma_weights():
    if CONFIG.LUMA_WEIGHTS == "rec709":
        return np.array([0.2126, 0.7152, 0.0722])
    w = M_P3_XYZ[1, :].copy()   # XYZ 的 Y 行即亮度权重
    return w / w.sum()


# =============================================================================
#  3. GainCurve —— 分段三次 Hermite + PCHIP 斜率 (2094-50 §6.5 / C.3.9)
# =============================================================================
class HermiteCurve:
    """
    复用 2094-50 GainCurve 模型（公式 11、12）。
    亮度曲线 y = log2 增益；饱和度曲线 y = 饱和度系数。
    斜率 m 若未给，按附录 C.3.9(PCHIP) 计算。
    """

    def __init__(self, xs, ys, slopes=None):
        self.x = np.asarray(xs, dtype=np.float64)
        self.y = np.asarray(ys, dtype=np.float64)
        assert np.all(np.diff(self.x) >= 0), "x 必须非降序"
        self.m = np.asarray(slopes, dtype=np.float64) if slopes is not None \
            else self._pchip_slopes(self.x, self.y)

    @staticmethod
    def _pchip_slopes(x, y):
        """2094-50 附录 C.3.9 (公式 C.7-C.9)，Fritsch-Butland 单调保形斜率。"""
        n = len(x)
        h = np.diff(x)
        s = np.diff(y) / h
        m = np.zeros(n)
        if n == 1:
            return m
        if n == 2:
            m[:] = s[0]
            return m
        # 内点
        for i in range(1, n - 1):
            if np.sign(s[i - 1]) != np.sign(s[i]) or s[i - 1] == 0 or s[i] == 0:
                m[i] = 0.0
            else:
                w = (2 * h[i - 1] + h[i]) * s[i - 1] + (h[i - 1] + 2 * h[i]) * s[i]
                m[i] = 3.0 * (h[i - 1] + h[i]) * s[i - 1] * s[i] / w
        # 端点（非中心差分，与 C.3.9 一致）
        m[0] = ((2 * h[0] + h[1]) * s[0] - h[0] * s[1]) / (h[0] + h[1])
        if np.sign(m[0]) != np.sign(s[0]):
            m[0] = 0.0
        elif np.sign(s[0]) != np.sign(s[1]) and abs(m[0]) > 3 * abs(s[0]):
            m[0] = 3 * s[0]
        m[-1] = ((2 * h[-1] + h[-2]) * s[-1] - h[-1] * s[-2]) / (h[-1] + h[-2])
        if np.sign(m[-1]) != np.sign(s[-1]):
            m[-1] = 0.0
        elif np.sign(s[-1]) != np.sign(s[-2]) and abs(m[-1]) > 3 * abs(s[-1]):
            m[-1] = 3 * s[-1]
        return m

    def evaluate(self, x, log2_extrapolate=True):
        """公式 (12)。log2_extrapolate=True 用于亮度曲线的末段对数外推。"""
        x = np.asarray(x, dtype=np.float64)
        out = np.empty_like(x)
        xk, yk, mk = self.x, self.y, self.m
        idx = np.searchsorted(xk, x, side="right") - 1
        idx = np.clip(idx, 0, len(xk) - 2)
        # 分段 Hermite
        x0 = xk[idx]; x1 = xk[idx + 1]
        y0 = yk[idx]; y1 = yk[idx + 1]
        m0 = mk[idx]; m1 = mk[idx + 1]
        dx = (x1 - x0)
        dx_safe = np.where(dx == 0, 1.0, dx)
        t = (x - x0) / dx_safe
        mh0 = dx * m0; mh1 = dx * m1
        c3 = 2 * y0 + mh0 - 2 * y1 + mh1
        c2 = -3 * y0 + 3 * y1 - 2 * mh0 - mh1
        c1 = mh0; c0 = y0
        out = ((c3 * t + c2) * t + c1) * t + c0
        # 边界
        below = x < xk[0]
        out[below] = yk[0]
        above = x >= xk[-1]
        if log2_extrapolate:
            out[above] = yk[-1] + np.log2(np.maximum(x[above], 1e-12) / xk[-1])
        else:
            out[above] = yk[-1]
        return out


# =============================================================================
#  4. Component Mixing (2094-50 §6.4, 公式 9/10)
# =============================================================================
def f_common(C, k):
    cr, cg, cb = C[..., 0], C[..., 1], C[..., 2]
    cmax = np.max(C, axis=-1)
    cmin = np.min(C, axis=-1)
    return (cr * k["k_red"] + cg * k["k_green"] + cb * k["k_blue"]
            + cmax * k["k_max"] + cmin * k["k_min"])


def component_mixing(C, k):
    fc = f_common(C, k)
    M = C * k["k_component"] + fc[..., None]
    return M, fc


# =============================================================================
#  5. Headroom 自适应 ToneMap (2094-50 §6.2.5, 公式 2-5)
# =============================================================================
class ToneMapper:
    """
    统一的 headroom 自适应色调映射器。
    alternates: list of dict(H, gain_curve, sat_curve, k)   —— 备用图
    baseline_H: 基准图 headroom（零增益 / S=1）
    """

    def __init__(self, alternates, baseline_H):
        entries = []
        for a in alternates:
            entries.append(dict(H=a["H"], gain=a["gain_curve"],
                                 sat=a.get("sat_curve"), k=a["k"], zero=False))
        entries.append(dict(H=baseline_H, gain=None, sat=None, k=None, zero=True))
        entries.sort(key=lambda e: e["H"])
        self.entries = entries
        self.H = np.array([e["H"] for e in entries])

    def _weights(self, H_target):
        Hc = float(np.clip(H_target, self.H[0], self.H[-1]))
        # 命中控制点
        for i, h in enumerate(self.H):
            if abs(Hc - h) < 1e-12:
                return [(i, 1.0)]
        i = int(np.searchsorted(self.H, Hc) - 1)
        i = max(0, min(i, len(self.H) - 2))
        Hi, Hi1 = self.H[i], self.H[i + 1]
        wi = (Hc - Hi1) / (Hi - Hi1)
        return [(i, wi), (i + 1, 1.0 - wi)]

    def _gain_of(self, entry, C):
        """颜色增益函数 Gain(C) (公式 6/7)。返回逐通道 log2 增益。"""
        if entry["zero"]:
            return np.zeros_like(C)
        M, _ = component_mixing(C, entry["k"])
        g = entry["gain"].evaluate(M)   # 逐通道分别过曲线
        return g

    def _sat_of(self, entry, fc):
        if entry["zero"] or entry["sat"] is None:
            return np.ones_like(fc)
        return entry["sat"].evaluate(fc, log2_extrapolate=True)

    def tone_map(self, C, H_target):
        """步骤一：C_output = C * 2^G （逐通道，供耦合法/通用用）。"""
        w = self._weights(H_target)
        G = np.zeros_like(C)
        for i, wi in w:
            G += wi * self._gain_of(self.entries[i], C)
        return C * np.power(2.0, G)

    def total_saturation(self, C, H_target, k_for_fc):
        """步骤二：插值得到 S_total（用统一 f_common 作为自变量）。"""
        fc = f_common(C, k_for_fc)
        w = self._weights(H_target)
        S = np.zeros_like(fc)
        for i, wi in w:
            S += wi * self._sat_of(self.entries[i], fc)
        return S


# =============================================================================
#  6. 感知编码 f_perception 及退白
# =============================================================================
def f_perception(C_rel):
    if CONFIG.PERCEPTION == "pq":
        return pq_oetf(C_rel * CONFIG.L_WHITE)
    if CONFIG.PERCEPTION == "gamma":
        return np.power(np.clip(C_rel, 0, None), 1.0 / 2.4)
    if CONFIG.PERCEPTION == "log2":
        return np.log2(np.clip(C_rel, 1e-6, None))
    if CONFIG.PERCEPTION == "linear":     # 恒等：退白严格保亮度(等亮度灰线性混合)
        return C_rel
    raise ValueError(CONFIG.PERCEPTION)


def f_perception_inv(P):
    if CONFIG.PERCEPTION == "pq":
        return pq_eotf(P) / CONFIG.L_WHITE
    if CONFIG.PERCEPTION == "gamma":
        return np.power(np.clip(P, 0, None), 2.4)
    if CONFIG.PERCEPTION == "log2":
        return np.power(2.0, P)
    if CONFIG.PERCEPTION == "linear":
        return P
    raise ValueError(CONFIG.PERCEPTION)


def apply_saturation(C_output, S_total, W):
    """提案步骤二核心：感知域朝等亮度灰混合。"""
    Y = (C_output * W[None, None, :]).sum(axis=-1, keepdims=True)  # W_full·C = [Y,Y,Y]
    grey = np.repeat(Y, 3, axis=-1)
    P = S_total[..., None] * f_perception(C_output) + \
        (1.0 - S_total[..., None]) * f_perception(grey)
    return f_perception_inv(P)


# =============================================================================
#  7. 完整管线
# =============================================================================
def build_tonemapper():
    gain = HermiteCurve(CONFIG.X_GAIN, CONFIG.Y_GAIN)
    sat = HermiteCurve(CONFIG.X_SAT, CONFIG.S_SAT)
    H_baseline = float(np.log2(CONFIG.X_GAIN[-1]))
    tm = ToneMapper(
        alternates=[dict(H=0.0, gain_curve=gain, sat_curve=sat, k=CONFIG.K_NEW)],
        baseline_H=H_baseline,
    )
    return tm, gain, sat, H_baseline


def pipeline_new(C, tm):
    """本方案：Tone Mapping(k_component=0) + 饱和度曲线感知域退白。"""
    C_out = tm.tone_map(C, CONFIG.H_TARGET)                 # 步骤一（等比缩放）
    S = tm.total_saturation(C, CONFIG.H_TARGET, CONFIG.K_NEW)  # 步骤二 S_total
    C_tgt = apply_saturation(C_out, S, luma_weights())
    return C_tgt, S


def pipeline_coupled(C, gain, H_baseline):
    """对照：原版 2094-50 耦合退白（k_component!=0），逐通道不同增益。"""
    tm = ToneMapper(
        alternates=[dict(H=0.0, gain_curve=gain, sat_curve=None, k=CONFIG.K_COUPLED)],
        baseline_H=H_baseline,
    )
    return tm.tone_map(C, CONFIG.H_TARGET)


# =============================================================================
#  8. I/O
# =============================================================================
def ensure_decoded():
    if not os.path.exists(PNG16_PATH):
        if not os.path.exists(AVIF_PATH):
            raise SystemExit(
                "找不到输入 AVIF: %s\n"
                "请确认 web-demo/data/test.avif 存在，"
                "或用环境变量 UWA_TEST_AVIF 指定输入文件。" % AVIF_PATH)
        os.makedirs(OUT_DIR, exist_ok=True)
        try:
            subprocess.run(["avifdec", "--depth", "16", "--png-compress", "1",
                            AVIF_PATH, PNG16_PATH], check=True)
        except FileNotFoundError:
            raise SystemExit(
                "未找到命令行工具 avifdec（libavif），无法解码 AVIF 输入。\n"
                "  macOS : brew install libavif\n"
                "  Ubuntu: sudo apt install libavif-bin\n"
                "  Windows / 其他: 见 https://github.com/AOMediaCodec/libavif\n"
                "安装后确保 avifdec 位于 PATH 中，再重新运行本脚本。")
    import cv2
    bgr = cv2.imread(PNG16_PATH, cv2.IMREAD_UNCHANGED)
    if bgr is None or bgr.dtype != np.uint16:
        raise RuntimeError("需要 16bit PNG，读取失败")
    rgb = bgr[..., ::-1].astype(np.float64) / 65535.0   # PQ 码值 [0,1]
    return rgb


def to_gain_application_space(E_pq):
    """AVIF PQ 码值 -> 增益应用色彩空间（相对线性, 1.0=参考白）。"""
    L = pq_eotf(E_pq)                    # 绝对亮度 cd/m^2
    return L / CONFIG.L_WHITE            # M_input,gain = I (保持 P3 原色)


def linear_p3_to_srgb_encoded(C_rel, peak_rel):
    """相对线性(P3) -> 显示编码(sRGB gamma) 8bit，用于预览。"""
    x = np.clip(C_rel / peak_rel, 0.0, 1.0)   # 归一到目标峰值
    a = 0.055
    srgb = np.where(x <= 0.0031308, 12.92 * x, (1 + a) * np.power(x, 1 / 2.4) - a)
    return np.clip(srgb * 255.0 + 0.5, 0, 255).astype(np.uint8)


def save_png(rgb8, path):
    import cv2
    cv2.imwrite(path, rgb8[..., ::-1])


def downscale(C, max_side):
    if max_side is None:
        return C
    import cv2
    h, w = C.shape[:2]
    s = max_side / max(h, w)
    if s >= 1.0:
        return C
    return cv2.resize(C, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)


# =============================================================================
#  9. 可视化：曲线 + 控制点
# =============================================================================
def plot_curves(gain, sat, H_baseline):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    xs = np.linspace(0, CONFIG.X_GAIN[-1] * 1.05, 600)
    fig, ax = plt.subplots(1, 3, figsize=(16, 4.6))

    # (a) log2 增益曲线
    ax[0].plot(xs, gain.evaluate(xs), lw=2, color="#1f77b4", label="GainCurve  (log2 gain)")
    ax[0].scatter(gain.x, gain.y, color="#d62728", zorder=5, label="control points")
    for x, y in zip(gain.x, gain.y):
        ax[0].annotate(f"({x:g}, {y:g})", (x, y), fontsize=7,
                       xytext=(3, 4), textcoords="offset points")
    ax[0].axhline(0, color="gray", lw=.6); ax[0].axvline(1.0, color="green", ls="--", lw=.8)
    ax[0].set_title("(a) Gain Curve  (k_component=0, log2 gain)")
    ax[0].set_xlabel("x = f_common (relative luma, 1.0=ref white)")
    ax[0].set_ylabel("log2 gain"); ax[0].legend(fontsize=8); ax[0].grid(alpha=.3)

    # (b) 等效输入->输出映射（相对线性）
    out = xs * np.power(2.0, gain.evaluate(xs))
    ax[1].plot(xs, out, lw=2, color="#1f77b4")
    ax[1].plot(xs, np.minimum(xs, 1.0), ls=":", color="gray", label="clip@1.0")
    ax[1].axhline(1.0, color="green", ls="--", lw=.8, label="SDR peak (=ref white)")
    ax[1].set_title("(b) Tone mapping curve  (out = x·2^gain)")
    ax[1].set_xlabel("input relative luma"); ax[1].set_ylabel("output relative luma")
    ax[1].legend(fontsize=8); ax[1].grid(alpha=.3)

    # (c) 饱和度曲线
    xs2 = np.linspace(0, CONFIG.X_SAT[-1] * 1.05, 600)
    ax[2].plot(xs2, sat.evaluate(xs2, log2_extrapolate=True), lw=2, color="#9467bd",
               label="SaturationCurve  S(x)")
    ax[2].scatter(sat.x, sat.y, color="#d62728", zorder=5, label="control points")
    for x, y in zip(sat.x, sat.y):
        ax[2].annotate(f"({x:g}, {y:g})", (x, y), fontsize=7,
                       xytext=(3, 4), textcoords="offset points")
    ax[2].axvline(1.0, color="green", ls="--", lw=.8)
    ax[2].set_title("(c) Saturation Curve  (path-to-white)")
    ax[2].set_xlabel("x = f_common (relative luma)"); ax[2].set_ylabel("S (saturation coef)")
    ax[2].legend(fontsize=8); ax[2].grid(alpha=.3)

    fig.suptitle(f"UWA Gain Curve + CCM  |  L_white={CONFIG.L_WHITE:g} cd/m²  "
                 f"H_baseline={H_baseline:.2f}  H_target={CONFIG.H_TARGET:g}", fontsize=11)
    fig.tight_layout(rect=[0, 0, 1, 0.96])
    fig.savefig(os.path.join(OUT_DIR, "curves_gain_saturation.png"), dpi=110)
    plt.close(fig)


# =============================================================================
#  10. 色相偏移度量 (CIELAB) + 合成测试
# =============================================================================
def linear_p3_to_lab(C):
    XYZ = C @ M_P3_XYZ.T
    Xn, Yn, Zn = M_P3_XYZ @ np.array([1.0, 1.0, 1.0])  # 白点(相对，白=1)
    xr = XYZ[..., 0] / Xn; yr = XYZ[..., 1] / Yn; zr = XYZ[..., 2] / Zn

    def f(t):
        d = 6.0 / 29.0
        return np.where(t > d ** 3, np.cbrt(t), t / (3 * d * d) + 4.0 / 29.0)
    fx, fy, fz = f(xr), f(yr), f(zr)
    L = 116 * fy - 16
    a = 500 * (fx - fy)
    b = 200 * (fy - fz)
    return L, a, b


def hue_angle_deg(C):
    _, a, b = linear_p3_to_lab(C)
    return np.degrees(np.arctan2(b, a))


def hue_diff(h1, h2):
    d = (h1 - h2 + 180.0) % 360.0 - 180.0
    return np.abs(d)


TEST_COLORS = {
    "red":     np.array([1.00, 0.14, 0.11]),
    "orange":  np.array([1.00, 0.50, 0.08]),
    "green":   np.array([0.20, 1.00, 0.20]),
    "blue":    np.array([0.15, 0.20, 1.00]),
}


def _coupled_tm(gain, H_baseline, kc):
    """构造一个给定 k_component 的耦合 ToneMapper（k_max = 1-kc）。"""
    return ToneMapper([dict(H=0.0, gain_curve=gain, sat_curve=None,
                            k=dict(k_red=0, k_green=0, k_blue=0,
                                   k_max=1.0 - kc, k_min=0, k_component=kc))],
                      H_baseline)


def _lab_ch(C):
    """返回 (chroma_ab, hue_deg)。"""
    _, a, b = linear_p3_to_lab(C.reshape(1, 1, 3))
    a = float(a[0, 0]); b = float(b[0, 0])
    return np.hypot(a, b), np.degrees(np.arctan2(b, a))


def synthetic_swatch(tm, gain, H_baseline):
    """可视化：输入 / 新方案 / 2094-50耦合 的高饱和亮度梯度条。"""
    peak = CONFIG.X_GAIN[-1]
    ramp = np.linspace(0.2, peak, 640)
    H = 46
    rows = []
    for name, base in TEST_COLORS.items():
        base = base / base.max()
        strip = ramp[None, :, None] * base[None, None, :]
        C_new, _ = pipeline_new(strip, tm)
        C_cpl = pipeline_coupled(strip, gain, H_baseline)
        peak_rel = 2.0 ** CONFIG.H_TARGET if CONFIG.H_TARGET > 0 else 1.0
        a = np.repeat(linear_p3_to_srgb_encoded(strip, peak), H // 2, axis=0)
        b = np.repeat(linear_p3_to_srgb_encoded(C_new, peak_rel), H // 2, axis=0)
        c = np.repeat(linear_p3_to_srgb_encoded(C_cpl, peak_rel), H // 2, axis=0)
        rows += [a, b, c, np.full((6, a.shape[1], 3), 255, np.uint8)]
    save_png(np.concatenate(rows, axis=0),
             os.path.join(OUT_DIR, "synthetic_swatch.png"))


def matched_chroma_hue_experiment(tm, gain, H_baseline):
    """公平对比：在【相同 CIELAB 彩度衰减量】下比较两法的色相偏移。
    新方案扫描 S∈[1,0]；耦合法扫描 k_component∈[0,1)。"""
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    W = luma_weights()
    x_bright = 4.0                                   # 深高光处的相对亮度
    fig, axes = plt.subplots(1, len(TEST_COLORS), figsize=(4.4 * len(TEST_COLORS), 4), sharey=True)
    summary = []
    for ax, (name, base) in zip(axes, TEST_COLORS.items()):
        base = base / base.max()
        C_in = (x_bright * base).reshape(1, 1, 3)
        _, h0 = _lab_ch(C_in.reshape(3))             # 参考色相 = 输入色相
        C_tm = tm.tone_map(C_in, 0.0).reshape(3)     # 标量色调映射后
        c_tm, _ = _lab_ch(C_tm)

        # 新方案：扫描饱和度系数 S
        red_n, hue_n = [], []
        for S in np.linspace(1.0, 0.0, 41):
            Co = apply_saturation(C_tm.reshape(1, 1, 3), np.array([[S]]), W).reshape(3)
            c, h = _lab_ch(Co)
            red_n.append(100 * (1 - c / c_tm)); hue_n.append(float(hue_diff(h, h0)))
        # 耦合法：扫描 k_component
        red_c, hue_c = [], []
        for kc in np.linspace(0.0, 0.95, 41):
            Co = _coupled_tm(gain, H_baseline, kc).tone_map(C_in, 0.0).reshape(3)
            c, h = _lab_ch(Co)
            red_c.append(100 * (1 - c / c_tm)); hue_c.append(float(hue_diff(h, h0)))

        ax.plot(red_n, hue_n, "-o", ms=3, color="#2ca02c", label="new (decoupled sat-curve)")
        ax.plot(red_c, hue_c, "-s", ms=3, color="#d62728", label="2094-50 coupled (k_component)")
        ax.set_title(name); ax.set_xlabel("chroma reduction  C_ab  (%)")
        ax.grid(alpha=.3); ax.set_xlim(0, 80)
        # 汇总：插值到 40% 彩度衰减处的色相偏移
        hn = float(np.interp(40, red_n, hue_n))
        hc = float(np.interp(40, red_c, hue_c))
        summary.append((name, hn, hc))
    axes[0].set_ylabel("hue shift  ΔH°  (CIELAB, vs original)")
    axes[0].legend(fontsize=8, loc="upper left")
    fig.suptitle("Fair comparison: hue shift at MATCHED chroma reduction (lower = better)")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, "hue_shift_matched_chroma.png"), dpi=110)
    plt.close(fig)
    return summary


def luminance_error_experiment(tm, gain, H_baseline):
    """核心指标（亮度漂移）：|Y_out / Y_intended - 1|。
    Y_intended = Y_in · 2^GainCurve(f_common)（标量增益的目标亮度）。"""
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    W = luma_weights()
    Yf = lambda C: float((C.reshape(3) * W).sum())
    xs = [1.5, 2.5, 4.0, 6.0]
    table = {}
    # 记录新方案 linear-blend 变体（严格保亮度）——临时切换 PERCEPTION
    for name, base in TEST_COLORS.items():
        base = base / base.max()
        rows = []
        for x in xs:
            C = (x * base).reshape(1, 1, 3)
            fc = f_common(C, CONFIG.K_NEW)
            G = float(np.ravel(gain.evaluate(fc))[0])
            Y_int = Yf(C) * (2.0 ** G)
            C1 = tm.tone_map(C, 0.0)                                   # 新-步骤一
            S = tm.total_saturation(C, 0.0, CONFIG.K_NEW)
            saved = CONFIG.PERCEPTION
            C_pq = apply_saturation(C1, S, W)                          # 新-完整(当前感知域)
            CONFIG.PERCEPTION = "linear"
            C_lin = apply_saturation(C1, S, W)                         # 新-完整(线性混合)
            CONFIG.PERCEPTION = saved
            C_c = pipeline_coupled(C, gain, H_baseline)               # 耦合
            rows.append((x,
                         abs(Yf(C1) / Y_int - 1) * 100,
                         abs(Yf(C_pq) / Y_int - 1) * 100,
                         abs(Yf(C_lin) / Y_int - 1) * 100,
                         abs(Yf(C_c) / Y_int - 1) * 100))
        table[name] = rows

    # 柱状图：取各色在 x=4.0 的亮度误差
    fig, ax = plt.subplots(figsize=(8.5, 4.2))
    names = list(table.keys()); xi = np.arange(len(names)); w = 0.2
    pick = lambda idx: [table[n][2][idx] for n in names]   # x=4.0 -> index 2 in xs
    ax.bar(xi - 1.5 * w, pick(1), w, label="new: step-1 tone map", color="#1f77b4")
    ax.bar(xi - 0.5 * w, pick(2), w, label=f"new: full ({CONFIG.PERCEPTION} blend)", color="#2ca02c")
    ax.bar(xi + 0.5 * w, pick(3), w, label="new: full (linear blend)", color="#98df8a")
    ax.bar(xi + 1.5 * w, pick(4), w, label="2094-50 coupled", color="#d62728")
    ax.set_xticks(xi); ax.set_xticklabels(names)
    ax.set_ylabel("luminance error  |Y_out/Y_intended − 1|  (%)")
    ax.set_title("Luminance drift @ relative brightness x=4.0 (lower = better)")
    ax.legend(fontsize=8); ax.grid(alpha=.3, axis="y")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, "luminance_error.png"), dpi=110)
    plt.close(fig)
    return table


def highlight_crop_compare(C_new, C_cpl, C_input):
    """在原图找最亮/最饱和区域裁剪对照。"""
    peak_rel = 2.0 ** CONFIG.H_TARGET if CONFIG.H_TARGET > 0 else 1.0
    a = linear_p3_to_srgb_encoded(C_input, 2.0 ** float(np.log2(CONFIG.X_GAIN[-1])))
    b = linear_p3_to_srgb_encoded(C_new, peak_rel)
    c = linear_p3_to_srgb_encoded(C_cpl, peak_rel)
    # 找高光块
    Y = (C_input * luma_weights()[None, None, :]).sum(-1)
    hh, ww = Y.shape
    cs = 360
    best, bi, bj = -1, 0, 0
    step = 80
    for i in range(0, hh - cs, step):
        for j in range(0, ww - cs, step):
            v = Y[i:i + cs, j:j + cs].mean()
            if v > best:
                best, bi, bj = v, i, j
    def crop(x): return x[bi:bi + cs, bj:bj + cs]
    gap = np.full((cs, 12, 3), 255, np.uint8)
    combo = np.concatenate([crop(a), gap, crop(b), gap, crop(c)], axis=1)
    save_png(combo, os.path.join(OUT_DIR, "compare_highlight_crop.png"))


# =============================================================================
#  11. 主流程
# =============================================================================
def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print("[1/7] 解码 AVIF 并转到增益应用色彩空间 ...")
    E = ensure_decoded()
    C_full = to_gain_application_space(E)
    W = luma_weights()
    peak = float(np.max(C_full))
    print(f"      内容峰值(相对) = {peak:.3f}  ({peak*CONFIG.L_WHITE:.0f} cd/m²)  "
          f"-> 实测 headroom = {np.log2(peak):.2f}")
    print(f"      亮度权重 W_full = [{W[0]:.4f}, {W[1]:.4f}, {W[2]:.4f}] ({CONFIG.LUMA_WEIGHTS})")

    tm, gain, sat, H_baseline = build_tonemapper()
    fmt = lambda a: [round(float(v), 3) for v in a]
    print(f"[2/7] 曲线控制点（可在 CONFIG 中编辑）:")
    print(f"      GainCurve  x={fmt(gain.x)}")
    print(f"                 y={fmt(gain.y)}")
    print(f"                 m(PCHIP)={fmt(gain.m)}")
    print(f"      SaturCurve x={fmt(sat.x)}")
    print(f"                 S={fmt(sat.y)}")
    print(f"                 m(PCHIP)={fmt(sat.m)}")
    print(f"      H_baseline={H_baseline:.3f}  H_target={CONFIG.H_TARGET:g}")

    print("[3/7] 绘制曲线 ...")
    plot_curves(gain, sat, H_baseline)

    print("[4/7] 处理整图（新方案 + 2094-50 耦合对照）...")
    C_prev = downscale(C_full, CONFIG.PREVIEW_MAX_SIDE)
    C_new, S_map = pipeline_new(C_prev, tm)
    C_cpl = pipeline_coupled(C_prev, gain, H_baseline)
    peak_rel = 2.0 ** CONFIG.H_TARGET if CONFIG.H_TARGET > 0 else 1.0
    save_png(linear_p3_to_srgb_encoded(C_new, peak_rel),
             os.path.join(OUT_DIR, "result_new_method.png"))
    save_png(linear_p3_to_srgb_encoded(C_cpl, peak_rel),
             os.path.join(OUT_DIR, "result_coupled_2094_50.png"))
    save_png(linear_p3_to_srgb_encoded(C_prev, peak),
             os.path.join(OUT_DIR, "result_input_hdr_preview.png"))

    print("[5/7] 高光区裁剪对照 + 合成色带 ...")
    highlight_crop_compare(C_new, C_cpl, C_prev)
    synthetic_swatch(tm, gain, H_baseline)

    print("[6/7] 公平色相对比（相同彩度衰减量下的 ΔH°）...")
    hue_sum = matched_chroma_hue_experiment(tm, gain, H_baseline)
    print("      色相     新方案ΔH°   2094-50耦合ΔH°   (均在40%彩度衰减处, 越小越好)")
    for name, hn, hc in hue_sum:
        win = "✓新方案更优" if hn < hc else "✓耦合更优"
        print(f"      {name:<8} {hn:6.2f}       {hc:6.2f}        {win}")

    print(f"[7/7] 亮度漂移指标（|Y_out/Y_intended-1|, 感知域={CONFIG.PERCEPTION}）...")
    lum = luminance_error_experiment(tm, gain, H_baseline)
    print("      色相   亮度x   新-步骤一   新-完整(%s)  新-完整(linear)  2094-50耦合" % CONFIG.PERCEPTION)
    for name, rows in lum.items():
        for (x, e1, epq, elin, ec) in rows:
            print(f"      {name:<7}{x:4.1f}   {e1:6.2f}%    {epq:6.2f}%      {elin:6.2f}%        {ec:7.2f}%")

    print(f"\n完成，输出目录: {OUT_DIR}")


if __name__ == "__main__":
    main()
