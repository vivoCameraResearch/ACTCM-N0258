// Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
// SPDX-License-Identifier: Apache-2.0

// gainCurve Web UI — main orchestration
// 色彩与色调映射底层由 uwa-color/ 提供（本项目自有实现，见各文件头说明）
import { CONFIG, newMethodMetadata, coupledMethodMetadata, P3_LUMA_WEIGHTS, baselineHeadroom } from "./gaincurve-metadata.js";
import { pchipSlopes } from "./pchip.js";
import * as Metrics from "./metrics.js";

// uwa-color/ 通过 <script> 以全局符号方式加载:
//   kUwaTransferGLSL, kUwaToneMapGLSL, UwaGainCurveToneMapper, UwaHermiteCurve,
//   uwaHeadroomAdaptiveWeights, uwaRgbConversionMatrixColMajor,
//   uwaColorSpaceChromaticities, kTransferPQ / kPrimariesP3 等 CICP 常量

// ---- shader: 顶点着色器为全屏三角形，片元着色器拼接 uwa-color 的 GLSL 片段 ----
const vs = `#version 300 es
precision highp float;
in vec2 position;
out vec2 texcoord;
void main() {
  texcoord = vec2(0.5+0.5*position.x, 0.5-0.5*position.y);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const fs = `#version 300 es
precision highp float;
uniform sampler2D content;
uniform int texture_trfn;
uniform vec3 texture_primaries_Y;
uniform int framebuffer_trfn;
uniform mat3 primary_matrix_texture_to_gain;
uniform mat3 primary_matrix_gain_to_framebuffer;
in vec2 texcoord;
out vec4 fragColor;
uniform float target_log2_headroom;
uniform float linear_scale;
uniform float hdrReferenceWhite;
` + kUwaTransferGLSL + `
` + kUwaToneMapGLSL + `
vec3 ApplyOetfInv(vec3 x, int transfer) {
  return vec3(sign(x[0]) * transferToLinear(abs(x[0]), transfer),
              sign(x[1]) * transferToLinear(abs(x[1]), transfer),
              sign(x[2]) * transferToLinear(abs(x[2]), transfer));
}
vec3 ApplyOetf(vec3 x, int transfer) {
  return vec3(sign(x[0]) * transferFromLinear(abs(x[0]), transfer),
              sign(x[1]) * transferFromLinear(abs(x[1]), transfer),
              sign(x[2]) * transferFromLinear(abs(x[2]), transfer));
}
vec3 ApplyOotf(vec3 rgb, vec3 Y, int transfer) {
  if (transfer != kTransferHLG) return rgb;
  return rgb * pow(dot(Y, rgb), 0.2);
}
void main() {
  vec3 rgb = texture(content, texcoord).rgb;
  rgb = ApplyOetfInv(rgb, texture_trfn);
  rgb = ApplyOotf(rgb, texture_primaries_Y, texture_trfn);
  if (texture_trfn == kTransferHLG) rgb *= 1000.0 / hdrReferenceWhite;
  if (texture_trfn == kTransferPQ) rgb *= 10000.0 / hdrReferenceWhite;
  vec3 C = primary_matrix_texture_to_gain * rgb;
  vec3 C_out = UwaToneMapInGainApplicationSpace(C);
  if (apply_saturation == 1) {
    // 查 S 用原图 C, 退白作用在增益后的 C_out
    C_out = UwaApplySaturation(C, C_out);
  }
  rgb = primary_matrix_gain_to_framebuffer * C_out;
  rgb *= linear_scale;
  rgb = ApplyOetf(rgb, framebuffer_trfn);
  rgb = clamp(rgb, 0.0, exp2(target_log2_headroom));
  fragColor.rgb = rgb;
  fragColor.a = 1.0;
}`;

function compileShader(gl, vsSrc, fsSrc) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  return prog;
}

// ---- 状态 ----
const state = {
  diffuseWhite: 203,          // L_DW, 固定 203 (内容元数据, 非滑块)
  hTarget: 0,                 // H_target 滑块值 (目标显示 headroom, 0=SDR)
  hBaseline: null,            // H_base, 来自加载图像自带的元数据 (如 cow.json 的 baselineHdrHeadroom); 未加载时退回 CONFIG 默认
  perceptionMode: 0,        // 0=pq
  coupled: false,            // Target/Alternate 用耦合法?
  metadataNew: null,
  metadataCoupled: null,
  imageBitmap: null,
  contentTransfer: 16,       // kTransferPQ
  contentPrimaries: 12,      // kPrimariesP3 (test.avif)
  gainControlPoints: null,  // [{x,y,m}]
  satControlPoints: null,
  imageSamples: null,        // 图像加载时预算好的采样点 [{Cin,h0,chroma,Yin}], 供 Metrics.computeImageMetrics 复用
  initialGainControlPoints: null,  // 用于"重置"按钮: 加载图像时的原始曲线快照
  initialSatControlPoints: null,
};

// H_base 的当前值: 有加载的图像元数据则用其真实值, 否则退回 CONFIG 默认 (log2(X_GAIN[-1]))
function currentHBaseline() {
  return state.hBaseline ?? baselineHeadroom();
}

// 每个画布用独立 WebGL2 context (共享纹理数据通过 setImage 各自上传)
// 为简化, 这里用单 context 渲染到 target, base/alt 通过 readback 或重新渲染。
// 更简单可靠: 3 个独立 renderer 实例。
class MultiCanvasRenderer {
  constructor(canvasIds) {
    this.renderers = {};
    for (const [key, id] of Object.entries(canvasIds)) {
      const c = document.getElementById(id);
      const gl = c.getContext('webgl2');
      gl.getExtension('EXT_color_buffer_half_float');
      gl.getExtension('EXT_color_buffer_float');
      let hasHdrCanvas = false;
      try { c.configureHighDynamicRange({ mode: 'extended' }); hasHdrCanvas = true; } catch(e) {}
      this.renderers[key] = { canvas: c, gl, program: compileShader(gl, vs, fs), tex: null, tmNew: null, tmCoupled: null, fbPrim: ('drawingBufferColorSpace' in gl)?12:1, hasHdrCanvas };
    }
  }
  setMetadata(metaNew, metaCoupled) {
    for (const r of Object.values(this.renderers)) {
      r.tmNew = new UwaGainCurveToneMapper(r.gl, metaNew);
      r.tmCoupled = new UwaGainCurveToneMapper(r.gl, metaCoupled);
    }
  }
  setImage(bitmap) {
    for (const r of Object.values(this.renderers)) {
      const gl = r.gl;
      const realloc = (r.tex_w !== bitmap.width || r.tex_h !== bitmap.height);
      if (realloc) { r.tex = gl.createTexture(); r.tex_w = bitmap.width; r.tex_h = bitmap.height; }
      gl.bindTexture(gl.TEXTURE_2D, r.tex);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      if (realloc) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, r.tex_w, r.tex_h, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, r.tex_w, r.tex_h, gl.RGBA, gl.FLOAT, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }
  resizeAll(w, h) {
    for (const r of Object.values(this.renderers)) {
      const fw = Math.round(2 * w), fh = Math.round(2 * h);
      r.canvas.width = fw; r.canvas.height = fh;
      // 同时设 CSS 尺寸为同样的宽高比, 防止 CSS 布局 (width:100%; flex:1) 拉伸 drawing buffer
      r.canvas.style.width = w + 'px';
      r.canvas.style.height = h + 'px';
      // 分配 HDR 绘图缓冲区 (RGBA16F), 使 >1.0 的值不被 clip。
      try { r.gl.drawingBufferStorage(r.gl.RGBA16F, fw, fh); } catch (e) {}
    }
  }
  // H: 该视图要显示的目标 headroom (语义同 ST 2094-50 §6.2.5 的 target HDR headroom)。
  // H='baseline' 时从即将使用的 metadata 对象直接读取 baselineHdrHeadroom (而不是另一个独立变量),
  // 保证插值函数收到的 H_target 与 metadata 里的 baseline 值精确相等 (weight 严格归零, 图像原样输出,
  // 不受曲线控制点变化影响)。Target 传 UI 滑块值; Alternate 传 0 (满增益, SDR 映射)。
  drawView(key, H, useCoupled) {
    const r = this.renderers[key];
    if (!r) return;
    const gl = r.gl;
    if (!r.tex) { gl.clearBufferfv(gl.COLOR, 0, [0.05,0.05,0.06,1]); return; }
    const metadata = useCoupled ? state.metadataCoupled : state.metadataNew;
    const toneMapper = useCoupled ? r.tmCoupled : r.tmNew;
    if (!metadata || !toneMapper) return;
    if (H === 'baseline') H = metadata.headroomAdaptiveToneMap.baselineHdrHeadroom;

    gl.useProgram(r.program);
    gl.viewport(0, 0, r.canvas.width, r.canvas.height);
    gl.clearBufferfv(gl.COLOR, 0, [0.05, 0.05, 0.06, 1.0]);

    const verts = gl.createBuffer();
    const idx = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, verts);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, 1,1, -1,1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2, 0,2,3]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(r.program, 'position');
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(posLoc);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.tex);
    gl.uniform1i(gl.getUniformLocation(r.program, 'content'), 0);

    // framebuffer_trfn 始终 sRGB (不切 PQ)。>1.0 的高光靠 RGBA16F 缓冲区
    // + configureHighDynamicRange('extended') 由浏览器解读为扩展动态范围, 而不是切换编码。
    gl.uniform1i(gl.getUniformLocation(r.program, 'framebuffer_trfn'), 13); // sRGB
    // target_log2_headroom 同时用于: (a) headroom 自适应插值权重 (b) 最终 clamp 上限 exp2(H)
    gl.uniform1f(gl.getUniformLocation(r.program, 'target_log2_headroom'), H);
    gl.uniform1f(gl.getUniformLocation(r.program, 'linear_scale'), 1);
    gl.uniform1i(gl.getUniformLocation(r.program, 'texture_trfn'), state.contentTransfer);
    gl.uniform3f(gl.getUniformLocation(r.program, 'texture_primaries_Y'), 0.2627, 0.6780, 0.0593);
    gl.uniformMatrix3fv(gl.getUniformLocation(r.program, 'primary_matrix_texture_to_gain'), false,
      uwaRgbConversionMatrixColMajor(uwaColorSpaceChromaticities(state.contentPrimaries), metadata.headroomAdaptiveToneMap.gainApplicationChromaticities));
    gl.uniformMatrix3fv(gl.getUniformLocation(r.program, 'primary_matrix_gain_to_framebuffer'), false,
      uwaRgbConversionMatrixColMajor(metadata.headroomAdaptiveToneMap.gainApplicationChromaticities, uwaColorSpaceChromaticities(r.fbPrim)));
    gl.uniform1f(gl.getUniformLocation(r.program, 'hdrReferenceWhite'), state.diffuseWhite);
    gl.uniform3f(gl.getUniformLocation(r.program, 'luma_weights'), P3_LUMA_WEIGHTS[0], P3_LUMA_WEIGHTS[1], P3_LUMA_WEIGHTS[2]);
    gl.uniform1i(gl.getUniformLocation(r.program, 'perception_mode'), state.perceptionMode);
    // apply_saturation 始终开启: S_total 的插值公式在 baseline 处天然收敛为 1 (无退白),
    // 在 alternate 处收敛为曲线值 (满退白), 不需要按视图开关 (对齐 Python ToneMapper.total_saturation)。
    gl.uniform1i(gl.getUniformLocation(r.program, 'apply_saturation'), 1);
    // 单一机制: 同一个 setUniforms, 只是传入不同的目标 headroom H (无 view_kind 覆盖)。
    toneMapper.setUniforms(H, r.program, 2);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }
  drawAll() {
    this.drawView('base', 'baseline', state.coupled);
    this.drawView('target', state.hTarget, state.coupled);
    this.drawView('alt', 0, state.coupled);
  }
}

let renderer = null;

// ---- 重建 metadata (控制点变化时) ----
function rebuildMetadata() {
  const hBaseOverride = currentHBaseline();
  const metaNew = newMethodMetadata(hBaseOverride);
  const metaCoupled = coupledMethodMetadata(hBaseOverride);
  // 用编辑后的控制点覆盖
  if (state.gainControlPoints) {
    metaNew.headroomAdaptiveToneMap.alternateImages[0].colorGainFunction.gainCurve.controlPoints = state.gainControlPoints;
    metaCoupled.headroomAdaptiveToneMap.alternateImages[0].colorGainFunction.gainCurve.controlPoints = state.gainControlPoints;
  }
  if (state.satControlPoints) {
    metaNew.headroomAdaptiveToneMap.alternateImages[0].colorGainFunction.saturationCurve.controlPoints = state.satControlPoints;
  }
  state.metadataNew = metaNew;
  state.metadataCoupled = metaCoupled;
  if (renderer) renderer.setMetadata(metaNew, metaCoupled);
}

// ---- 图像采样 (供指标用): 用 WebGL mipmap 把整图下采样到一个小网格再 readPixels ----
// 只在图像加载时跑一次 (较重: 上传全图纹理 + 生成 mipmap), 拖曲线/滑块时复用缓存的采样点,
// 不重新采样图像, 只重算颜色变换 (便宜)。
function sampleBitmapForMetrics(bitmap, sampleSize = 64) {
  const canvas = new OffscreenCanvas(sampleSize, sampleSize);
  const gl = canvas.getContext('webgl2');
  gl.getExtension('EXT_color_buffer_half_float');
  gl.getExtension('EXT_color_buffer_float');

  const fullW = bitmap.width, fullH = bitmap.height;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, fullW, fullH, 0, gl.RGBA, gl.FLOAT, null);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, fullW, fullH, gl.RGBA, gl.FLOAT, bitmap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D); // box-filter 下采样, 生成各级 mip

  // 找到尺寸最接近 sampleSize 的 mip 级别 (每级减半)
  let level = 0, w = fullW, h = fullH;
  while (w > sampleSize && h > sampleSize && level < 20) {
    level++; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
  }

  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, level);
  const data = new Float32Array(w * h * 4);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, data);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  return { data, width: w, height: h };
}

function updateImageSamples(bitmap) {
  try {
    const { data, width, height } = sampleBitmapForMetrics(bitmap, 64);
    state.imageSamples = Metrics.prepareImageSamples(data, width, height, state.diffuseWhite);
  } catch (err) {
    console.warn('图像采样失败 (指标将不可用):', err);
    state.imageSamples = null;
  }
}

// ---- 图像加载 ----
async function loadImage(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  state.imageBitmap = bitmap;
  renderer.setImage(bitmap);
  updateImageSamples(bitmap);
  renderer.drawAll();
  updateMetrics();
}

// 默认示例: test.avif (PQ · Display-P3), 曲线用 CONFIG 默认控制点
async function loadDefaultSample() {
  state.hBaseline = baselineHeadroom();
  state.contentPrimaries = 12; // kPrimariesP3 — 与 Python 管线 test.avif 一致
  state.contentTransfer = 16;  // PQ
  rebuildMetadata();
  const th = document.getElementById('target-headroom');
  if (th) th.max = String(Math.round(state.hBaseline * 100));

  if (window.__GAINCURVE_SAMPLE__?.avifBase64) {
    const bin = atob(window.__GAINCURVE_SAMPLE__.avifBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/avif' });
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    state.imageBitmap = bitmap;
    renderer.setImage(bitmap);
    updateImageSamples(bitmap);
    renderer.drawAll();
    updateMetrics();
  } else {
    await loadImage('data/test.avif');
  }
}

// ---- 曲线编辑器 (Canvas 2D, 拖拽控制点) ----
class CurveEditor {
  constructor(canvas, kind) {
    this.canvas = canvas;
    this.kind = kind;   // 'gain' | 'sat'
    this.ctx = canvas.getContext('2d');
    this.points = [];   // [{x,y,m}]
    this.dragIndex = -1;
    this.viewOffset = { x: 50, y: canvas.height - 40 };
    this.viewScale = { x: 0, y: 0 };
    canvas.addEventListener('mousedown', e => this.onDown(e));
    canvas.addEventListener('mousemove', e => this.onMove(e));
    window.addEventListener('mouseup', () => this.dragIndex = -1);
    canvas.addEventListener('contextmenu', e => this.onContextMenu(e));
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoom(e); }, { passive: false });
  }
  setPoints(pts) { this.points = pts.map(p => ({...p})); this.fitScale(); this.draw(); }
  fitScale() {
    const xs = this.points.map(p => p.x);
    const ys = this.points.map(p => p.y);
    // 略留右边距, 让末控制点/标签不贴边
    const xMax = Math.max(...xs, 1) * 1.08;
    const yMin = Math.min(...ys, this.kind === 'gain' ? -3 : 0);
    const yMax = Math.max(...ys, this.kind === 'gain' ? 1 : 1.2);
    // 存起来供 draw() 画坐标轴刻度用 (与 viewScale/viewOffset 保持同一套映射)
    this.xMax = xMax; this.yMin = yMin; this.yMax = yMax;
    this.viewScale.x = (this.canvas.width - 80) / xMax;
    this.viewScale.y = -(this.canvas.height - 80) / Math.max(yMax - yMin, 0.1);
    this.viewOffset.y = this.canvas.height - 40 - this.viewScale.y * yMin;
  }
  toView(p) { return { x: this.viewOffset.x + this.viewScale.x * p.x, y: this.viewOffset.y + this.viewScale.y * p.y }; }
  toModel(vx, vy) {
    return { x: (vx - this.viewOffset.x) / this.viewScale.x, y: (vy - this.viewOffset.y) / this.viewScale.y };
  }
  draw() {
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const xMax = this.xMax ?? 8, yMin = this.yMin ?? -3, yMax = this.yMax ?? 1;
    const N_X = 8, N_Y = 5;
    // 竖向网格线 + X 轴刻度数值 (model x = xMax*i/N_X)
    c.font = '11px monospace';
    for (let i = 0; i <= N_X; i++) {
      const mx = xMax * i / N_X;
      const vx = this.toView({ x: mx, y: 0 }).x;
      c.strokeStyle = '#ffffff15'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(vx, 0); c.lineTo(vx, this.canvas.height - 18); c.stroke();
      c.fillStyle = '#8b90a0';
      c.textAlign = (i === 0) ? 'left' : (i === N_X) ? 'right' : 'center';
      c.fillText(mx.toFixed(2), vx, this.canvas.height - 4);
    }
    // 横向网格线 + Y 轴刻度数值 (model y 均匀分 N_Y 段)
    c.textAlign = 'left';
    for (let j = 0; j <= N_Y; j++) {
      const my = yMin + (yMax - yMin) * j / N_Y;
      const vy = this.toView({ x: 0, y: my }).y;
      c.strokeStyle = '#ffffff15'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(46, vy); c.lineTo(this.canvas.width, vy); c.stroke();
      c.fillStyle = '#8b90a0';
      c.fillText(my.toFixed(2), 4, vy + 4);
    }
    // 1.0 参考白竖线
    const p1 = this.toView({ x: 1, y: 0 });
    c.strokeStyle = '#3a8'; c.lineWidth = 2; c.setLineDash([6, 6]);
    c.beginPath(); c.moveTo(p1.x, 0); c.lineTo(p1.x, this.canvas.height - 18); c.stroke();
    c.setLineDash([]);
    // 0 线 (加粗突出, 区别于普通网格线)
    const p0 = this.toView({ x: 0, y: 0 });
    if (p0.y >= 0 && p0.y <= this.canvas.height - 18) {
      c.strokeStyle = '#ffffff50'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(46, p0.y); c.lineTo(this.canvas.width, p0.y); c.stroke();
    }
    // 曲线: 对齐 2094-50 公式 12 —
    //   x < x0          → y0 (水平钳位)
    //   控制点区间内    → 分段三次 Hermite
    //   x ≥ x_last      → y_last + log2(x_last/x)  (Gain / Sat 同公式 12)
    const color = this.kind === 'gain' ? '#4d9fff' : '#b06bff';
    c.strokeStyle = color; c.lineWidth = 3; c.beginPath();
    const pc = new UwaHermiteCurve(this.points.map(p => ({...p})));
    const xFirst = this.points[0].x, xLast = this.points[this.points.length - 1].x;
    const yFirst = this.points[0].y, yLast = this.points[this.points.length - 1].y;
    let started = false;
    for (let px = 0; px <= this.canvas.width; px += 2) {
      const mx = this.toModel(px, 0).x;
      if (mx < 0) continue;
      let my;
      if (mx <= xFirst) {
        my = yFirst;
      } else if (mx >= xLast) {
        my = yLast + Math.log2(xLast / Math.max(mx, 1e-12));
      } else {
        my = pc.evaluate(mx).y;
      }
      const vp = this.toView({ x: mx, y: my });
      if (!started) { c.moveTo(vp.x, vp.y); started = true; } else c.lineTo(vp.x, vp.y);
    }
    c.stroke();
    // 控制点 (末点标签偏左, 避免贴边被裁切)
    c.fillStyle = '#ff5d5d';
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const vp = this.toView(p);
      c.beginPath(); c.arc(vp.x, vp.y, 7, 0, 2 * Math.PI); c.fill();
      c.fillStyle = '#fff'; c.font = '12px monospace';
      const label = `(${p.x.toFixed(2)},${p.y.toFixed(2)})`;
      const nearRight = i === this.points.length - 1;
      if (nearRight) {
        c.textAlign = 'right';
        c.fillText(label, vp.x - 10, vp.y - 8);
        c.textAlign = 'left';
      } else {
        c.fillText(label, vp.x + 10, vp.y - 8);
      }
      c.fillStyle = '#ff5d5d';
    }
  }
  hitTest(pos) {
    let best = -1, bestD = 14 * 14;
    for (let i = 0; i < this.points.length; i++) {
      const vp = this.toView(this.points[i]);
      const d = (vp.x - pos.x) ** 2 + (vp.y - pos.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  getPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * this.canvas.width / r.width, y: (e.clientY - r.top) * this.canvas.height / r.height };
  }
  onDown(e) {
    if (e.button !== 0) return;
    const pos = this.getPos(e);
    const best = this.hitTest(pos);
    this.dragIndex = best;
    if (best < 0) {
      const m = this.toModel(pos.x, pos.y);
      this.points.push({ x: Math.max(0, m.x), y: m.y, m: 0 });
      this.points.sort((a, b) => a.x - b.x);
      this.recomputeSlopes();
      this.onChanged();
    }
  }
  onContextMenu(e) {
    e.preventDefault();
    const idx = this.hitTest(this.getPos(e));
    if (idx < 0) return;
    if (this.points.length <= 2) {
      toast('至少保留 2 个控制点');
      return;
    }
    this.points.splice(idx, 1);
    this.recomputeSlopes();
    this.onChanged();
  }
  onMove(e) {
    if (this.dragIndex < 0 || e.buttons !== 1) return;
    const pos = this.getPos(e);
    const m = this.toModel(pos.x, pos.y);
    this.points[this.dragIndex].y = m.y;
    if (!e.shiftKey) this.points[this.dragIndex].x = Math.max(0, m.x);
    this.points.sort((a, b) => a.x - b.x);
    this.recomputeSlopes();
    this.onChanged();
  }
  zoom(e) {
    const f = Math.exp2(-e.deltaY * 0.01);
    this.viewScale.x *= f; this.viewScale.y *= f;
    this.draw();
  }
  recomputeSlopes() {
    const xs = this.points.map(p => p.x);
    const ys = this.points.map(p => p.y);
    const m = pchipSlopes(xs, ys);
    this.points.forEach((p, i) => p.m = m[i]);
  }
  onChanged() {
    if (this.kind === 'gain') state.gainControlPoints = this.points.map(p => ({...p}));
    else state.satControlPoints = this.points.map(p => ({...p}));
    rebuildMetadata();
    renderer.drawAll();
    updateMetrics();
    this.draw();
  }
}

let gainEditor = null, satEditor = null;

// ---- 指标 ----
function updateMetrics() {
  const tbody = document.querySelector('#metrics-table tbody');
  const m = Metrics.computeImageMetrics(state);
  if (!m) { tbody.innerHTML = '<tr><td colspan=4>加载图像后显示</td></tr>'; return; }
  const row = (method, label, hue, lum) => `<tr><td>${method}</td><td>${label}</td><td>${hue.toFixed(2)}°</td><td>${lum.toFixed(2)}%</td></tr>`;
  tbody.innerHTML = `
    ${row('新法', 'Alt vs Base', m.new.altHueDeg, m.new.altLumPct)}
    ${row('新法', 'Target vs Base', m.new.targetHueDeg, m.new.targetLumPct)}
    ${row('2094-50', 'Alt vs Base', m.coupled.altHueDeg, m.coupled.altLumPct)}
    ${row('2094-50', 'Target vs Base', m.coupled.targetHueDeg, m.coupled.targetLumPct)}
  `;
  const note = document.getElementById('metrics-note');
  const hBase = currentHBaseline();
  const w = (state.hTarget - hBase) / (0 - hBase);
  note.textContent = `采样=${m.sampleCount}px · perception=${['pq','gamma','log2','linear'][state.perceptionMode]} · H_base=${hBase.toFixed(2)} · H_alt=0 · H_target=${state.hTarget.toFixed(2)} · w=${w.toFixed(3)}`;
}

// ---- 图像加载 ----
async function handleImageFile(file) {
  try {
    const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none' });
    state.imageBitmap = bitmap;
    renderer.setImage(bitmap);
    updateImageSamples(bitmap);
    resize();
    renderer.drawAll();
    updateMetrics();
    toast(`已加载 ${file.name}`);
  } catch (err) {
    toast(`加载失败: ${err?.message || err}`);
    console.error('handleImageFile', err);
  }
}

// ---- 初始化 ----
function init() {
  renderer = new MultiCanvasRenderer({ base: 'base-canvas', target: 'target-canvas', alt: 'alt-canvas' });

  gainEditor = new CurveEditor(document.getElementById('gain-editor'), 'gain');
  satEditor = new CurveEditor(document.getElementById('sat-editor'), 'sat');
  gainEditor.setPoints(state.gainControlPoints || buildDefaultGain());
  satEditor.setPoints(state.satControlPoints || buildDefaultSat());

  rebuildMetadata();

  // 控件: Target Headroom 滑块 (滑块值 ×100, 0..271 → 0.00..2.71)
  const th = document.getElementById('target-headroom');
  th.addEventListener('input', () => {
    state.hTarget = Number(th.value) / 100;
    document.getElementById('target-headroom-val').textContent = state.hTarget.toFixed(2);
    renderer.drawAll(); updateMetrics();
  });
  document.getElementById('perception-mode').addEventListener('change', e => {
    state.perceptionMode = Number(e.target.value);
    renderer.drawAll(); updateMetrics();
  });
  document.getElementById('coupled-toggle').addEventListener('change', e => {
    state.coupled = e.target.checked;
    renderer.drawAll(); updateMetrics();
  });
  document.getElementById('gain-reset-btn')?.addEventListener('click', () => resetCurve('gain'));
  document.getElementById('sat-reset-btn')?.addEventListener('click', () => resetCurve('sat'));
  document.getElementById('upload-btn').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    await handleImageFile(f);
    e.target.value = ""; // 允许重复选同一文件
  });
  // 拖拽上传
  const dropZone = document.body;
  dropZone.addEventListener('dragover', e => { e.preventDefault(); });
  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) await handleImageFile(f);
  });
  document.getElementById('save-btn').addEventListener('click', () => {
    const c = document.getElementById('target-canvas');
    const a = document.createElement('a');
    a.download = 'target.png'; a.href = c.toDataURL('image/png'); a.click();
  });
  document.getElementById('metrics-btn')?.addEventListener('click', () => {
    const lower = document.querySelector('.lower');
    const btn = document.getElementById('metrics-btn');
    const panel = document.getElementById('metrics-panel');
    const open = !lower.classList.contains('metrics-open');
    lower.classList.toggle('metrics-open', open);
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    btn.textContent = open ? '统计 ✓' : '统计';
    if (panel) panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) updateMetrics();
    // 等 grid 动画结束后再同步 canvas buffer + fitScale (避免过渡中 clientWidth≈0 导致比例爆炸)
    const gen = ++metricsLayoutGen;
    const finish = () => {
      if (gen !== metricsLayoutGen) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (gen !== metricsLayoutGen) return;
          if (!syncCurveEditors()) setTimeout(finish, 40);
        });
      });
    };
    const onEnd = (e) => {
      if (e.target !== lower) return;
      if (e.propertyName !== 'grid-template-columns' && e.propertyName !== 'gap') return;
      lower.removeEventListener('transitionend', onEnd);
      finish();
    };
    lower.addEventListener('transitionend', onEnd);
    setTimeout(() => { lower.removeEventListener('transitionend', onEnd); finish(); }, 450);
  });

  window.addEventListener('resize', resize);
  resize();
  loadDefaultSample().then(() => resize()).catch(err => toast('加载 test.avif 失败: ' + err.message));
}

/** 按 CSS 盒模型重设曲线 canvas 的 drawing buffer 并 fitScale。尺寸无效时返回 false。 */
function syncCurveEditors() {
  let ok = true;
  for (const ed of [gainEditor, satEditor]) {
    if (!ed) continue;
    const c = ed.canvas;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (cw < 32 || ch < 32) { ok = false; continue; }
    const bw = Math.max(1, Math.round(cw * 2));
    const bh = Math.max(1, Math.round(ch * 2));
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
    }
    ed.fitScale();
    ed.draw();
  }
  return ok;
}

let metricsLayoutGen = 0;

function buildDefaultGain() {
  const xs = CONFIG.X_GAIN, ys = CONFIG.Y_GAIN;
  const m = pchipSlopes(xs, ys);
  return xs.map((x, i) => ({ x, y: ys[i], m: m[i] }));
}
function buildDefaultSat() {
  const xs = CONFIG.X_SAT, ys = CONFIG.S_SAT;
  const m = pchipSlopes(xs, ys);
  return xs.map((x, i) => ({ x, y: ys[i], m: m[i] }));
}

function resize() {
  // 可用区域取自 cell（勿用 canvas.clientWidth：曾设 style 后会锁死宽度）
  const cells = document.querySelectorAll('.canvas-cell canvas');
  const first = cells[0];
  const cell = first.closest('.canvas-cell');
  const label = cell ? cell.querySelector('.canvas-label') : null;
  const labelH = label ? label.offsetHeight : 32;
  const availW = cell ? cell.clientWidth : (first.clientWidth || 294);
  const availH = cell ? Math.max(0, cell.clientHeight - labelH) : 0;
  let aspect = 1;
  if (state.imageBitmap) aspect = state.imageBitmap.width / state.imageBitmap.height;
  // 按宽高比 fit 进可用区域 (contain)
  let w = availW, h = availW / aspect;
  if (availH > 0 && h > availH) { h = availH; w = h * aspect; }
  renderer.resizeAll(w, h);
  syncCurveEditors();
  renderer.drawAll();
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ---- 重置曲线到初始状态 ----
function resetCurve(kind) {
  if (kind === 'gain') {
    if (!state.initialGainControlPoints) return;
    state.gainControlPoints = state.initialGainControlPoints.map(p => ({...p}));
    if (gainEditor) gainEditor.setPoints(state.gainControlPoints);
  } else {
    if (!state.initialSatControlPoints) return;
    state.satControlPoints = state.initialSatControlPoints.map(p => ({...p}));
    if (satEditor) satEditor.setPoints(state.satControlPoints);
  }
  rebuildMetadata();
  renderer.drawAll();
  updateMetrics();
}

// state 初始化默认控制点
state.gainControlPoints = buildDefaultGain();
state.satControlPoints = buildDefaultSat();
state.initialGainControlPoints = state.gainControlPoints.map(p => ({...p}));
state.initialSatControlPoints = state.satControlPoints.map(p => ({...p}));

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
