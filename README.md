# UWA 轻量化动态元数据（Gain Curve + CCM）参考实现

> **提案**：UWA N0258《轻量化 UWA 技术提案 —— 用于色彩体积转换的动态元数据（gain curve + CCM）》
> **参考标准**：SMPTE ST 2094-50:2016
> **许可**：Apache License 2.0

本仓库是 UWA 提案 N0258 的**开源参考实现**，包含一份可交互的浏览器 Demo、一份
Python 参考实现，以及提案原文。目标是让审阅者能够**亲手验证**提案所声称的改进：
在 HDR→SDR 色调映射中消除高光退白带来的色相偏移与亮度漂移。

---

## 1. 这个项目解决什么问题

HDR 内容映射到 SDR 显示时，高光区域需要压缩亮度。原版 SMPTE ST 2094-50 通过令
Component Mixing 的 `k_component ≠ 0`，使 R、G、B 三个通道获得**互不相同**的增益，
从而在压缩亮度的同时顺带实现"高光退白"（highlight desaturation）。

这种"一箭双雕"的做法有两个副作用：

| 问题 | 成因 |
| --- | --- |
| **色相偏移**（hue shift） | 三通道增益不一致，RGB 比例被改变，颜色偏向增益最大的通道 |
| **亮度漂移**（luminance drift） | 实际输出亮度偏离曲线设计的目标亮度 |

在饱和的高光（霞光、霓虹、有色光源）上，这两个问题都清晰可见。

## 2. 核心思想：把"压亮度"和"退高光白"解耦

提案的做法是把耦合在一起的两件事拆成两个**正交**的操作：

**步骤一 —— Gain Curve 只负责亮度**
令 `k_component = 0`。此时三通道拿到**同一个标量增益** `2^G`，RGB 严格等比缩放：

```
C_output = C · 2^G        G = GainCurve(f_common(C))
```

等比缩放不改变 RGB 比例 ⇒ **色相恒定**；增益即曲线设计值 ⇒ **无亮度漂移**。

**步骤二 —— Saturation Curve 只负责饱和度**
复用同一套 Hermite 曲线模型再取一条曲线 `S = SatCurve(f_common(C))`，在**感知域**
把颜色向"等亮度中性灰"收缩：

```
C_target = f⁻¹( S · f(C_output) + (1−S) · f(grey) )
grey = (W·C_output) 复制到三通道，W 为亮度权重
```

因为收缩方向始终沿着**等亮度灰轴**，退白过程天然保持色相，且亮度受控。

两条曲线共用 ST 2094-50 的同一个曲线模型（分段三次 Hermite + PCHIP 单调保形斜率），
因此**不增加新的元数据语法**，只是把已有字段用出了正交的语义——这也是"轻量化"的含义。

---

## 3. 仓库结构

```
UWA-N0258-GainCurve-CCM/
├── README.md                  本文件
├── LICENSE                    Apache License 2.0 全文
├── NOTICE                     版权声明 / 标准引用 / 第三方组件说明
├── PATENTS.txt                专利授权说明
│
├── proposal/                  提案原文（.docx）
│
├── algorithm/                 Python 参考实现（权威实现）
│   └── uwa_gaincurve_ccm.py   单文件：完整管线 + 对照实验 + 量化指标
│
└── web-demo/                  交互式浏览器 Demo
    ├── dist/                  预构建产物 —— 双击 dist/index.html 即可运行（推荐）
    ├── index.html             ⚠️ 开发版入口，不要直接双击打开，见 4.1 说明
    ├── styles.css
    ├── serve.py               本地静态服务器（仅配合开发版 index.html 使用）
    ├── build-dist.mjs         构建脚本（生成 dist/）
    ├── data/test.avif         HDR 测试素材（全仓库共用这一份）
    ├── uwa-color/             底层色彩库（传递函数 / 色度 / 曲线 / GLSL 管线）
    └── src/                   Demo 业务逻辑（UI、指标、元数据装配）
```

---

## 4. 快速开始

### 4.1 交互式 Web Demo（推荐，零依赖）

直接打开预构建产物即可，**不需要 Node、不需要联网、不需要起服务器**：

```
web-demo/dist/index.html        ← 双击打开（macOS 亦可双击 Open-Demo.command）
```

测试素材已内嵌进 `dist/sample-embedded.js`，因此在 `file://` 协议下也能正常加载。

> ⚠️ **注意路径**：一定要打开 `web-demo/dist/index.html`，**不要**打开
> `web-demo/index.html`（仓库根目录下那个）。后者是开发版源码入口，使用了浏览器
> ES Module（`<script type="module">`），在 `file://` 协议下会被浏览器 CORS 策略
> 拦截脚本加载，报错看起来很像"连接失败/服务未响应"，但这**不是缺少后端**——
> 项目本身没有任何服务器端计算，色调映射完全在浏览器 WebGL 中完成。开发版必须配合
> `python3 serve.py` 起本地静态服务器才能通过 `http://127.0.0.1:8765/` 访问（见 4.2）；
> 日常查看效果**只需要 `dist/index.html`，双击即可，零依赖、零服务器**。

页面提供三个并排视图与两个可拖拽的曲线编辑器：

| 视图 | 含义 |
| --- | --- |
| **Base** | 输入 HDR，位于 baseline headroom |
| **Target** | 本方案输出：亮度压缩 + 感知域退白 |
| **Alternate** | 仅步骤一（Gain Curve 等比缩放），用于观察退白的独立贡献 |

可交互项：

- **Target Headroom** 滑杆：目标显示器 headroom，`0` = SDR（峰值 = 参考白）。
- **Perception** 下拉：退白所在的感知域（PQ / Gamma / Log2 / Linear）。
- **Target = 2094-50 法** 勾选框：把 Target 切换为原版耦合退白，用于**直接对比色相偏移**。
- **Gain Curve / Saturation Curve** 编辑器：拖动控制点实时改变映射结果。
- **统计** 按钮：输出色相偏移与亮度漂移的量化指标。
- **上传图像**：换用自己的 HDR 素材（AVIF / 支持的 HDR 图像）。
- **保存 Target**：导出当前 Target 视图为 PNG。

运行环境：任意支持 **WebGL 2** 的现代浏览器（Chrome / Edge / Safari / Firefox）。
色调映射在片元着色器中逐像素实时完成。

### 4.2 从源码构建 Web Demo（可选）

仅在你修改了 `web-demo/src/` 或 `web-demo/uwa-color/` 后才需要：

```bash
cd web-demo
node build-dist.mjs        # 通过 npx 临时调用 esbuild 打包，重新生成 dist/
```

开发时也可以起本地服务器，改完刷新即可，无需构建：

```bash
cd web-demo
python3 serve.py           # 然后访问 http://127.0.0.1:8765/
```

### 4.3 Python 参考实现

Python 版是本项目的**权威实现**，Web Demo 的数值以它为准。

```bash
pip install numpy opencv-python matplotlib
# 需要命令行工具 avifdec（libavif）用于解码 AVIF：
#   macOS: brew install libavif      Ubuntu: sudo apt install libavif-bin

cd algorithm
python3 uwa_gaincurve_ccm.py
```

脚本会在 `algorithm/output/` 下生成全部可视化 PNG，并在控制台打印量化指标：

| 产物 | 内容 |
| --- | --- |
| `result_new_method.png` | 本方案输出 |
| `result_coupled_2094_50.png` | 原版 2094-50 耦合退白输出（对照） |
| `result_input_hdr_preview.png` | 输入 HDR 预览 |
| `curves_gain_saturation.png` | Gain / Saturation / 输入输出亮度三条曲线 |
| `synthetic_swatch.png` | 合成色带两法并排对比 |
| `compare_highlight_crop.png` | 高光局部放大对比 |
| `hue_shift_matched_chroma.png` | **等彩度衰减**下的色相偏移对比 |
| `luminance_error.png` | 亮度漂移量化 |

> `output/test_16bit.png` 是 AVIF 的解码缓存，存在时会跳过解码。
> 更换输入素材后需删除该缓存，或用环境变量 `UWA_TEST_AVIF` 指定新输入。

---

## 5. 算法管线

```
test.avif  (PQ, Display-P3, 10bit)
  │
  ├─ 解码 → 16bit PNG → PQ 码值 [0,1]
  │
  ├─ pq_eotf ──────────────→ 绝对亮度 cd/m²
  │
  ├─ ÷ L_WHITE (203 cd/m²) → 增益应用色彩空间 C（1.0 = 参考白）
  │
  ├─【本方案】ToneMap(k_component=0) ──→ apply_saturation(感知域退白)
  │
  └─【对照】 ToneMap(k_component≠0) ───→ （退白已耦合在增益里）
       │
       └─ 线性 P3 → sRGB 编码 → 8bit 预览
```

测试素材参数：HDR PQ、Display-P3 原色、10bit，峰值 ≈ 1330 cd/m²，
参考白 203 cd/m²（BT.2408）⇒ baseline headroom ≈ 2.71 stop。

### 关键模块

两份实现按相同的分节结构组织，便于逐节对照：

| 模块 | Python (`algorithm/`) | Web (`web-demo/uwa-color/`) |
| --- | --- | --- |
| PQ 传递函数 | `pq_eotf` / `pq_oetf` | `uwa-transfer.js`（GLSL） |
| 色度与亮度权重 | `primaries_to_xyz` / `luma_weights` | `uwa-chromaticity.js` |
| Hermite 曲线 + PCHIP | `class HermiteCurve` | `uwa-hermite-curve.js` |
| Headroom 自适应插值 | `class ToneMapper` | `uwa-headroom-adapt.js` |
| 逐像素管线 | `pipeline_new` / `pipeline_coupled` | `uwa-tonemap-gl.js`（GLSL） |

**Gain Curve 与 Saturation Curve 是同一个曲线类的两个实例**，只是控制点不同——
这正是"复用已有元数据语法"的直接体现。亮度曲线在末控制点之后采用 `log2` 外推，
保证超出内容峰值的输入仍然单调可预测。

---

## 6. 调参

所有可调参数集中在 `algorithm/uwa_gaincurve_ccm.py` 顶部的 `CONFIG` 类：

| 参数 | 含义 |
| --- | --- |
| `X_GAIN` / `Y_GAIN` | Gain Curve 控制点（`x` = f_common，`y` = log₂ 增益） |
| `X_SAT` / `S_SAT` | Saturation Curve 控制点（`S` = 饱和度系数） |
| `K_NEW` / `K_COUPLED` | 本方案 / 对照法的 Component Mixing 权重 |
| `PERCEPTION` | 退白所在感知域：`pq`（默认）/ `gamma` / `log2` / `linear` |
| `LUMA_WEIGHTS` | 亮度权重来源：`p3`（精确）/ `rec709`（提案示例） |
| `H_TARGET` | 目标 headroom，`0` = SDR |
| `L_WHITE` | HDR 参考白，默认 203 cd/m² |

改完直接重跑脚本即可。Web Demo 侧的对应初值在 `web-demo/src/gaincurve-metadata.js`，
并可在页面上拖动控制点实时调整。

> `PERCEPTION = linear` 时退白严格保持亮度，但会略微牺牲红色的色相稳定性；
> 默认 `pq` 在两者之间取得较好平衡。

---

## 7. 正确性验证

### 7.1 提案效果的量化对照

Python 脚本内置两个对照实验，用于支撑提案结论：

- **等彩度衰减下的色相偏移对比**（`matched_chroma_hue_experiment`）
  两种方法的退白强度参数不同（本方案扫 `S`，对照法扫 `k_component`），直接比较并不公平。
  该实验把两者对齐到**相同的彩度衰减量**，再在 CIELAB 中测量色相角偏差，
  确保比较是同等条件下进行的。

- **亮度漂移量化**（`luminance_error_experiment`）
  以 `|Y_out / Y_intended − 1|` 衡量实际输出亮度与曲线设计目标亮度的相对偏差。

### 7.2 Web Demo 与 Python 实现的数值一致性

Web Demo 不是"另一套近似实现"，其数值以 Python 权威实现为基准逐项校验过：

| 校验对象 | 方式 | 结果 |
| --- | --- | --- |
| PCHIP 斜率、Hermite 曲线求值（含高端 log2 外推） | JS 与 Python 同点比对 | 一致，最大误差 ~1e-16（双精度舍入级） |
| P3→XYZ 矩阵、亮度权重 | JS 与 Python 同参比对 | 一致，最大误差 ~2e-16 |
| 逐像素完整管线（tone map / S_total / 退白后输出） | 在真实浏览器中执行 GLSL，读回浮点像素与 Python 比对；覆盖 headroom = 0 / 1 / 2 | 一致，最大相对误差 ~8e-5（float32 精度级） |

因此在 Demo 中观察到的现象，与 Python 脚本给出的量化指标指向同一套数值。

---

## 8. 标准依据

算法实现对应的标准条款：

| 内容 | 依据 |
| --- | --- |
| Gain Curve 模型（分段三次 Hermite） | ST 2094-50 §6.5 |
| 单调保形斜率（PCHIP / Fritsch-Butland） | ST 2094-50 附录 C.3.9、C.7–C.9 |
| Component Mixing | ST 2094-50 §6.4 |
| Headroom 自适应增益插值 | ST 2094-50 §6.2.5 |
| PQ 传递函数常数 | ST 2084:2014 附件 A |
| HDR 参考白 203 cd/m² | ITU-R BT.2408 |
| Display-P3 原色与白点 | SMPTE EG 432-1 |

完整的规范引用清单见 [`NOTICE`](NOTICE)。本仓库不包含任何标准文本的复制件。

---

## 9. 许可

本项目依据 **Apache License, Version 2.0** 发布，许可全文见 [`LICENSE`](LICENSE)。

- 版权声明与规范引用：[`NOTICE`](NOTICE)
- 专利授权说明：[`PATENTS.txt`](PATENTS.txt)

```
Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
Licensed under the Apache License, Version 2.0
```

`proposal/` 下的提案文档为 UWA 标准提案原文，其使用受相应标准化组织的规则约束，
不在本仓库代码许可的覆盖范围内。
