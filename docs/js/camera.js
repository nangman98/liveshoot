// 카메라 JPEG 맞춤 (Camera Match): RAW를 카메라가 만든 JPEG의 색감에서 시작하게 한다.
// RAW 안에 든 카메라 JPEG를 96 px로 줄여 같은 크기로 줄인 센서값과 짝지은 뒤
// 색 matrix · hue/sat 표 · 톤 곡선(32점) · 채도 곡선(8점)을 맞춘다. 출력 화소는 언제나 RAW 센서값에서 나온다.
//
// LightCraft (https://github.com/storytold/lightcraft, MIT OR Apache-2.0, © the LightCraft authors)의
// crates/engine/src/camera_preview.rs · crates/pipeline/src/tone.rs · crates/raw/src/profile.rs ·
// crates/color/src/lib.rs를 JavaScript로 옮겼다 (커밋 23e1812, 2026-10-22). 상수와 채택 문턱도 그대로다.
// 설명은 그 저장소의 docs/camera-preview-colour.md. 옮기지 않은 것: 부분 룩(fit_partial), 흑백 JPEG 톤,
// 아주 어두운 장면의 톤만 맞춤, Sony DRO 곡선 낮추기(여기서는 카메라 JPEG 그대로를 목표로 함), 렌즈 왜곡 맞춤.

// ---------- 색 공간 (crates/color) ----------

const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
const D65 = [0.3127, 0.3290], D50 = [0.3457, 0.3585];
const SPACES = {
  srgb: { r: [0.64, 0.33], g: [0.30, 0.60], b: [0.15, 0.06], w: D65 },
  rec2020: { r: [0.708, 0.292], g: [0.170, 0.797], b: [0.131, 0.046], w: D65 },
  prophoto: { r: [0.734699, 0.265301], g: [0.159597, 0.840403], b: [0.036598, 0.000105], w: D50 },
  adobe: { r: [0.64, 0.33], g: [0.21, 0.71], b: [0.15, 0.06], w: D65 },
};
export const M3 = {
  mul: (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j])),
  apply: (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]],
  diag: (a, b, c) => [[a, 0, 0], [0, b, 0], [0, 0, c]],
  inv(m) {
    const [[a, b, c], [d, e, f], [g, h, i]] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    if (!isFinite(det) || Math.abs(det) < 1e-300) return null;
    return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
  },
};
function toXYZ(s) {
  const p = [xyz(s.r), xyz(s.g), xyz(s.b)];
  const m = [[p[0][0], p[1][0], p[2][0]], [p[0][1], p[1][1], p[2][1]], [p[0][2], p[1][2], p[2][2]]];
  const k = M3.apply(M3.inv(m), xyz(s.w));
  return M3.mul(m, M3.diag(k[0], k[1], k[2]));
}
const fromXYZ = (s) => M3.inv(toXYZ(s));
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
function bradford(src, dst) {
  const s = M3.apply(BRADFORD, xyz(src)), d = M3.apply(BRADFORD, xyz(dst));
  return M3.mul(M3.mul(M3.inv(BRADFORD), M3.diag(d[0] / s[0], d[1] / s[1], d[2] / s[2])), BRADFORD);
}
/** 선형 sRGB → 선형 Rec.2020 (작업 공간), 그 반대, Rec.2020 → ProPhoto(D50) */
export const SRGB_2020 = M3.mul(fromXYZ(SPACES.rec2020), toXYZ(SPACES.srgb));
export const REC2020_SRGB = M3.inv(SRGB_2020);
export const ADOBE_2020 = M3.mul(fromXYZ(SPACES.rec2020), toXYZ(SPACES.adobe));
export const TO_PROPHOTO = M3.mul(M3.mul(fromXYZ(SPACES.prophoto), bradford(D65, D50)), toXYZ(SPACES.rec2020));
export const FROM_PROPHOTO = M3.inv(TO_PROPHOTO);
const luma = (p) => p[0] * 0.2627 + p[1] * 0.6780 + p[2] * 0.0593;
export const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/**
 * LibRaw(dcraw) 기본 출력 감마(BT.709: 0.45, 4.5)의 역함수. libraw-wasm은 gamm 설정을 무시하므로
 * 16비트 출력값을 선형으로 되돌릴 때 쓴다 (dcraw gamma_curve의 계수 계산을 그대로 옮김).
 */
export function libraw709() {
  const g = [0.45, 4.5, 0, 0, 0], bnd = [0, 1];
  for (let i = 0; i < 48; i++) {
    g[2] = (bnd[0] + bnd[1]) / 2;
    bnd[(Math.pow(g[2] / g[1], -g[0]) - 1) / g[0] - 1 / g[2] > -1 ? 1 : 0] = g[2];
  }
  g[3] = g[2] / g[1];
  g[4] = g[2] * (1 / g[0] - 1);
  return (y) => (y < g[2] ? y / g[1] : Math.pow((y + g[4]) / (1 + g[4]), 1 / g[0]));
}

// ---------- 톤 곡선 (crates/pipeline/src/tone.rs) ----------

const GREY = 0.18, LUT_MIN_EV = -14, LUT_MAX_EV = 10;
export const LUT_N = 4096, CHROMA_N = 8;

/** 장면 휘도 → 화면 휘도 32점 곡선 + 화면 휘도별 채도 배율 8점. 끝점 너머는 부드러운 어깨 */
export class CameraTone {
  static make(knots, chroma = new Array(CHROMA_N).fill(1)) {
    // Rust처럼 f32로 먼저 바꾼 뒤 검사 (바꾸면서 같은 값이 된 점을 통과시키지 않게)
    knots = knots.map((k) => [Math.fround(k[0]), Math.fround(k[1])]);
    chroma = chroma.map(Math.fround);
    let prev = [0, 0];
    for (const p of knots) {
      if (!p.every(isFinite) || p[0] <= prev[0] || p[1] < prev[1] || p[1] >= 1) return null;
      prev = p;
    }
    if (chroma.length !== CHROMA_N || !chroma.every((k) => isFinite(k) && k >= 0 && k <= 4)) return null;
    const t = new CameraTone();
    t.knots = knots;
    t.chroma = chroma;
    return t;
  }
  withChroma(c) { return CameraTone.make(this.knots, c); }
  apply(y) {
    if (!isFinite(y) || y <= 0) return 0;
    let prev = [0, 0];
    for (const p of this.knots) {
      if (y <= p[0]) return prev[1] + (y - prev[0]) / (p[0] - prev[0]) * (p[1] - prev[1]);
      prev = p;
    }
    const a = this.knots[30], b = this.knots[31];
    const slope = Math.min(16, Math.max(0.1, (b[1] - a[1]) / (b[0] - a[0])));
    return 1 - (1 - b[1]) * Math.exp(-(y - b[0]) * slope / Math.max(1 - b[1], 0.01));
  }
}

/** 휘도 톤 표 (EV −14…10, 4096칸). camera(곡선) 또는 neutral(기본 곡선: 룩이 없을 때와 비교용) */
export class ToneMap {
  static camera(curve) {
    const t = new ToneMap();
    t.lut = new Float32Array(LUT_N);
    for (let i = 0; i < LUT_N; i++) t.lut[i] = curve.apply(GREY * Math.pow(2, LUT_MIN_EV + (LUT_MAX_EV - LUT_MIN_EV) * i / (LUT_N - 1)));
    t.chroma = curve.chroma;
    return t;
  }
  static neutral() {
    const t = new ToneMap(), wl = GREY * Math.pow(2, 2.9), pre = 1 + GREY / wl;
    t.lut = new Float32Array(LUT_N);
    for (let i = 0; i < LUT_N; i++) {
      const y = GREY * Math.pow(2, LUT_MIN_EV + (LUT_MAX_EV - LUT_MIN_EV) * i / (LUT_N - 1)) * pre;
      t.lut[i] = Math.min(1, Math.max(0, Math.min(1, y * (1 + y / (wl * wl)) / (1 + y))));
    }
    t.chroma = new Array(CHROMA_N).fill(1);
    return t;
  }
  chromaScale(o) {
    if (!isFinite(o)) return 1;
    const f = Math.min(1, Math.max(0, o)) * (CHROMA_N - 1), i = Math.min(Math.floor(f), CHROMA_N - 2), t = f - i;
    const a = this.chroma[i], b = this.chroma[i + 1];
    return a === b ? a : a + (b - a) * t;
  }
  apply(y) {
    if (y <= 0) return 0;
    const ev = Math.log2(y / GREY);
    const f = Math.min(1, Math.max(0, (ev - LUT_MIN_EV) / (LUT_MAX_EV - LUT_MIN_EV))) * (LUT_N - 1);
    const i = Math.min(Math.floor(f), LUT_N - 2), t = f - i;
    const v = this.lut[i] + (this.lut[i + 1] - this.lut[i]) * t;
    return ev < LUT_MIN_EV ? v * (y / (GREY * Math.pow(2, LUT_MIN_EV))) : v;
  }
}

/** 마무리 단계: 장면 휘도에 톤 곡선, 색은 휘도 비율 + 채도 곡선 */
function displayed(scene, tone) {
  const s = scene.map((v) => Math.max(v, 0)), y = luma(s);
  if (y <= 0) return [0, 0, 0];
  const o = tone.apply(y), k = tone.chromaScale(o);
  return s.map((v) => o + (v * o / y - o) * k);
}

// ---------- hue/sat/value 표 (crates/raw/src/profile.rs, DNG ProfileHueSatMap) ----------

const wrap = (x, p) => ((x % p) + p) % p;
function hueOf(c, max, d) {
  if (d <= 0) return 0;
  const h = max === c[0] ? wrap((c[1] - c[2]) / d, 6) : max === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
  return h * 60;
}
function hsvToRgb(h, s, v) {
  const hp = wrap(h, 360) / 60, sector = Math.min(Math.floor(hp), 5), f = hp - sector;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][sector];
}
const limited = (x, k) => (x <= 1 ? Math.min(x * k, 1) : x * Math.min(k, 1));

export class HsvTable {
  /** { hue_divisions, sat_divisions, val_divisions, data: [[shift°, satScale, valScale], …], srgb_value } (값-색상-채도 순) */
  constructor(t) {
    this.hd = t.hue_divisions; this.sd = t.sat_divisions; this.vd = t.val_divisions;
    this.data = t.data; this.srgb = !!t.srgb_value && this.vd > 1;
  }
  json() { return { hue_divisions: this.hd, sat_divisions: this.sd, val_divisions: this.vd, data: this.data, srgb_value: this.srgb }; }
  entry(v, h, s) { return this.data[(v * this.hd + h) * this.sd + s] || [0, 1, 1]; }
  lookup(h, s, v) {
    const hf = Math.min(this.hd, Math.max(0, wrap(h, 360) / 360 * this.hd));
    const h0 = Math.min(Math.floor(hf), this.hd - 1), h1 = (h0 + 1) % this.hd, th = Math.min(1, Math.max(0, hf - h0));
    const axis = (x, n) => { const f = Math.min(1, Math.max(0, x)) * (n - 1), i0 = Math.min(Math.floor(f), Math.max(n - 2, 0)), i1 = Math.min(i0 + 1, n - 1); return [i0, i1, Math.min(1, Math.max(0, f - i0))]; };
    const [s0, s1, ts] = axis(s, this.sd);
    const [v0, v1, tv] = this.vd > 1 ? axis(v, this.vd) : [0, 0, 0];
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const plane = (vi) => lerp(lerp(this.entry(vi, h0, s0), this.entry(vi, h0, s1), ts), lerp(this.entry(vi, h1, s0), this.entry(vi, h1, s1), ts), th);
    return v0 === v1 ? plane(v0) : lerp(plane(v0), plane(v1), tv);
  }
  /** 선형 ProPhoto RGB 한 색에 적용 */
  apply(rgb) {
    const max = Math.max(rgb[0], rgb[1], rgb[2]);
    if (!(max > 0) || !isFinite(max)) return rgb;
    const min = Math.min(rgb[0], rgb[1], rgb[2]), d = max - min, hue = hueOf(rgb, max, d), sat = d / max;
    const vi = this.srgb ? linearToSrgb(Math.min(max, 1)) : max;
    const [shift, ss, vs] = this.lookup(hue, sat, vi);
    const s2 = limited(sat, ss);
    const v2 = this.srgb && max <= 1 ? (vs === 1 ? max : srgbToLinear(Math.min(vi * vs, 1)))
      : this.srgb ? max * Math.min(srgbToLinear(Math.min(vs, 1)), 1) : limited(max, vs);
    return hsvToRgb(hue + shift, s2, v2);
  }
}

/** 표가 바꾼 휘도를 되돌린다 (휘도는 톤 곡선 몫). 거의 검은 노이즈는 그대로 */
function restoreWeight(share) {
  if (!isFinite(share)) return 0;
  const t = Math.min(1, Math.max(0, (share - 0.15) / (0.25 - 0.15)));
  return t * t * (3 - 2 * t);
}
export function hueSat(table, rgb) {
  const out = M3.apply(FROM_PROPHOTO, table.apply(M3.apply(TO_PROPHOTO, rgb)));
  const before = luma(rgb), after = luma(out);
  if (before <= 0 || after <= 0 || !out.every(isFinite)) return rgb;
  const w = restoreWeight(after / before);
  if (w >= 1) return out.map((v) => v * before / after);
  if (w <= 0) return rgb;
  return rgb.map((v, i) => v + (out[i] * before / after - v) * w);
}

// ---------- 맞추기 (crates/engine/src/camera_preview.rs) ----------

export const PROXY = 96;
const SENSOR_CLIP = 0.99, MIN_IMPROVEMENT = 0.7, MAX_HOLDOUT_RMS = 0.10, EDGE_CONTRAST = 3.0;
const MIN_TONE_RANGE = 1.2, NARROW_TONE_RANGE = 1.5;

/** 작은 그림 { w, h, data: Float32Array(rgb) } */
const img = (w, h) => ({ w, h, data: new Float32Array(w * h * 3) });
const px = (im, i) => [im.data[i * 3], im.data[i * 3 + 1], im.data[i * 3 + 2]];

function localContrast(im, i) {
  const { w, h } = im, x = i % w, y = (i / w) | 0;
  let lo = Infinity, hi = 0;
  for (let r = Math.max(0, y - 1); r < Math.min(h, y + 2); r++) for (let c = Math.max(0, x - 1); c < Math.min(w, x + 2); c++) {
    const l = luma(px(im, r * w + c));
    if (Number.isNaN(l)) continue;   // Rust f32::min/max처럼 NaN(클리핑으로 뺀 화소)은 건너뜀
    lo = Math.min(lo, l); hi = Math.max(hi, l);
  }
  return isFinite(hi) ? hi / Math.max(lo, 1e-4) : Infinity;
}

const colourPairAbove = (inp, out, ylo, clo) => inp.every((v) => isFinite(v) && v > 0.001 && v < 1.5)
  && out.every((v) => v > clo && v < 0.98) && luma(out) >= ylo && luma(out) < 0.85;
const colourPair = (inp, out) => colourPairAbove(inp, out, 0.015, 0.004);

function collectPairs(sensor, ref, minChroma, edgeLimit) {
  const pairs = [], bright = [];
  let colour = 0;
  for (let i = 0; i < sensor.w * sensor.h; i++) {
    if (edgeLimit && (localContrast(sensor, i) > edgeLimit || localContrast(ref, i) > edgeLimit)) continue;
    const inp = px(sensor, i), out = px(ref, i), y = luma(out);
    if (!inp.every((v) => isFinite(v) && v > 0.001 && v < 1.5) || !out.every((v) => isFinite(v) && v >= 0)) continue;
    if (y >= 0.015 && y <= 1) bright.push([inp, out]);
    if (!colourPair(inp, out)) continue;
    colour += Math.max(...out) - Math.min(...out) > minChroma ? 1 : 0;
    pairs.push([inp, out]);
  }
  return pairs.length >= 256 && colour >= Math.floor(pairs.length / 20) ? { pairs, bright } : null;
}

/** 휘도로 정규화한 3×3 matrix (ridge), 학습 짝(3개 중 2개)만 */
function fitMatrix(pairs) {
  const gram = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], cross = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  pairs.forEach(([x, y], i) => {
    if (i % 3 === 0) return;
    const lx = luma(x), ly = luma(y);
    if (lx <= 0 || ly <= 0) return;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { gram[r][c] += x[r] * x[c] / (lx * lx); cross[r][c] += y[r] * x[c] / (ly * lx); }
  });
  const trace = gram[0][0] + gram[1][1] + gram[2][2], inv = M3.inv(gram);
  if (!inv) return null;
  const cond = trace * (Math.abs(inv[0][0]) + Math.abs(inv[1][1]) + Math.abs(inv[2][2]));
  if (trace <= 0 || !isFinite(cond) || cond > 1e6) return null;
  const reg = trace * 1e-4;
  for (let i = 0; i < 3; i++) { gram[i][i] += reg; cross[i][i] += reg; }
  const g2 = M3.inv(gram);
  if (!g2) return null;
  const m = M3.mul(cross, g2);
  return m.flat().every((v) => isFinite(v) && Math.abs(v) < 8) ? m : null;
}

function hueSaturation(p) {
  const max = Math.max(...p), min = Math.min(...p);
  if (!isFinite(max) || !isFinite(min) || max <= 0) return null;
  const d = max - min;
  if (d <= 0) return [0, 0];
  const h = max === p[0] ? wrap((p[1] - p[2]) / d, 6) : max === p[1] ? (p[2] - p[0]) / d + 2 : (p[0] - p[1]) / d + 4;
  return [h * 60, d / max];
}

/** matrix 뒤에 남은 색상 차·채도 비를 72색상 × 5채도 × 5밝기 표로 (커널 가중, 표본이 적으면 항등으로 수축) */
function fitHueSat(pairs, matrix) {
  const HUES = 72, SATS = 5, VALS = 5, KH = 2.5, KS = 0.15, KV = 0.12, SHRINK = 5.0;
  const samples = [];
  pairs.forEach(([x, y], i) => {
    if (i % 3 === 0) return;
    const p = M3.apply(TO_PROPHOTO, M3.apply(matrix, x)), a = hueSaturation(p);
    if (!a) return;
    const value = linearToSrgb(Math.min(Math.max(...p), 1));
    const b = hueSaturation(M3.apply(TO_PROPHOTO, y));
    if (!b || a[1] < 0.08 || b[1] < 0.02) return;
    const shift = Math.min(30, Math.max(-30, wrap(b[0] - a[0] + 180, 360) - 180));
    samples.push([a[0], Math.min(a[1], 1), value, shift, Math.min(0.7, Math.max(-0.7, Math.log(b[1] / a[1])))]);
  });
  if (samples.length < 64) return null;
  const step = 360 / HUES, byHue = Array.from({ length: HUES }, () => []);
  for (const s of samples) byHue[Math.min(Math.floor(wrap(s[0], 360) / step), HUES - 1)].push(s);
  const reach = Math.ceil(4 * KH / step) + 1, data = [];
  for (let index = 0; index < VALS * HUES * SATS; index++) {
    const v = Math.floor(index / (HUES * SATS)), h = Math.floor(index / SATS) % HUES, s = index % SATS;
    if (s === 0) { data.push([0, 1, 1]); continue; }
    const val = v / (VALS - 1), hue = h * step, sat = s / (SATS - 1);
    let weight = 0, shift = 0, ls = 0;
    for (let off = 0; off <= 2 * reach; off++) {
      for (const [hp, sp, vp, dh, l] of byHue[(h + HUES * 2 + off - reach) % HUES]) {
        const dhue = wrap(hp - hue + 180, 360) - 180;
        if (Math.abs(dhue) > 4 * KH) continue;
        const k = Math.exp(-0.5 * ((dhue / KH) ** 2 + ((sp - sat) / KS) ** 2 + ((vp - val) / KV) ** 2)) * sp;
        weight += k; shift += k * dh; ls += k * l;
      }
    }
    if (weight <= 0) { data.push([0, 1, 1]); continue; }
    const shrink = 1 / (weight + SHRINK);
    data.push([shift * shrink, Math.exp(ls * shrink), 1]);
  }
  return data.flat().every(isFinite) ? new HsvTable({ hue_divisions: HUES, sat_divisions: SATS, val_divisions: VALS, data, srgb_value: true }) : null;
}

/** 분위수 맞추기: i번째 1/32 구간의 장면 휘도 중앙값 ↔ JPEG 휘도 중앙값 (정합 없이도 되고 단조) */
function fitTone(pairs) {
  if (pairs.length < 128 || !pairs.every(([x, y]) => isFinite(x) && x > 0 && isFinite(y))) return null;
  const xs = pairs.map((p) => p[0]).sort((a, b) => a - b), ys = pairs.map((p) => p[1]).sort((a, b) => a - b), n = xs.length;
  const knots = [];
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(i * n / 32), b = Math.floor((i + 1) * n / 32), mid = a + Math.floor((b - a) / 2);
    knots.push([xs[mid], ys[mid]]);
  }
  if (Math.fround(knots[31][0]) < Math.fround(knots[0][0]) * MIN_TONE_RANGE) return null;
  return CameraTone.make(knots);
}

/** 예전 방식(대체용): 장면 휘도 구간별 JPEG 중앙값 + 단조 회귀(PAV) */
function fitToneConditional(pairs) {
  if (pairs.length < 128 || !pairs.every(([x, y]) => isFinite(x) && x > 0 && isFinite(y))) return null;
  pairs = [...pairs].sort((a, b) => a[0] - b[0]);
  const med = (v) => { v.sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const knots = [];
  for (let i = 0; i < 32; i++) {
    const bin = pairs.slice(Math.floor(i * pairs.length / 32), Math.floor((i + 1) * pairs.length / 32));
    if (!bin.length) return null;
    knots.push([med(bin.map((p) => p[0])), med(bin.map((p) => p[1]))]);
  }
  if (knots[31][0] < knots[0][0] * MIN_TONE_RANGE) return null;
  const blocks = [];
  for (const k of knots) {
    blocks.push([k[1], 1]);
    while (blocks.length >= 2) {
      const [a, an] = blocks[blocks.length - 2], [b, bn] = blocks[blocks.length - 1];
      if (a <= b) break;
      blocks.splice(-2, 2, [(a * an + b * bn) / (an + bn), an + bn]);
    }
  }
  let i = 0;
  for (const [y, n] of blocks) for (let j = 0; j < n; j++) knots[i++][1] = y;
  return CameraTone.make(knots);
}
const TONE_FITS = { quantile: fitTone, conditional: fitToneConditional };

function rankCorrelationTies(pairs) {
  const n = pairs.length;
  if (n < 3) return 0;
  const ranks = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), r = new Array(n);
    for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
    return r;
  };
  const a = ranks(pairs.map((p) => luma(p[0]))), b = ranks(pairs.map((p) => luma(p[1])));
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  const r = cov / Math.max(Math.sqrt(va * vb), 1e-12);
  return isFinite(r) ? r : 0;
}

/** 색 짝 + 어두운 JPEG 표본까지 넓혀 톤 곡선을 맞춘다 (어두운 쪽 발끝이 들뜨지 않게, LightCraft #1307) */
function fitToneWithShadows(fit, pairs, sensor, ref, edgeLimit, colour) {
  const lum = (x, y) => [luma(colour(x).map((v) => Math.max(v, 0))), luma(y)];
  const original = fit(pairs.filter((_, i) => i % 3 !== 0).map(([x, y]) => lum(x, y)));
  const eligible = [];
  let ci = 0, ei = 0;
  for (let i = 0; i < sensor.w * sensor.h; i++) {
    if (edgeLimit && (localContrast(sensor, i) > edgeLimit || localContrast(ref, i) > edgeLimit)) continue;
    const inp = px(sensor, i), out = px(ref, i), yo = luma(out);
    if (!inp.every((v) => isFinite(v) && v > 0.0001 && v < 1.5) || !out.every((v) => isFinite(v) && v >= 0) || !(yo >= 0.0003 && yo < 0.85)) continue;
    let held;
    if (colourPair(inp, out)) { held = ci % 3 === 0; ci++; } else { held = ei % 3 === 0; ei++; }
    const [x, y] = lum(inp, out);
    if (isFinite(x) && x > 0) eligible.push([x, y, held]);
  }
  const dark = eligible.filter((e) => e[1] < 0.015).length;
  const held = eligible.filter((e) => e[2] && e[1] < 0.015).map(([x, y]) => [[x, x, x], [y, y, y]]);
  if (dark < 96 || held.length < 32 || rankCorrelationTies(held) < 0.5) return original;
  const cand = fit(eligible.filter((e) => !e[2]).map(([x, y]) => [x, y]));
  if (!cand) return original;
  const err = (t) => held.reduce((s, [x, y]) => s + (Math.pow(t.apply(x[0]), 1 / 2.2) - Math.pow(y[0], 1 / 2.2)) ** 2, 0);
  if (original) { const b = err(original), a = err(cand); if (!isFinite(a) || a >= b * 0.99) return original; }
  return cand;
}

/** 화면 휘도별 채도 배율 8점 (밝은 곳은 바래고 어두운 곳은 진한 카메라 곡선) — 남겨 둔 짝에서 나아질 때만 */
function fitChroma(pairs, look, scene) {
  const tone = ToneMap.camera(look.tone), predict = (x) => displayed(scene(x), tone);
  const chroma = (p) => { const y = luma(p); return y > 0 ? Math.sqrt(p.reduce((s, v) => s + (v / y - 1) ** 2, 0)) : null; };
  const samples = [];
  pairs.forEach(([x, y], i) => {
    if (i % 3 === 0) return;
    const p = predict(x), cp = chroma(p), cy = chroma(y);
    if (cp == null || cy == null || !(cp > 0.05)) return;
    samples.push([luma(p), cp, Math.min(Math.log(2.5), Math.max(Math.log(0.05), Math.log(Math.max(cy, 1e-3) / cp)))]);
  });
  if (samples.length < 64) return null;
  const curve = [];
  for (let j = 0; j < CHROMA_N; j++) {
    const at = j / (CHROMA_N - 1);
    let w = 0, sum = 0;
    for (const [o, cp, lr] of samples) { const k = Math.exp(-0.5 * ((o - at) / 0.08) ** 2) * cp; w += k; sum += k * lr; }
    curve.push(Math.exp(sum / (w + 2.0)));
  }
  const fitted = look.tone.withChroma(curve);
  if (!fitted) return null;
  const withMap = ToneMap.camera(fitted);
  const error = (map) => pairs.filter((_, i) => i % 3 === 0).reduce((s, [x, y]) => { const p = displayed(scene(x), map); return s + (p[0] - y[0]) ** 2 + (p[1] - y[1]) ** 2 + (p[2] - y[2]) ** 2; }, 0);
  const before = error(tone), after = error(withMap);
  return isFinite(after) && after < before ? fitted : null;
}

/** JPEG 휘도 0.85 이상인 곳 (좁은 범위 곡선이 밝은 곳을 망치지 않는지 확인용) */
function highlightPairs(sensor, ref) {
  const out = [];
  for (let i = 0; i < sensor.w * sensor.h; i++) {
    const x = px(sensor, i), y = px(ref, i);
    if ([...x, ...y].every((v) => isFinite(v) && v >= 0) && luma(y) >= 0.85) out.push([x, y]);
  }
  return out;
}
function highlightsHold(tone, hl, colour) {
  if (tone.knots[31][0] >= tone.knots[0][0] * NARROW_TONE_RANGE) return true;
  const map = ToneMap.camera(tone), neutral = ToneMap.neutral();
  let look = 0, fallback = 0;
  for (const [x, t] of hl) {
    const r = displayed(colour(x), map), b = displayed(x, neutral);
    for (let c = 0; c < 3; c++) { look += (r[c] - t[c]) ** 2; fallback += (b[c] - t[c]) ** 2; }
  }
  return isFinite(look) && look <= fallback;
}

function fitPairsOn(sensor, ref, given, edgeLimit, toneFit, hl, report) {
  const got = collectPairs(sensor, ref, given ? 0.005 : 0.05, edgeLimit);
  if (!got) return null;
  const { pairs, bright } = got;
  let candidates;
  if (given) candidates = [given];
  else {
    const m = fitMatrix(pairs);
    if (!m) return null;
    candidates = [{ matrix: m, table: fitHueSat(pairs, m) }, { matrix: m, table: null }];
  }
  let best = null;
  for (const { matrix, table } of candidates) {
    const colour = (x) => { const p = M3.apply(matrix, x); return table ? hueSat(table, p) : p; };
    const curve = fitToneWithShadows(TONE_FITS[toneFit], pairs, sensor, ref, edgeLimit, colour);
    if (!curve) continue;
    const look = { matrix, table, tone: curve };
    const ch = fitChroma(bright, look, colour);
    if (ch) look.tone = ch;
    const tone = ToneMap.camera(look.tone);
    if (!highlightsHold(look.tone, hl, colour)) continue;
    let linear = 0, perceptual = 0, samples = 0;
    for (let i = 0; i < pairs.length; i += 3) {
      const [x, t] = pairs[i], c = displayed(colour(x), tone);
      for (let k = 0; k < 3; k++) { linear += (c[k] - t[k]) ** 2; perceptual += (Math.pow(Math.max(c[k], 0), 1 / 2.2) - Math.pow(Math.max(t[k], 0), 1 / 2.2)) ** 2; samples++; }
    }
    if (isFinite(linear) && isFinite(perceptual) && (!best || perceptual < best.perceptual)) best = { perceptual, linear, samples, look };
  }
  if (!best) return null;
  const neutral = ToneMap.neutral();
  let before = 0;
  for (let i = 0; i < pairs.length; i += 3) { const [x, t] = pairs[i], o = displayed(x, neutral); before += (o[0] - t[0]) ** 2 + (o[1] - t[1]) ** 2 + (o[2] - t[2]) ** 2; }
  const { linear: after, samples, look } = best;
  if (report) report.push({ edges: !!edgeLimit, tone: toneFit, profile: !!given, before: Math.sqrt(before / samples), after: Math.sqrt(after / samples), pairs: pairs.length });
  if (samples === 0 || after >= before * MIN_IMPROVEMENT || after / samples > MAX_HOLDOUT_RMS ** 2) return null;
  return look;
}

function searchOrdered(sensor, ref, profile, hl, report) {
  for (const tone of ['quantile', 'conditional']) for (const useProfile of profile ? [true, false] : [false]) for (const edges of [false, true]) {
    const attempt = { tone, useProfile, edges };
    const look = fitPairsOn(sensor, ref, useProfile ? profile : null, edges ? EDGE_CONTRAST : null, tone, hl, report);
    if (look) return { look, attempt };
  }
  return null;
}

/** 클리핑된 센서 화소를 뺀 그림 (색을 잃은 화소는 짝에서 제외) */
function withoutClipped(sensor, clipped) {
  if (!clipped.some(Boolean)) return null;
  const out = img(sensor.w, sensor.h);
  out.data.set(sensor.data);
  clipped.forEach((c, i) => { if (c) out.data.fill(NaN, i * 3, i * 3 + 3); });
  return out;
}

/** 높은 주파수 log 휘도의 상관 (방향 후보 중 JPEG와 더 맞는 쪽 고르기) */
function alignment(a, b) {
  const { w, h } = a;
  if (b.w !== w || b.h !== h || w < 3 || h < 3) return -1;
  const lum = (im) => Array.from({ length: w * h }, (_, i) => Math.log(Math.max(luma(px(im, i)), 1e-4)));
  const high = (l) => l.map((v, i) => { const x = i % w, y = (i / w) | 0; if (!x || !y || x + 1 === w || y + 1 === h) return NaN; return v - (l[i - w - 1] + l[i - w] + l[i - w + 1] + l[i - 1] + l[i + 1] + l[i + w - 1] + l[i + w] + l[i + w + 1]) / 8; });
  const ha = high(lum(a)), hb = high(lum(b)), P = [];
  for (let i = 0; i < ha.length; i++) if (isFinite(ha[i]) && isFinite(hb[i])) P.push([ha[i], hb[i]]);
  if (P.length < 64) return -1;
  const n = P.length, ma = P.reduce((s, p) => s + p[0], 0) / n, mb = P.reduce((s, p) => s + p[1], 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (const [x, y] of P) { cov += (x - ma) * (y - mb); va += (x - ma) ** 2; vb += (y - mb) ** 2; }
  const r = cov / Math.max(Math.sqrt(va * vb), 1e-12);
  return isFinite(r) ? r : -1;
}

// ---------- 입력 준비 ----------

/** 선형 카메라 RGB(화이트밸런스 적용) Uint16 3채널 W×H → 긴 변 96 px 상자 평균 + 클리핑 표시 */
export function sensorProxy(lin16, W, H, toLinear) {
  const k = PROXY / Math.max(W, H), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const out = img(w, h), clipped = new Array(w * h).fill(false), L = new Float32Array(65536);
  for (let v = 0; v < 65536; v++) L[v] = toLinear(v / 65536);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * H / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * H / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * W / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * W / w));
      let r = 0, g = 0, b = 0, n = 0, clip = false;
      for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) {   // 한 칸 건너 표본 (속도)
        const i = (yy * W + xx) * 3, a = L[lin16[i]], c = L[lin16[i + 1]], d = L[lin16[i + 2]];
        if (a >= SENSOR_CLIP || c >= SENSOR_CLIP || d >= SENSOR_CLIP) clip = true;
        r += a; g += c; b += d; n++;
      }
      const o = (y * w + x) * 3;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n;
      clipped[y * w + x] = clip;
    }
  }
  return { sensor: out, clipped };
}

/** 카메라 JPEG Blob → 선형 Rec.2020 그림, 센서 그림과 같은 크기. flip: LibRaw 방향(0, 3, 5, 6) */
export async function referenceProxy(jpeg, w, h, flip, adobe) {
  const bm = await createImageBitmap(jpeg, { imageOrientation: 'none' });
  const cands = [];
  for (const f of new Set([0, flip || 0])) {
    const rot = f === 5 || f === 6, cw = rot ? bm.height : bm.width, ch = rot ? bm.width : bm.height;
    if (Math.abs(cw / ch / (w / h) - 1) > 0.02) continue;   // 비율이 2 % 넘게 다르면 다른 그림
    // 4배 크기로 그린 뒤 선형으로 바꿔 평균 (부호화 값을 평균하면 어두워져 톤 곡선이 어둡게 맞춰짐)
    const K = 4, W4 = w * K, H4 = h * K, c = document.createElement('canvas');
    c.width = W4; c.height = H4;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.translate(W4 / 2, H4 / 2);
    if (f === 3) x.rotate(Math.PI); else if (f === 6) x.rotate(Math.PI / 2); else if (f === 5) x.rotate(-Math.PI / 2);
    const dw = rot ? H4 : W4, dh = rot ? W4 : H4;
    x.drawImage(bm, -dw / 2, -dh / 2, dw, dh);
    const d = x.getImageData(0, 0, W4, H4).data, out = img(w, h), M = adobe ? ADOBE_2020 : SRGB_2020;
    const dec = adobe ? (v) => Math.pow(v, 563 / 256) : srgbToLinear, T = new Float32Array(256);
    for (let v = 0; v < 256; v++) T[v] = dec(v / 255);
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) { const o = ((y * K + j) * W4 + xx * K + i) * 4; r += T[d[o]]; g += T[d[o + 1]]; b += T[d[o + 2]]; }
      out.data.set(M3.apply(M, [r / (K * K), g / (K * K), b / (K * K)]), (y * w + xx) * 3);
    }
    cands.push({ f, ref: out });
  }
  bm.close?.();
  return cands;
}

/** 번들 카메라 프로필 (LightCraft assets/camera-profiles, 여러 장으로 맞춘 matrix + hue/sat 표) */
const PROFILE_MODELS = { 'ILCA-99M2': 'ILCA-99M2', 'ILCE-7CR': 'ILCE-7CR', 'ILCE-7M4': 'ILCE-7M4', 'NIKON D5300': 'NIKON_D5300', 'NIKON Z 6_2': 'NIKON_Z_6_2', 'NIKON Z 8': 'NIKON_Z_8', 'X-H2S': 'X-H2S', 'X-T4': 'X-T4' };
async function loadProfile(model) {
  const f = PROFILE_MODELS[(model || '').trim()];
  if (!f) return null;
  try {
    const p = await (await fetch(new URL(`../vendor/lightcraft/camera-profiles/${f}.json`, import.meta.url))).json();
    if (p.version !== 1 || !p.matrix || !M3.inv(p.matrix) || !p.matrix.flat().every((v) => isFinite(v) && Math.abs(v) < 8)) return null;
    return { matrix: p.matrix, table: p.hue_sat ? new HsvTable(p.hue_sat) : null, files: p.files };
  } catch { return null; }
}

/**
 * RAW 한 장의 카메라 룩. sensor: 선형 카메라 RGB 96 px({sensor, clipped}), jpeg: 내장 JPEG Blob, model·flip: LibRaw 메타데이터.
 * 돌려주는 look: { matrix: 카메라 RGB → 선형 Rec.2020, table, knots, chroma } (못 맞추면 null), info: 시도별 남겨 둔 짝 RMS
 */
export async function fitCameraLook({ sensor, clipped }, jpeg, { model, flip, adobe }) {
  // 카메라 RGB를 sRGB로 친 기본 변환 (LightCraft의 matrix 없는 카메라 기본값): 센서 그림을 작업 공간으로
  const FB = SRGB_2020, FBi = REC2020_SRGB;
  const work = img(sensor.w, sensor.h);
  for (let i = 0; i < sensor.w * sensor.h; i++) work.data.set(M3.apply(FB, px(sensor, i)), i * 3);
  const refs = await referenceProxy(jpeg, sensor.w, sensor.h, flip, adobe);
  if (!refs.length) return { look: null, info: { reason: 'JPEG 비율이 RAW와 다름' } };
  const best = refs.map((r) => ({ ...r, a: alignment(work, r.ref) })).sort((a, b) => b.a - a.a)[0];
  const ref = best.ref;
  const prof = await loadProfile(model);
  const profile = prof ? { matrix: M3.mul(prof.matrix, FBi), table: prof.table } : null;
  const report = [], hl = highlightPairs(work, ref);
  const unclipped = withoutClipped(work, clipped);
  let found = searchOrdered(work, ref, profile, hl, report);
  let look = null;
  if (!found) {
    if (unclipped) { const f2 = searchOrdered(unclipped, ref, profile, hl, report); look = f2 && f2.look; }
  } else {
    look = found.look;
    if (unclipped) {
      const a = found.attempt;
      const refit = fitPairsOn(unclipped, ref, a.useProfile ? profile : null, a.edges ? EDGE_CONTRAST : null, a.tone, hl, report);
      if (refit) look = refit;
    }
  }
  const info = { profile: prof ? `${model} (${prof.files}장)` : null, orientation: best.f, alignment: +best.a.toFixed(3), clipped: clipped.filter(Boolean).length, attempts: report };
  if (!look) return { look: null, info };
  return {
    look: { matrix: M3.mul(look.matrix, FB), table: look.table ? look.table.json() : null, knots: look.tone.knots, chroma: look.tone.chroma, version: 1 },
    info,
  };
}

/** 저장해 둔 룩 → 화면에 쓰는 함수 (시험·썸네일용 CPU 판, 셰이더와 같은 계산) */
export function lookFn(look) {
  const tone = ToneMap.camera(CameraTone.make(look.knots, look.chroma)), table = look.table ? new HsvTable(look.table) : null;
  return (cam) => {
    let w = M3.apply(look.matrix, cam);
    if (table) w = hueSat(table, w);
    return M3.apply(REC2020_SRGB, displayed(w, tone));
  };
}

/** 셰이더용: 톤 표(4096) */
export function toneLUT(look) {
  return ToneMap.camera(CameraTone.make(look.knots, look.chroma)).lut;
}
