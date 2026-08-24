(() => {
  // src/pchip.js
  function pchipSlopes(xs, ys) {
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
    for (let i = 1; i < n - 1; i += 1) {
      const sPrev = s[i - 1];
      const sCurr = s[i];
      if (Math.sign(sPrev) !== Math.sign(sCurr) || sPrev === 0 || sCurr === 0) {
        m[i] = 0;
      } else {
        const w = (2 * h[i - 1] + h[i]) * sPrev + (h[i - 1] + 2 * h[i]) * sCurr;
        m[i] = 3 * (h[i - 1] + h[i]) * sPrev * sCurr / w;
      }
    }
    m[0] = ((2 * h[0] + h[1]) * s[0] - h[0] * s[1]) / (h[0] + h[1]);
    if (Math.sign(m[0]) !== Math.sign(s[0])) {
      m[0] = 0;
    } else if (Math.sign(s[0]) !== Math.sign(s[1]) && Math.abs(m[0]) > 3 * Math.abs(s[0])) {
      m[0] = 3 * s[0];
    }
    const last = n - 1;
    m[last] = ((2 * h[last - 1] + h[last - 2]) * s[last - 1] - h[last - 1] * s[last - 2]) / (h[last - 1] + h[last - 2]);
    if (Math.sign(m[last]) !== Math.sign(s[last - 1])) {
      m[last] = 0;
    } else if (Math.sign(s[last - 1]) !== Math.sign(s[last - 2]) && Math.abs(m[last]) > 3 * Math.abs(s[last - 1])) {
      m[last] = 3 * s[last - 1];
    }
    return m;
  }
  function buildControlPoints(xs, ys) {
    const slopes = pchipSlopes(xs, ys);
    return xs.map((x, i) => ({ x: Number(x), y: Number(ys[i]), m: slopes[i] }));
  }

  // src/gaincurve-metadata.js
  var CONFIG = {
    L_WHITE: 203,
    H_TARGET: 0,
    X_GAIN: [0, 0.5, 1, 1.75, 3, 4.5, 6.55],
    Y_GAIN: [0, 0, -0.152, -0.866, -1.6, -2.174, -2.711],
    X_SAT: [0, 0.3, 1, 2.89, 4.79, 7.4],
    S_SAT: [1, 1, 1, 0.95, 0.86, 0.63],
    K_NEW: { k_red: 0, k_green: 0, k_blue: 0, k_max: 1, k_min: 0, k_component: 0 },
    K_COUPLED: { k_red: 0, k_green: 0, k_blue: 0, k_max: 0.65, k_min: 0, k_component: 0.35 },
    PERCEPTION: "pq",
    LUMA_WEIGHTS: "p3"
  };
  var P3_CHROMATICITIES = [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329];
  var P3_LUMA_WEIGHTS = [0.229, 0.6917, 0.0793];
  function baselineHeadroom() {
    return Math.log2(CONFIG.X_GAIN[CONFIG.X_GAIN.length - 1]);
  }
  function buildMetadata(k, includeSaturation = true, baselineHdrHeadroomOverride = null) {
    const controlPoints = buildControlPoints(CONFIG.X_GAIN, CONFIG.Y_GAIN);
    const alternate = {
      hdrHeadroom: 0,
      colorGainFunction: {
        componentMix: {
          red: k.k_red,
          green: k.k_green,
          blue: k.k_blue,
          max: k.k_max,
          min: k.k_min,
          component: k.k_component
        },
        gainCurve: { controlPoints }
      }
    };
    if (includeSaturation) {
      alternate.colorGainFunction.saturationCurve = {
        controlPoints: buildControlPoints(CONFIG.X_SAT, CONFIG.S_SAT)
      };
    }
    return {
      hdrReferenceWhite: CONFIG.L_WHITE,
      headroomAdaptiveToneMap: {
        gainApplicationChromaticities: P3_CHROMATICITIES,
        baselineHdrHeadroom: baselineHdrHeadroomOverride ?? baselineHeadroom(),
        alternateImages: [alternate]
      }
    };
  }
  function newMethodMetadata(baselineHdrHeadroomOverride = null) {
    return buildMetadata(CONFIG.K_NEW, true, baselineHdrHeadroomOverride);
  }
  function coupledMethodMetadata(baselineHdrHeadroomOverride = null) {
    return buildMetadata(CONFIG.K_COUPLED, false, baselineHdrHeadroomOverride);
  }

  // src/metrics.js
  function primariesToXyz(rxy, gxy, bxy, wxy) {
    const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
    const Xr = xyz(rxy), Xg = xyz(gxy), Xb = xyz(bxy);
    const M = [
      [Xr[0], Xg[0], Xb[0]],
      [Xr[1], Xg[1], Xb[1]],
      [Xr[2], Xg[2], Xb[2]]
    ];
    const Wn = xyz(wxy);
    const S = solve3(M, Wn);
    return M.map((row, i) => row.map((v) => v * S[i]));
  }
  function solve3(M, b) {
    const det = m3det(M);
    const inv = [
      (b[0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (b[1] * M[2][2] - M[1][2] * b[2]) + M[0][2] * (b[1] * M[2][1] - M[1][1] * b[2])) / det,
      (M[0][0] * (b[1] * M[2][2] - M[1][2] * b[2]) - b[0] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * b[2] - b[1] * M[2][0])) / det,
      (M[0][0] * (M[1][1] * b[2] - b[1] * M[2][1]) - M[0][1] * (M[1][0] * b[2] - b[1] * M[2][0]) + b[0] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det
    ];
    return inv;
  }
  function m3det(M) {
    return M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  }
  var P3_R = [0.68, 0.32];
  var P3_G = [0.265, 0.69];
  var P3_B = [0.15, 0.06];
  var D65 = [0.3127, 0.329];
  var M_P3_XYZ = primariesToXyz(P3_R, P3_G, P3_B, D65);
  var LUMA_W = [M_P3_XYZ[1][0], M_P3_XYZ[1][1], M_P3_XYZ[1][2]].map((v) => v);
  var LUMA_W_NORM = (() => {
    const s = LUMA_W.reduce((a, b) => a + b, 0);
    return LUMA_W.map((v) => v / s);
  })();
  var _m1 = 2610 / 16384;
  var _m2 = 2523 / 4096 * 128;
  var _c1 = 3424 / 4096;
  var _c2 = 2413 / 4096 * 32;
  var _c3 = 2392 / 4096 * 32;
  function pqEotf(E) {
    const e = Math.min(Math.max(E, 0), 1);
    const ep = Math.pow(e, 1 / _m2);
    const num = Math.max(ep - _c1, 0);
    const den = _c2 - _c3 * ep;
    return 1e4 * Math.pow(num / den, 1 / _m1);
  }
  function pqOetf(L) {
    const ln = Math.min(Math.max(L, 0), 1e4) / 1e4;
    const lm = Math.pow(ln, _m1);
    return Math.pow((_c1 + _c2 * lm) / (1 + _c3 * lm), _m2);
  }
  function fPerception(C, mode, lWhite) {
    if (mode === 0) return pqOetf(Math.min(Math.max(C * lWhite, 0), 1e4));
    if (mode === 1) return Math.pow(Math.max(C, 0), 1 / 2.4);
    if (mode === 2) return Math.log2(Math.max(C, 1e-6));
    return C;
  }
  function fPerceptionInv(P, mode, lWhite) {
    if (mode === 0) return pqEotf(Math.min(Math.max(P, 0), 1)) / lWhite;
    if (mode === 1) return Math.pow(Math.max(P, 0), 2.4);
    if (mode === 2) return Math.pow(2, P);
    return P;
  }
  function evaluateCurve(x, cps, log2Extrap) {
    const n = cps.length;
    if (x <= cps[0].x) return cps[0].y;
    if (x >= cps[n - 1].x) {
      if (log2Extrap) return cps[n - 1].y + Math.log2(cps[n - 1].x / Math.max(x, 1e-12));
      return cps[n - 1].y;
    }
    let i = 0;
    while (i < n - 1 && !(cps[i].x <= x && x <= cps[i + 1].x)) i++;
    const x0 = cps[i].x, x1 = cps[i + 1].x, y0 = cps[i].y, y1 = cps[i + 1].y;
    const m0 = cps[i].m, m1 = cps[i + 1].m;
    const h = x1 - x0, t = (x - x0) / h;
    const mh0 = m0 * h, mh1 = m1 * h;
    const c3 = 2 * y0 + mh0 - 2 * y1 + mh1, c2 = -3 * y0 + 3 * y1 - 2 * mh0 - mh1, c1 = mh0, c0 = y0;
    return ((c3 * t + c2) * t + c1) * t + c0;
  }
  function fCommon(C, k) {
    const cr = C[0], cg = C[1], cb = C[2];
    const cmax = Math.max(...C), cmin = Math.min(...C);
    return cr * k.k_red + cg * k.k_green + cb * k.k_blue + cmax * k.k_max + cmin * k.k_min;
  }
  function applySaturation(Cout, S, mode, lWhite) {
    const Y = Cout[0] * LUMA_W_NORM[0] + Cout[1] * LUMA_W_NORM[1] + Cout[2] * LUMA_W_NORM[2];
    const grey = [Y, Y, Y];
    const P = [
      S * fPerception(Cout[0], mode, lWhite) + (1 - S) * fPerception(grey[0], mode, lWhite),
      S * fPerception(Cout[1], mode, lWhite) + (1 - S) * fPerception(grey[1], mode, lWhite),
      S * fPerception(Cout[2], mode, lWhite) + (1 - S) * fPerception(grey[2], mode, lWhite)
    ];
    return [fPerceptionInv(P[0], mode, lWhite), fPerceptionInv(P[1], mode, lWhite), fPerceptionInv(P[2], mode, lWhite)];
  }
  function linearP3ToLab(C) {
    const X = C[0] * M_P3_XYZ[0][0] + C[1] * M_P3_XYZ[0][1] + C[2] * M_P3_XYZ[0][2];
    const Y = C[0] * M_P3_XYZ[1][0] + C[1] * M_P3_XYZ[1][1] + C[2] * M_P3_XYZ[1][2];
    const Z = C[0] * M_P3_XYZ[2][0] + C[1] * M_P3_XYZ[2][1] + C[2] * M_P3_XYZ[2][2];
    const W = M_P3_XYZ;
    const Xn = W[0][0] + W[0][1] + W[0][2], Yn = W[1][0] + W[1][1] + W[1][2], Zn = W[2][0] + W[2][1] + W[2][2];
    const f = (t) => {
      const d = 6 / 29;
      return t > d ** 3 ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
    };
    const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function hueAngleDeg(C) {
    const [, a, b] = linearP3ToLab(C);
    return Math.degrees ? Math.degrees(Math.atan2(b, a)) : Math.atan2(b, a) * 180 / Math.PI;
  }
  function hueDiff(h1, h2) {
    let d = (h1 - h2 + 180) % 360 - 180;
    if (d < -180) d += 360;
    return Math.abs(d);
  }
  function transformPixel(Cin, w, gainCps, satCps, useCoupled, mode, lWhite) {
    const k = useCoupled ? CONFIG.K_COUPLED : CONFIG.K_NEW;
    const fc = fCommon(Cin, k);
    let C1;
    if (!useCoupled) {
      const G = evaluateCurve(fc, gainCps, true);
      C1 = Cin.map((v) => v * Math.pow(2, w * G));
    } else {
      const M = Cin.map((v) => v * k.k_component + fc);
      const G = M.map((m) => evaluateCurve(m, gainCps, true));
      C1 = Cin.map((v, i) => v * Math.pow(2, w * G[i]));
    }
    const S_total = useCoupled ? 1 : (1 - w) * 1 + w * evaluateCurve(fc, satCps, true);
    return applySaturation(C1, S_total, mode, lWhite);
  }
  function prepareImageSamples(rawFloat, width, height, lWhite) {
    const n = width * height;
    const samples = new Array(n);
    const Yf = (C) => C[0] * LUMA_W_NORM[0] + C[1] * LUMA_W_NORM[1] + C[2] * LUMA_W_NORM[2];
    for (let i = 0; i < n; i++) {
      const off = i * 4;
      const E = [rawFloat[off], rawFloat[off + 1], rawFloat[off + 2]];
      const Cin = E.map((e) => pqEotf(Math.min(Math.max(e, 0), 1)) / lWhite);
      const [, a0, b0] = linearP3ToLab(Cin);
      samples[i] = { Cin, h0: hueAngleDeg(Cin), chroma: Math.hypot(a0, b0), Yin: Yf(Cin) };
    }
    return samples;
  }
  function computeImageMetrics(state2) {
    const samples = state2.imageSamples;
    const gainCps = state2.gainControlPoints;
    const satCps = state2.satControlPoints;
    if (!samples || !samples.length || !gainCps || !satCps) return null;
    const mode = state2.perceptionMode;
    const lWhite = state2.diffuseWhite;
    const hBase = state2.hBaseline ?? Math.log2(CONFIG.X_GAIN[CONFIG.X_GAIN.length - 1]);
    const w = (state2.hTarget - hBase) / (0 - hBase);
    const Yf = (C) => C[0] * LUMA_W_NORM[0] + C[1] * LUMA_W_NORM[1] + C[2] * LUMA_W_NORM[2];
    const methods = [
      { key: "new", useCoupled: false, hueAltW: 0, hueTgtW: 0, lumAltSum: 0, lumTgtSum: 0 },
      { key: "coupled", useCoupled: true, hueAltW: 0, hueTgtW: 0, lumAltSum: 0, lumTgtSum: 0 }
    ];
    let chromaSum = 0;
    for (const s of samples) {
      const { Cin, h0, chroma, Yin } = s;
      const fcRef = fCommon(Cin, CONFIG.K_NEW);
      const Gref = evaluateCurve(fcRef, gainCps, true);
      const YintendedAlt = Yin * Math.pow(2, 1 * Gref);
      const YintendedTgt = Yin * Math.pow(2, w * Gref);
      for (const m of methods) {
        const Calt = transformPixel(Cin, 1, gainCps, satCps, m.useCoupled, mode, lWhite);
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
        targetLumPct: m.lumTgtSum / n
      };
    }
    return result;
  }

  // src/main.js
  var vs = `#version 300 es
precision highp float;
in vec2 position;
out vec2 texcoord;
void main() {
  texcoord = vec2(0.5+0.5*position.x, 0.5-0.5*position.y);
  gl_Position = vec4(position, 0.0, 1.0);
}`;
  var fs = `#version 300 es
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
    // \u67E5 S \u7528\u539F\u56FE C, \u9000\u767D\u4F5C\u7528\u5728\u589E\u76CA\u540E\u7684 C_out
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
  var state = {
    diffuseWhite: 203,
    // L_DW, 固定 203 (内容元数据, 非滑块)
    hTarget: 0,
    // H_target 滑块值 (目标显示 headroom, 0=SDR)
    hBaseline: null,
    // H_base, 来自加载图像自带的元数据 (如 cow.json 的 baselineHdrHeadroom); 未加载时退回 CONFIG 默认
    perceptionMode: 0,
    // 0=pq
    coupled: false,
    // Target/Alternate 用耦合法?
    metadataNew: null,
    metadataCoupled: null,
    imageBitmap: null,
    contentTransfer: 16,
    // kTransferPQ
    contentPrimaries: 12,
    // kPrimariesP3 (test.avif)
    gainControlPoints: null,
    // [{x,y,m}]
    satControlPoints: null,
    imageSamples: null,
    // 图像加载时预算好的采样点 [{Cin,h0,chroma,Yin}], 供 Metrics.computeImageMetrics 复用
    initialGainControlPoints: null,
    // 用于"重置"按钮: 加载图像时的原始曲线快照
    initialSatControlPoints: null
  };
  function currentHBaseline() {
    return state.hBaseline ?? baselineHeadroom();
  }
  var MultiCanvasRenderer = class {
    constructor(canvasIds) {
      this.renderers = {};
      for (const [key, id] of Object.entries(canvasIds)) {
        const c = document.getElementById(id);
        const gl = c.getContext("webgl2");
        gl.getExtension("EXT_color_buffer_half_float");
        gl.getExtension("EXT_color_buffer_float");
        let hasHdrCanvas = false;
        try {
          c.configureHighDynamicRange({ mode: "extended" });
          hasHdrCanvas = true;
        } catch (e) {
        }
        this.renderers[key] = { canvas: c, gl, program: compileShader(gl, vs, fs), tex: null, tmNew: null, tmCoupled: null, fbPrim: "drawingBufferColorSpace" in gl ? 12 : 1, hasHdrCanvas };
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
        const realloc = r.tex_w !== bitmap.width || r.tex_h !== bitmap.height;
        if (realloc) {
          r.tex = gl.createTexture();
          r.tex_w = bitmap.width;
          r.tex_h = bitmap.height;
        }
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
        r.canvas.width = fw;
        r.canvas.height = fh;
        r.canvas.style.width = w + "px";
        r.canvas.style.height = h + "px";
        try {
          r.gl.drawingBufferStorage(r.gl.RGBA16F, fw, fh);
        } catch (e) {
        }
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
      if (!r.tex) {
        gl.clearBufferfv(gl.COLOR, 0, [0.05, 0.05, 0.06, 1]);
        return;
      }
      const metadata = useCoupled ? state.metadataCoupled : state.metadataNew;
      const toneMapper = useCoupled ? r.tmCoupled : r.tmNew;
      if (!metadata || !toneMapper) return;
      if (H === "baseline") H = metadata.headroomAdaptiveToneMap.baselineHdrHeadroom;
      gl.useProgram(r.program);
      gl.viewport(0, 0, r.canvas.width, r.canvas.height);
      gl.clearBufferfv(gl.COLOR, 0, [0.05, 0.05, 0.06, 1]);
      const verts = gl.createBuffer();
      const idx = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, verts);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
      const posLoc = gl.getAttribLocation(r.program, "position");
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(posLoc);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, r.tex);
      gl.uniform1i(gl.getUniformLocation(r.program, "content"), 0);
      gl.uniform1i(gl.getUniformLocation(r.program, "framebuffer_trfn"), 13);
      gl.uniform1f(gl.getUniformLocation(r.program, "target_log2_headroom"), H);
      gl.uniform1f(gl.getUniformLocation(r.program, "linear_scale"), 1);
      gl.uniform1i(gl.getUniformLocation(r.program, "texture_trfn"), state.contentTransfer);
      gl.uniform3f(gl.getUniformLocation(r.program, "texture_primaries_Y"), 0.2627, 0.678, 0.0593);
      gl.uniformMatrix3fv(
        gl.getUniformLocation(r.program, "primary_matrix_texture_to_gain"),
        false,
        uwaRgbConversionMatrixColMajor(uwaColorSpaceChromaticities(state.contentPrimaries), metadata.headroomAdaptiveToneMap.gainApplicationChromaticities)
      );
      gl.uniformMatrix3fv(
        gl.getUniformLocation(r.program, "primary_matrix_gain_to_framebuffer"),
        false,
        uwaRgbConversionMatrixColMajor(metadata.headroomAdaptiveToneMap.gainApplicationChromaticities, uwaColorSpaceChromaticities(r.fbPrim))
      );
      gl.uniform1f(gl.getUniformLocation(r.program, "hdrReferenceWhite"), state.diffuseWhite);
      gl.uniform3f(gl.getUniformLocation(r.program, "luma_weights"), P3_LUMA_WEIGHTS[0], P3_LUMA_WEIGHTS[1], P3_LUMA_WEIGHTS[2]);
      gl.uniform1i(gl.getUniformLocation(r.program, "perception_mode"), state.perceptionMode);
      gl.uniform1i(gl.getUniformLocation(r.program, "apply_saturation"), 1);
      toneMapper.setUniforms(H, r.program, 2);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }
    drawAll() {
      this.drawView("base", "baseline", state.coupled);
      this.drawView("target", state.hTarget, state.coupled);
      this.drawView("alt", 0, state.coupled);
    }
  };
  var renderer = null;
  function rebuildMetadata() {
    const hBaseOverride = currentHBaseline();
    const metaNew = newMethodMetadata(hBaseOverride);
    const metaCoupled = coupledMethodMetadata(hBaseOverride);
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
  function sampleBitmapForMetrics(bitmap, sampleSize = 64) {
    const canvas = new OffscreenCanvas(sampleSize, sampleSize);
    const gl = canvas.getContext("webgl2");
    gl.getExtension("EXT_color_buffer_half_float");
    gl.getExtension("EXT_color_buffer_float");
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
    gl.generateMipmap(gl.TEXTURE_2D);
    let level = 0, w = fullW, h = fullH;
    while (w > sampleSize && h > sampleSize && level < 20) {
      level++;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
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
      state.imageSamples = prepareImageSamples(data, width, height, state.diffuseWhite);
    } catch (err) {
      console.warn("\u56FE\u50CF\u91C7\u6837\u5931\u8D25 (\u6307\u6807\u5C06\u4E0D\u53EF\u7528):", err);
      state.imageSamples = null;
    }
  }
  async function loadImage(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
    state.imageBitmap = bitmap;
    renderer.setImage(bitmap);
    updateImageSamples(bitmap);
    renderer.drawAll();
    updateMetrics();
  }
  async function loadDefaultSample() {
    state.hBaseline = baselineHeadroom();
    state.contentPrimaries = 12;
    state.contentTransfer = 16;
    rebuildMetadata();
    const th = document.getElementById("target-headroom");
    if (th) th.max = String(Math.round(state.hBaseline * 100));
    if (window.__GAINCURVE_SAMPLE__?.avifBase64) {
      const bin = atob(window.__GAINCURVE_SAMPLE__.avifBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/avif" });
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
      state.imageBitmap = bitmap;
      renderer.setImage(bitmap);
      updateImageSamples(bitmap);
      renderer.drawAll();
      updateMetrics();
    } else {
      await loadImage("data/test.avif");
    }
  }
  var CurveEditor = class {
    constructor(canvas, kind) {
      this.canvas = canvas;
      this.kind = kind;
      this.ctx = canvas.getContext("2d");
      this.points = [];
      this.dragIndex = -1;
      this.viewOffset = { x: 50, y: canvas.height - 40 };
      this.viewScale = { x: 0, y: 0 };
      canvas.addEventListener("mousedown", (e) => this.onDown(e));
      canvas.addEventListener("mousemove", (e) => this.onMove(e));
      window.addEventListener("mouseup", () => this.dragIndex = -1);
      canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));
      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.zoom(e);
      }, { passive: false });
    }
    setPoints(pts) {
      this.points = pts.map((p) => ({ ...p }));
      this.fitScale();
      this.draw();
    }
    fitScale() {
      const xs = this.points.map((p) => p.x);
      const ys = this.points.map((p) => p.y);
      const xMax = Math.max(...xs, 1) * 1.08;
      const yMin = Math.min(...ys, this.kind === "gain" ? -3 : 0);
      const yMax = Math.max(...ys, this.kind === "gain" ? 1 : 1.2);
      this.xMax = xMax;
      this.yMin = yMin;
      this.yMax = yMax;
      this.viewScale.x = (this.canvas.width - 80) / xMax;
      this.viewScale.y = -(this.canvas.height - 80) / Math.max(yMax - yMin, 0.1);
      this.viewOffset.y = this.canvas.height - 40 - this.viewScale.y * yMin;
    }
    toView(p) {
      return { x: this.viewOffset.x + this.viewScale.x * p.x, y: this.viewOffset.y + this.viewScale.y * p.y };
    }
    toModel(vx, vy) {
      return { x: (vx - this.viewOffset.x) / this.viewScale.x, y: (vy - this.viewOffset.y) / this.viewScale.y };
    }
    draw() {
      const c = this.ctx;
      c.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const xMax = this.xMax ?? 8, yMin = this.yMin ?? -3, yMax = this.yMax ?? 1;
      const N_X = 8, N_Y = 5;
      c.font = "11px monospace";
      for (let i = 0; i <= N_X; i++) {
        const mx = xMax * i / N_X;
        const vx = this.toView({ x: mx, y: 0 }).x;
        c.strokeStyle = "#ffffff15";
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(vx, 0);
        c.lineTo(vx, this.canvas.height - 18);
        c.stroke();
        c.fillStyle = "#8b90a0";
        c.textAlign = i === 0 ? "left" : i === N_X ? "right" : "center";
        c.fillText(mx.toFixed(2), vx, this.canvas.height - 4);
      }
      c.textAlign = "left";
      for (let j = 0; j <= N_Y; j++) {
        const my = yMin + (yMax - yMin) * j / N_Y;
        const vy = this.toView({ x: 0, y: my }).y;
        c.strokeStyle = "#ffffff15";
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(46, vy);
        c.lineTo(this.canvas.width, vy);
        c.stroke();
        c.fillStyle = "#8b90a0";
        c.fillText(my.toFixed(2), 4, vy + 4);
      }
      const p1 = this.toView({ x: 1, y: 0 });
      c.strokeStyle = "#3a8";
      c.lineWidth = 2;
      c.setLineDash([6, 6]);
      c.beginPath();
      c.moveTo(p1.x, 0);
      c.lineTo(p1.x, this.canvas.height - 18);
      c.stroke();
      c.setLineDash([]);
      const p0 = this.toView({ x: 0, y: 0 });
      if (p0.y >= 0 && p0.y <= this.canvas.height - 18) {
        c.strokeStyle = "#ffffff50";
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(46, p0.y);
        c.lineTo(this.canvas.width, p0.y);
        c.stroke();
      }
      const color = this.kind === "gain" ? "#4d9fff" : "#b06bff";
      c.strokeStyle = color;
      c.lineWidth = 3;
      c.beginPath();
      const pc = new UwaHermiteCurve(this.points.map((p) => ({ ...p })));
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
        if (!started) {
          c.moveTo(vp.x, vp.y);
          started = true;
        } else c.lineTo(vp.x, vp.y);
      }
      c.stroke();
      c.fillStyle = "#ff5d5d";
      for (let i = 0; i < this.points.length; i++) {
        const p = this.points[i];
        const vp = this.toView(p);
        c.beginPath();
        c.arc(vp.x, vp.y, 7, 0, 2 * Math.PI);
        c.fill();
        c.fillStyle = "#fff";
        c.font = "12px monospace";
        const label = `(${p.x.toFixed(2)},${p.y.toFixed(2)})`;
        const nearRight = i === this.points.length - 1;
        if (nearRight) {
          c.textAlign = "right";
          c.fillText(label, vp.x - 10, vp.y - 8);
          c.textAlign = "left";
        } else {
          c.fillText(label, vp.x + 10, vp.y - 8);
        }
        c.fillStyle = "#ff5d5d";
      }
    }
    hitTest(pos) {
      let best = -1, bestD = 14 * 14;
      for (let i = 0; i < this.points.length; i++) {
        const vp = this.toView(this.points[i]);
        const d = (vp.x - pos.x) ** 2 + (vp.y - pos.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
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
        toast("\u81F3\u5C11\u4FDD\u7559 2 \u4E2A\u63A7\u5236\u70B9");
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
      this.viewScale.x *= f;
      this.viewScale.y *= f;
      this.draw();
    }
    recomputeSlopes() {
      const xs = this.points.map((p) => p.x);
      const ys = this.points.map((p) => p.y);
      const m = pchipSlopes(xs, ys);
      this.points.forEach((p, i) => p.m = m[i]);
    }
    onChanged() {
      if (this.kind === "gain") state.gainControlPoints = this.points.map((p) => ({ ...p }));
      else state.satControlPoints = this.points.map((p) => ({ ...p }));
      rebuildMetadata();
      renderer.drawAll();
      updateMetrics();
      this.draw();
    }
  };
  var gainEditor = null;
  var satEditor = null;
  function updateMetrics() {
    const tbody = document.querySelector("#metrics-table tbody");
    const m = computeImageMetrics(state);
    if (!m) {
      tbody.innerHTML = "<tr><td colspan=4>\u52A0\u8F7D\u56FE\u50CF\u540E\u663E\u793A</td></tr>";
      return;
    }
    const row = (method, label, hue, lum) => `<tr><td>${method}</td><td>${label}</td><td>${hue.toFixed(2)}\xB0</td><td>${lum.toFixed(2)}%</td></tr>`;
    tbody.innerHTML = `
    ${row("\u65B0\u6CD5", "Alt vs Base", m.new.altHueDeg, m.new.altLumPct)}
    ${row("\u65B0\u6CD5", "Target vs Base", m.new.targetHueDeg, m.new.targetLumPct)}
    ${row("2094-50", "Alt vs Base", m.coupled.altHueDeg, m.coupled.altLumPct)}
    ${row("2094-50", "Target vs Base", m.coupled.targetHueDeg, m.coupled.targetLumPct)}
  `;
    const note = document.getElementById("metrics-note");
    const hBase = currentHBaseline();
    const w = (state.hTarget - hBase) / (0 - hBase);
    note.textContent = `\u91C7\u6837=${m.sampleCount}px \xB7 perception=${["pq", "gamma", "log2", "linear"][state.perceptionMode]} \xB7 H_base=${hBase.toFixed(2)} \xB7 H_alt=0 \xB7 H_target=${state.hTarget.toFixed(2)} \xB7 w=${w.toFixed(3)}`;
  }
  async function handleImageFile(file) {
    try {
      const bitmap = await createImageBitmap(file, { colorSpaceConversion: "none" });
      state.imageBitmap = bitmap;
      renderer.setImage(bitmap);
      updateImageSamples(bitmap);
      resize();
      renderer.drawAll();
      updateMetrics();
      toast(`\u5DF2\u52A0\u8F7D ${file.name}`);
    } catch (err) {
      toast(`\u52A0\u8F7D\u5931\u8D25: ${err?.message || err}`);
      console.error("handleImageFile", err);
    }
  }
  function init() {
    renderer = new MultiCanvasRenderer({ base: "base-canvas", target: "target-canvas", alt: "alt-canvas" });
    gainEditor = new CurveEditor(document.getElementById("gain-editor"), "gain");
    satEditor = new CurveEditor(document.getElementById("sat-editor"), "sat");
    gainEditor.setPoints(state.gainControlPoints || buildDefaultGain());
    satEditor.setPoints(state.satControlPoints || buildDefaultSat());
    rebuildMetadata();
    const th = document.getElementById("target-headroom");
    th.addEventListener("input", () => {
      state.hTarget = Number(th.value) / 100;
      document.getElementById("target-headroom-val").textContent = state.hTarget.toFixed(2);
      renderer.drawAll();
      updateMetrics();
    });
    document.getElementById("perception-mode").addEventListener("change", (e) => {
      state.perceptionMode = Number(e.target.value);
      renderer.drawAll();
      updateMetrics();
    });
    document.getElementById("coupled-toggle").addEventListener("change", (e) => {
      state.coupled = e.target.checked;
      renderer.drawAll();
      updateMetrics();
    });
    document.getElementById("gain-reset-btn")?.addEventListener("click", () => resetCurve("gain"));
    document.getElementById("sat-reset-btn")?.addEventListener("click", () => resetCurve("sat"));
    document.getElementById("upload-btn").addEventListener("click", () => document.getElementById("file-input").click());
    document.getElementById("file-input").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      await handleImageFile(f);
      e.target.value = "";
    });
    const dropZone = document.body;
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    dropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) await handleImageFile(f);
    });
    document.getElementById("save-btn").addEventListener("click", () => {
      const c = document.getElementById("target-canvas");
      const a = document.createElement("a");
      a.download = "target.png";
      a.href = c.toDataURL("image/png");
      a.click();
    });
    document.getElementById("metrics-btn")?.addEventListener("click", () => {
      const lower = document.querySelector(".lower");
      const btn = document.getElementById("metrics-btn");
      const panel = document.getElementById("metrics-panel");
      const open = !lower.classList.contains("metrics-open");
      lower.classList.toggle("metrics-open", open);
      btn.setAttribute("aria-pressed", open ? "true" : "false");
      btn.textContent = open ? "\u7EDF\u8BA1 \u2713" : "\u7EDF\u8BA1";
      if (panel) panel.setAttribute("aria-hidden", open ? "false" : "true");
      if (open) updateMetrics();
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
        if (e.propertyName !== "grid-template-columns" && e.propertyName !== "gap") return;
        lower.removeEventListener("transitionend", onEnd);
        finish();
      };
      lower.addEventListener("transitionend", onEnd);
      setTimeout(() => {
        lower.removeEventListener("transitionend", onEnd);
        finish();
      }, 450);
    });
    window.addEventListener("resize", resize);
    resize();
    loadDefaultSample().then(() => resize()).catch((err) => toast("\u52A0\u8F7D test.avif \u5931\u8D25: " + err.message));
  }
  function syncCurveEditors() {
    let ok = true;
    for (const ed of [gainEditor, satEditor]) {
      if (!ed) continue;
      const c = ed.canvas;
      const cw = c.clientWidth, ch = c.clientHeight;
      if (cw < 32 || ch < 32) {
        ok = false;
        continue;
      }
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
  var metricsLayoutGen = 0;
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
    const cells = document.querySelectorAll(".canvas-cell canvas");
    const first = cells[0];
    const cell = first.closest(".canvas-cell");
    const label = cell ? cell.querySelector(".canvas-label") : null;
    const labelH = label ? label.offsetHeight : 32;
    const availW = cell ? cell.clientWidth : first.clientWidth || 294;
    const availH = cell ? Math.max(0, cell.clientHeight - labelH) : 0;
    let aspect = 1;
    if (state.imageBitmap) aspect = state.imageBitmap.width / state.imageBitmap.height;
    let w = availW, h = availW / aspect;
    if (availH > 0 && h > availH) {
      h = availH;
      w = h * aspect;
    }
    renderer.resizeAll(w, h);
    syncCurveEditors();
    renderer.drawAll();
  }
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 3e3);
  }
  function resetCurve(kind) {
    if (kind === "gain") {
      if (!state.initialGainControlPoints) return;
      state.gainControlPoints = state.initialGainControlPoints.map((p) => ({ ...p }));
      if (gainEditor) gainEditor.setPoints(state.gainControlPoints);
    } else {
      if (!state.initialSatControlPoints) return;
      state.satControlPoints = state.initialSatControlPoints.map((p) => ({ ...p }));
      if (satEditor) satEditor.setPoints(state.satControlPoints);
    }
    rebuildMetadata();
    renderer.drawAll();
    updateMetrics();
  }
  state.gainControlPoints = buildDefaultGain();
  state.satControlPoints = buildDefaultSat();
  state.initialGainControlPoints = state.gainControlPoints.map((p) => ({ ...p }));
  state.initialSatControlPoints = state.satControlPoints.map((p) => ({ ...p }));
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
