import { effective } from './profiles.js';
import { toneLUT, TO_PROPHOTO, FROM_PROPHOTO, REC2020_SRGB, LUT_N as LUT_W } from './camera.js';

// WebGL2 보정 엔진. 늘 원본(미리보기 크기)에서 처음부터 다시 그린다.
// 패스: 원본 → 흐림 3단(작게 S, 중간 M, 크게 L) → 메인 셰이더 1번.

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

// 13탭 가우시안 (선형 보간 샘플). dir = 텍셀 크기 × 배율
const BLUR = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D t; uniform vec2 dir;
void main(){
  vec4 s = texture(t, uv) * 0.19648255;
  s += (texture(t, uv + dir * 1.41176471) + texture(t, uv - dir * 1.41176471)) * 0.29690696;
  s += (texture(t, uv + dir * 3.29411765) + texture(t, uv - dir * 3.29411765)) * 0.09447040;
  s += (texture(t, uv + dir * 5.17647059) + texture(t, uv - dir * 5.17647059)) * 0.01038136;
  o = s;
}`;

const COPY = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o; uniform sampler2D t;
void main(){ o = texture(t, uv); }`;

// 16비트 원본 → 자르기·회전을 마친 화면 크기 (geometry.js geomRows). 결과 화소의 위쪽 원점 좌표로 원본 uv를 찾는다.
const GEOM = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o; uniform sampler2D t; uniform vec3 uRow0, uRow1; uniform vec2 uOut;
void main(){
  vec3 q = vec3(gl_FragCoord.x, uOut.y - gl_FragCoord.y, 1.0);
  vec2 s = vec2(dot(uRow0, q), dot(uRow1, q));
  o = any(lessThan(s, vec2(0.0))) || any(greaterThan(s, vec2(1.0))) ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(texture(t, s).rgb, 1.0);
}`;

// 첫 축소: 알파에 밝기² (guided filter용 국소 분산 = E[I²] − E[I]²)
const PREP = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o; uniform sampler2D t;
void main(){ vec3 c = texture(t, uv).rgb; float y = dot(c, vec3(0.2126, 0.7152, 0.0722)); o = vec4(c, y * y); }`;

const MAIN = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv; out vec4 o;
uniform sampler3D uLut3;   // 가져온 3D LUT (64³)
uniform float uLutAmt;
uniform int uLutIn;        // 0 sRGB, 1 F-Log, 2 F-Log2
uniform sampler2D uSrc, uS, uM, uL, uLut;
uniform vec2 uRes;
uniform float uOriginal, uSeed;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTemp, uTint, uVibrance, uSaturation, uRefineSat;
uniform vec3 uMix[8];
uniform float uBWMix[8];
uniform float uBW;
uniform vec4 uRegion;     // highlights, lights, darks, shadows
uniform vec4 uPoint;      // hue, range, -, active
uniform vec3 uPointAdj;   // hue, sat, lum
uniform vec3 uGradeS, uGradeM, uGradeH, uGradeG;  // hue, sat, lum
uniform float uBlend, uBalance;
uniform float uTexture, uClarity, uDehaze;
uniform vec4 uVig;        // amount, midpoint, feather, roundness
uniform float uVigHi;
uniform vec3 uGrain;      // amount, size, roughness
uniform vec3 uSharp;      // amount, detail, masking
uniform vec3 uNR;         // amount, detail, contrast
uniform vec3 uCNR;        // amount, detail, smoothness
// RAW 카메라 JPEG 룩 (camera.js, LightCraft의 camera look 마무리 단계와 같은 계산)
uniform float uCam, uHsvOn, uHsvSrgb;
uniform mat3 uCamM, uToPP, uFromPP, uTo709;   // 카메라 RGB → 선형 Rec.2020, Rec.2020 ↔ ProPhoto, Rec.2020 → 선형 sRGB
uniform sampler2D uTone, uHsv;                // 톤 표 4096×1 (EV −14…10), hue/sat 표 (색상×채도)×밝기
uniform vec3 uHsvDim;
uniform float uChroma[8];

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float hueDist(float a, float b){ float d = abs(a - b); return min(d, 1.0 - d); }
float bump(float x, float c){ float t = (x - c) / 0.16; return exp(-t * t); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
// 후지 F-Log·F-Log2 인코딩 (상수: colour-science fujifilm_f_log), F-Gamut = BT.2020 원색
vec3 flogEnc(vec3 x, float a, float b, float c, float d, float e, float f, float cut){
  vec3 lg = c * log(max(a * x + b, vec3(1e-6))) / log(10.0) + d;
  return mix(e * x + f, lg, step(vec3(cut), x));
}
const mat3 M709_2020 = mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0114, 0.8956);
vec3 lut3(vec3 lin, vec3 srgb){
  vec3 x = uLutIn == 0 ? srgb
         : uLutIn == 2 ? flogEnc(M709_2020 * lin, 5.555556, 0.064829, 0.245281, 0.384316, 8.799461, 0.092864, 0.000889)
                       : flogEnc(M709_2020 * lin, 0.555556, 0.009468, 0.344676, 0.790453, 8.735631, 0.092864, 0.00089);
  x = clamp(x, 0.0, 1.0) * (63.0 / 64.0) + 0.5 / 64.0;
  return texture(uLut3, x).rgb;
}
float lum2020(vec3 c){ return dot(c, vec3(0.2627, 0.6780, 0.0593)); }
float camTone(float y){
  if (y <= 0.0) return 0.0;
  float ev = log2(y / 0.18), f = clamp((ev + 14.0) / 24.0, 0.0, 1.0) * 4095.0;
  int i = min(int(f), 4094);
  float v = mix(texelFetch(uTone, ivec2(i, 0), 0).r, texelFetch(uTone, ivec2(i + 1, 0), 0).r, f - float(i));
  return ev < -14.0 ? v * (y / (0.18 * exp2(-14.0))) : v;
}
float camChroma(float o){ float f = clamp(o, 0.0, 1.0) * 7.0; int i = min(int(f), 6); return mix(uChroma[i], uChroma[i + 1], f - float(i)); }
vec3 hsvAt(int v, int h, int s){ return texelFetch(uHsv, ivec2(h * int(uHsvDim.y) + s, v), 0).rgb; }
vec3 hsvLookup(float h, float s, float v){
  int hd = int(uHsvDim.x), sd = int(uHsvDim.y), vd = int(uHsvDim.z);
  float hf = clamp(mod(h, 360.0) / 360.0 * uHsvDim.x, 0.0, uHsvDim.x);
  int h0 = min(int(hf), hd - 1), h1 = (h0 + 1) % hd;
  float th = clamp(hf - float(h0), 0.0, 1.0);
  float sf = clamp(s, 0.0, 1.0) * float(sd - 1);
  int s0 = min(int(sf), max(sd - 2, 0)), s1 = min(s0 + 1, sd - 1);
  float ts = clamp(sf - float(s0), 0.0, 1.0);
  int v0 = 0, v1 = 0; float tv = 0.0;
  if (vd > 1) { float vf = clamp(v, 0.0, 1.0) * float(vd - 1); v0 = min(int(vf), vd - 2); v1 = min(v0 + 1, vd - 1); tv = clamp(vf - float(v0), 0.0, 1.0); }
  vec3 a = mix(mix(hsvAt(v0, h0, s0), hsvAt(v0, h0, s1), ts), mix(hsvAt(v0, h1, s0), hsvAt(v0, h1, s1), ts), th);
  if (v0 == v1) return a;
  vec3 b = mix(mix(hsvAt(v1, h0, s0), hsvAt(v1, h0, s1), ts), mix(hsvAt(v1, h1, s0), hsvAt(v1, h1, s1), ts), th);
  return mix(a, b, tv);
}
float lin2srgb(float v){ return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
float srgb2lin(float v){ return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float limitedK(float x, float k){ return x <= 1.0 ? min(x * k, 1.0) : x * min(k, 1.0); }
vec3 hsvToRgbX(float h, float s, float v){
  float hp = mod(h, 360.0) / 60.0; int sec = min(int(hp), 5); float f = hp - float(sec);
  float p = v * (1.0 - s), q = v * (1.0 - s * f), t = v * (1.0 - s * (1.0 - f));
  if (sec == 0) return vec3(v, t, p); if (sec == 1) return vec3(q, v, p); if (sec == 2) return vec3(p, v, t);
  if (sec == 3) return vec3(p, q, v); if (sec == 4) return vec3(t, p, v); return vec3(v, p, q);
}
vec3 hsvTable(vec3 c){   // DNG ProfileHueSatMap (선형 ProPhoto)
  float mx = max(max(c.r, c.g), c.b);
  if (!(mx > 0.0) || isinf(mx)) return c;
  float mn = min(min(c.r, c.g), c.b), d = mx - mn, hue = 0.0;
  if (d > 0.0) hue = (mx == c.r ? mod((c.g - c.b) / d, 6.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0) * 60.0;
  float sat = d / mx;
  bool sv = uHsvSrgb > 0.5;
  float vi = sv ? lin2srgb(min(mx, 1.0)) : mx;
  vec3 e = hsvLookup(hue, sat, vi);
  float v2 = sv && mx <= 1.0 ? (e.z == 1.0 ? mx : srgb2lin(min(vi * e.z, 1.0))) : sv ? mx * min(srgb2lin(min(e.z, 1.0)), 1.0) : limitedK(mx, e.z);
  return hsvToRgbX(hue + e.x, limitedK(sat, e.y), v2);
}
vec3 camLook(vec3 cam){   // 카메라 RGB(선형) → 선형 sRGB
  vec3 w = uCamM * cam;
  if (uHsvOn > 0.5) {
    vec3 o = uFromPP * hsvTable(uToPP * w);
    float b = lum2020(w), a = lum2020(o);
    if (b > 0.0 && a > 0.0 && !any(isnan(o)) && !any(isinf(o))) { float t = clamp((a / b - 0.15) / 0.1, 0.0, 1.0); w = mix(w, o * b / a, t * t * (3.0 - 2.0 * t)); }
  }
  vec3 s = max(w, 0.0);
  float y = lum2020(s);
  if (y <= 0.0) return vec3(0.0);
  float o = camTone(y), k = camChroma(o);
  return uTo709 * (o + (s * o / y - o) * k);
}

vec3 gradeTint(vec3 g){ vec3 c = hsv2rgb(vec3(g.x, 1.0, 1.0)); return (c - luma(c)) * g.y * 0.3; }

const float CEN[8] = float[8](0.0, 0.0833, 0.1667, 0.3333, 0.5, 0.6667, 0.75, 0.8333);
const float SPAN[8] = float[8](0.0833, 0.0833, 0.125, 0.1667, 0.1667, 0.125, 0.0833, 0.125);

void main(){
  vec3 c = texture(uSrc, uv).rgb;
  // 원본 보기: 사용자 보정만 빼고, RAW 카메라 룩(시작 색감)은 그대로
  if (uOriginal > 0.5) { o = vec4(uCam > 0.5 ? clamp(toSrgb(camLook(toLin(clamp(c, 0.0, 1.0)))), 0.0, 1.0) : c, 1.0); return; }
  vec4 l4 = texture(uL, uv);
  vec3 s = texture(uS, uv).rgb, m = texture(uM, uv).rgb, l = l4.rgb;
  // 국소 분산이 큰 곳(보케·밝은 가장자리)은 넓은 주변 대신 좁은 주변을 기준으로 (헤일로 폭을 M 반경으로 줄임)
  float lm = luma(l), ga = max(l4.a - lm * lm, 0.0);
  ga = ga / (ga + 0.015);

  // Detail: 밝기 노이즈 → 색 노이즈 → 샤픈 → Texture
  if (uNR.x > 0.0) {
    float e = abs(luma(c) - luma(m));
    float w = uNR.x * (1.0 - smoothstep(0.0, mix(0.25, 0.02, uNR.y), e));
    vec3 base = mix(c, m, w);
    c = base + (c - base) * uNR.z;
  }
  if (uCNR.x > 0.0) {
    vec3 ref = mix(m, l, uCNR.z);
    float Y = luma(c);
    vec3 ch = c - Y, rc = ref - luma(ref);
    float w = uCNR.x * (1.0 - smoothstep(0.0, mix(0.4, 0.05, uCNR.y), length(ch - rc)));
    c = Y + mix(ch, rc, w);
  }
  if (uSharp.x > 0.0) {
    vec3 d = clamp(c - s, -mix(0.03, 0.3, uSharp.y), mix(0.03, 0.3, uSharp.y));
    float edge = abs(luma(s) - luma(m)) * 8.0;
    float mask = uSharp.z <= 0.0 ? 1.0 : smoothstep(uSharp.z * 0.6, uSharp.z * 0.6 + 0.15, edge);
    c += d * uSharp.x * 2.0 * mask;
  }
  if (uTexture != 0.0) c += (s - m) * uTexture * 1.5;

  // 노출·화이트밸런스는 선형에서
  vec3 wb = vec3(1.0 + 0.3 * uTemp, 1.0 - 0.25 * uTint, 1.0 - 0.3 * uTemp);
  float gain = exp2(uExposure);
  vec3 lc0 = toLin(clamp(c, 0.0, 1.0)) * gain * wb, ll0 = toLin(l) * gain * wb, lm0 = toLin(m) * gain * wb;
  // RAW: 카메라 JPEG 룩 (장면 선형 카메라 RGB → 화면). 노출·화이트밸런스는 그 앞, 장면 값에서
  if (uCam > 0.5) { lc0 = camLook(lc0); ll0 = camLook(ll0); lm0 = camLook(lm0); }
  vec3 p = toSrgb(lc0);
  vec3 pl = toSrgb(ll0);   // 주변 밝기 (하이라이트·섀도·Clarity 기준)
  vec3 pm = toSrgb(lm0);   // 좁은 주변 (밝은 가장자리 근처에서 대신 씀)
  // 가져온 LUT: 노출·화이트밸런스 바로 뒤, 다른 톤 보정 앞 (LUT 제작자 권장 순서)
  if (uLutAmt > 0.0) {
    p = mix(p, lut3(lc0, clamp(p, 0.0, 1.0)), uLutAmt);
    pl = mix(pl, lut3(ll0, clamp(pl, 0.0, 1.0)), uLutAmt);
    pm = mix(pm, lut3(lm0, clamp(pm, 0.0, 1.0)), uLutAmt);
  }

  // Dehaze: 안개 모델 I = J·t + A·(1 − t), 주변의 가장 어두운 채널로 t를 어림 (dark channel prior)
  if (uDehaze > 0.0) {
    const float A = 0.98;
    float t = max(1.0 - uDehaze * 0.9 * min(min(pl.r, pl.g), pl.b) / A, 0.2);
    p = max((p - A) / t + A, 0.0);
    pl = max((pl - A) / t + A, 0.0);
    pm = max((pm - A) / t + A, 0.0);
  } else if (uDehaze < 0.0) {
    p = mix(p, vec3(0.8), -uDehaze * 0.5);
    pl = mix(pl, vec3(0.8), -uDehaze * 0.5);
    pm = mix(pm, vec3(0.8), -uDehaze * 0.5);
  }

  // 밝기 톤: Clarity → 하이라이트·섀도 → Whites·Blacks → 대비
  // 검정(0)과 흰색(1)은 제자리에 두는 곡선만 쓴다. 검정을 들어 올리면 검은 화소의 색 노이즈가 비율만큼 커진다.
  float L0 = max(luma(p), 1e-4), L = L0, Ll = luma(pl);
  float Lb = mix(Ll, luma(pm), ga);   // 넓은 주변 밝기, 밝은 가장자리 근처는 좁은 주변으로
  // 다항식 가중치는 0–1로 자른 밝기로 (노출로 1을 넘은 밝은 곳에서 음수가 되어 검게 뚫리지 않게)
  float Lc = clamp(L, 0.0, 1.0);
  L += uClarity * clamp(L - Lb, -0.2, 0.2) * 1.0 * (4.0 * Lc * (1.0 - Lc));
  float hm = smoothstep(0.45, 1.0, Lb), sm = 1.0 - smoothstep(0.0, 0.55, Lb);
  L += uHighlights * 0.35 * hm * (uHighlights < 0.0 ? L : max(1.0 - L, 0.0));
  L += uShadows * 0.45 * sm * (uShadows > 0.0 ? max(1.0 - L, 0.0) * smoothstep(0.0, 0.25, L) : L);
  L += uWhites * 0.25 * smoothstep(0.5, 1.0, L);
  L += uBlacks * 0.2 * (1.0 - smoothstep(0.0, 0.4, L)) * (uBlacks > 0.0 ? smoothstep(0.0, 0.1, L) : 1.0);
  // 대비: L + k(L − ½)L(1 − L). k > 0은 smoothstep과 같고, k < 0은 중간 기울기를 낮추되 끝점은 고정
  Lc = clamp(L, 0.0, 1.0);
  L += (uContrast > 0.0 ? 2.0 : 2.4) * uContrast * (Lc - 0.5) * Lc * (1.0 - Lc);
  // 구간 커브 (Lightroom의 parametric curve: 하이라이트·밝은 톤·어두운 톤·섀도)
  L += 0.25 * (uRegion.x * bump(L, 0.875) + uRegion.y * bump(L, 0.625) + uRegion.z * bump(L, 0.375) + uRegion.w * bump(L, 0.125));
  L = clamp(L, 0.0, 1.2);
  // 색은 밝기 비율만큼 늘리되, 어두운 화소를 밝힐 때는 √비율로 줄이고 3배까지만 (노이즈·파란 기운 방지)
  float r = L / L0;
  float cs = r <= 1.0 ? r : min(mix(sqrt(r), r, smoothstep(0.05, 0.25, L0)), 3.0);
  p = L + (p - L0) * cs;
  float mx = max(max(p.r, p.g), p.b);
  if (mx > 1.0) p = mix(vec3(L), p, clamp((1.0 - L) / max(mx - L, 1e-4), 0.0, 1.0));
  p = clamp(p, 0.0, 1.0);

  // 커브 (RGB 커브를 각 채널 커브와 합친 LUT)
  vec3 before = p;
  vec3 lc = p * (255.0 / 256.0) + 0.5 / 256.0;
  p = vec3(texture(uLut, vec2(lc.r, 0.5)).r, texture(uLut, vec2(lc.g, 0.5)).g, texture(uLut, vec2(lc.b, 0.5)).b);
  vec3 hb = rgb2hsv(before), h = rgb2hsv(p);
  h.y = mix(hb.y, h.y, uRefineSat);

  // Color Mixer 8색
  float hs = 0.0, ss = 0.0, ls = 0.0, bws = 0.0, wsum = 0.0;
  float satGate = smoothstep(0.0, 0.15, h.y), bwGate = smoothstep(0.0, 0.25, h.y);
  for (int i = 0; i < 8; i++) {
    float w = 1.0 - smoothstep(0.0, SPAN[i], hueDist(h.x, CEN[i]));
    hs += w * uMix[i].x; ss += w * uMix[i].y; ls += w * uMix[i].z; bws += w * uBWMix[i]; wsum += w;
  }
  if (wsum > 1.0) { hs /= wsum; ss /= wsum; ls /= wsum; bws /= wsum; }
  h.x = fract(h.x + hs * satGate * 30.0 / 360.0);
  h.y = clamp(h.y * (1.0 + ss * satGate), 0.0, 1.0);
  float lumAdj = ls * satGate;

  // Point Color: 고른 색 근처만
  if (uPoint.w > 0.5) {
    float w = (1.0 - smoothstep(uPoint.y * 0.5, uPoint.y, hueDist(h.x, uPoint.x))) * smoothstep(0.05, 0.2, h.y);
    h.x = fract(h.x + w * uPointAdj.x * 30.0 / 360.0);
    h.y = clamp(h.y * (1.0 + w * uPointAdj.y), 0.0, 1.0);
    lumAdj += w * uPointAdj.z;
  }

  // Vibrance (채도 낮은 색·피부색 보호) → Saturation
  float skin = 1.0 - smoothstep(0.0, 0.08, hueDist(h.x, 0.07));
  h.y = clamp(h.y * (1.0 + uVibrance * (1.0 - h.y) * (1.0 - 0.5 * skin)), 0.0, 1.0);
  h.y = clamp(h.y * (1.0 + uSaturation), 0.0, 1.0);
  p = hsv2rgb(h) * (1.0 + lumAdj * 0.5);

  // 흑백: 색마다 밝기를 B&W Mix만큼 바꿔 회색으로 (색이 진할수록 많이)
  if (uBW > 0.5) p = vec3(clamp(luma(p) * (1.0 + bws * 0.6 * bwGate), 0.0, 1.0));

  // Color Grading
  float Lg = luma(p);
  float pivot = 0.5 + uBalance * 0.3, bl = mix(0.15, 0.45, uBlend);
  float wS = 1.0 - smoothstep(0.0, pivot + bl * 0.5, Lg);
  float wH = smoothstep(pivot - bl * 0.5, 1.0, Lg);
  float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
  p += wS * gradeTint(uGradeS) + wM * gradeTint(uGradeM) + wH * gradeTint(uGradeH) + gradeTint(uGradeG);
  p *= 1.0 + 0.3 * (wS * uGradeS.z + wM * uGradeM.z + wH * uGradeH.z + uGradeG.z);

  // Vignette
  if (uVig.x != 0.0) {
    // 모서리가 1이 되게 맞춘 세 거리: 사각(roundness −100), 화면 비율 타원(0), 원(+100)
    vec2 q = (uv - 0.5) * 2.0;
    float aspect = uRes.x / uRes.y;
    vec2 qc = aspect > 1.0 ? vec2(q.x, q.y / aspect) : vec2(q.x * aspect, q.y);
    float dE = length(q) / 1.41421, dR = max(abs(q.x), abs(q.y));
    float dC = length(qc) / length(aspect > 1.0 ? vec2(1.0, 1.0 / aspect) : vec2(aspect, 1.0));
    float d = uVig.w < 0.0 ? mix(dE, dR, -uVig.w) : mix(dE, dC, uVig.w);
    float mid = mix(0.2, 1.0, uVig.y), fe = mix(0.05, 1.0, uVig.z);
    float vm = smoothstep(mid - fe * 0.5, mid + fe * 0.5, d);
    if (uVig.x < 0.0) p *= 1.0 + uVig.x * vm * (1.0 - uVigHi * smoothstep(0.6, 1.0, luma(p)));
    else p = mix(p, vec3(1.0), uVig.x * vm);
  }

  // Grain (크기는 긴 변 2048 px 기준으로 맞춤)
  if (uGrain.x > 0.0) {
    float sz = mix(0.6, 4.0, uGrain.y) * max(uRes.x, uRes.y) / 2048.0;
    vec2 g = uv * uRes / sz + uSeed;
    float n = mix(vnoise(g), hash(floor(g)), uGrain.z) - 0.5;
    p += n * uGrain.x * 0.25 * (1.0 - abs(2.0 * luma(p) - 1.0) * 0.6);
  }
  o = vec4(clamp(p, 0.0, 1.0), 1.0);
}`;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'p');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

/** 커브 점 [[x,y],...] (0–1) → 256칸 단조 3차 보간 (Fritsch–Carlson) */
export function curveLUT(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0]);
  const n = P.length, out = new Float32Array(256);
  if (n < 2) { for (let i = 0; i < 256; i++) out[i] = i / 255; return out; }
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx.push(Math.max(P[i + 1][0] - P[i][0], 1e-6)); dy.push((P[i + 1][1] - P[i][1]) / dx[i]); }
  m.push(dy[0]);
  for (let i = 1; i < n - 1; i++) m.push(dy[i - 1] * dy[i] <= 0 ? 0 : (dy[i - 1] + dy[i]) / 2);
  m.push(dy[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (dy[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / dy[i], b = m[i + 1] / dy[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * dy[i]; m[i + 1] = t * b * dy[i]; }
  }
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    let y;
    if (x <= P[0][0]) y = P[0][1];
    else if (x >= P[n - 1][0]) y = P[n - 1][1];
    else {
      let i = 0;
      while (x > P[i + 1][0]) i++;
      const h = dx[i], t = (x - P[i][0]) / h, t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * P[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * P[i + 1][1] + (t3 - t2) * h * m[i + 1];
    }
    out[k] = Math.min(1, Math.max(0, y));
  }
  return out;
}

export class Pipeline {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('이 브라우저는 WebGL2를 지원하지 않습니다');
    this.gl = gl;
    this.canvas = canvas;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.main = compile(gl, VS, MAIN);
    this.blur = compile(gl, VS, BLUR);
    this.copy = compile(gl, VS, COPY);
    this.prep = compile(gl, VS, PREP);
    this.geom = compile(gl, VS, GEOM);
    this.half = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.lut = this.tex(256, 1);
    this.luts = new Map();   // 가져온 3D LUT: id → { tex, input }
    this.dummy3 = this.tex3(1, new Uint8Array([0, 0, 0]));
    this.look = null;
    this.toneTex = this.ftex(LUT_W, 1, gl.R32F, gl.RED, null);
    this.hsvTex = this.ftex(1, 1, gl.RGB32F, gl.RGB, new Float32Array([0, 1, 1]));
    this.seed = Math.random() * 100;
    this.set = null;
  }

  tex(w, h, src, half) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (src) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, half ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, half ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    }
    return t;
  }

  tex3(n, rgb) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, n, n, n, 0, gl.RGB, gl.UNSIGNED_BYTE, rgb);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return t;
  }

  /** 가져온 LUT 등록 (rgb: 64³×3 Uint8, input: srgb·flog·flog2) */
  setLUT(id, rgb, input) {
    const old = this.luts.get(id);
    if (old) this.gl.deleteTexture(old.tex);
    this.luts.set(id, { tex: this.tex3(Math.round(Math.cbrt(rgb.length / 3)), rgb), input });
  }

  dropLUT(id) {
    const old = this.luts.get(id);
    if (old) { this.gl.deleteTexture(old.tex); this.luts.delete(id); }
  }

  /** 표본을 그대로 읽는(texelFetch) 32비트 부동소수점 표 */
  ftex(w, h, ifmt, fmt, data) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return t;
  }

  /** RAW 카메라 룩 (camera.js fitCameraLook 결과, 없으면 null). 같은 객체면 다시 올리지 않음 */
  setLook(look) {
    if (look === this.look) return;
    this.look = look || null;
    if (!look) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.toneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, LUT_W, 1, 0, gl.RED, gl.FLOAT, toneLUT(look));
    if (look.table) {
      const t = look.table, d = new Float32Array(t.data.length * 3);
      t.data.forEach((e, i) => d.set(e, i * 3));
      gl.deleteTexture(this.hsvTex);
      this.hsvTex = this.ftex(t.hue_divisions * t.sat_divisions, t.val_divisions, gl.RGB32F, gl.RGB, d);
    }
  }

  /** 16비트 원본 { width, height, data: RGBA half } → GPU 텍스처 (밉맵: 줄여 그릴 때 계단 방지). 16비트 렌더가 안 되면 null */
  hiSource(img) {
    if (!this.half || Math.max(img.width, img.height) > this.maxTex) return null;
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    while (gl.getError() !== gl.NO_ERROR);   // 이전 오류 비우기
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, img.width, img.height, 0, gl.RGBA, gl.HALF_FLOAT, img.data);
    let ok = gl.getError() === gl.NO_ERROR;
    if (ok) { gl.generateMipmap(gl.TEXTURE_2D); ok = gl.getError() === gl.NO_ERROR; }
    if (!ok) { gl.deleteTexture(t); return null; }   // 메모리 부족 등: 8비트로 편집
    return { t, w: img.width, h: img.height };
  }

  dropHi(h) { if (h) this.gl.deleteTexture(h.t); }

  /** half: 흐림 단계용 16비트 부동소수점 (8비트면 그림자 계조가 끊기고 국소 분산을 못 잰다) */
  target(w, h, half) {
    const gl = this.gl, t = this.tex(w, h, null, half && this.half), fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, fb, w, h };
  }

  pass(prog, out, inputs, setU) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    gl.viewport(0, 0, out ? out.w : this.canvas.width, out ? out.h : this.canvas.height);
    gl.useProgram(prog.p);
    inputs.forEach(([name, t, target], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(target || gl.TEXTURE_2D, t);
      gl.uniform1i(prog.u[name], i);
    });
    if (setU) setU(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  blurInto(src, tmp, dst, sigma) {
    const k = Math.max(sigma, 0.3) / 2.5;
    this.pass(this.blur, tmp, [['t', src]], (u) => this.gl.uniform2f(u.dir, k / tmp.w, 0));
    this.pass(this.blur, dst, [['t', tmp.t]], (u) => this.gl.uniform2f(u.dir, 0, k / dst.h));
  }

  /** 원본(캔버스·이미지)으로 텍스처와 흐림 3단을 만든다. sharpRadius가 바뀌면 다시 부른다. */
  build(source, w, h, sharpRadius = 1) {
    this.free(this.set);
    const gl = this.gl, long = Math.max(w, h);
    // 16비트·흐림 단계는 12 MP까지 (원본 크기 내보내기는 GPU 메모리가 모자라 8비트로)
    const hq = w * h <= 12e6;
    let src, srcFb = null;
    if (source && source.hiTex) {
      const r = this.target(w, h, true);
      this.pass(this.geom, r, [['t', source.hiTex.t]], (u) => {
        this.gl.uniform3fv(u.uRow0, source.row0); this.gl.uniform3fv(u.uRow1, source.row1); this.gl.uniform2f(u.uOut, w, h);
      });
      src = r.t; srcFb = r.fb;
    } else src = this.tex(w, h, source);
    const S = this.target(w, h, hq), St = this.target(w, h, hq);
    this.blurInto(src, St, S, sharpRadius * long / 2048);
    let cur = { t: src, w, h };
    const chain = [];
    for (let i = 0; i < 3; i++) {
      const nx = this.target(Math.max(1, cur.w >> 1), Math.max(1, cur.h >> 1), hq);
      this.pass(i ? this.copy : this.prep, nx, [['t', cur.t]]);
      chain.push(nx);
      cur = nx;
    }
    const M = this.target(chain[0].w, chain[0].h, hq), Mt = this.target(chain[0].w, chain[0].h, hq);
    this.blurInto(chain[0].t, Mt, M, long / 400 / 2);
    const L = this.target(chain[2].w, chain[2].h, hq), Lt = this.target(chain[2].w, chain[2].h, hq);
    this.blurInto(chain[2].t, Lt, L, long / 60 / 8);
    this.blurInto(L.t, Lt, L, long / 60 / 8);
    this.set = { src, srcFb, S, St, M, Mt, L, Lt, chain, w, h, sharpRadius };
    return this.set;
  }

  free(set) {
    if (!set) return;
    const gl = this.gl;
    gl.deleteTexture(set.src);
    if (set.srcFb) gl.deleteFramebuffer(set.srcFb);
    for (const r of [set.S, set.St, set.M, set.Mt, set.L, set.Lt, ...set.chain]) {
      gl.deleteTexture(r.t);
      gl.deleteFramebuffer(r.fb);
    }
  }

  uploadLUT(c, fade) {
    const R = curveLUT(c.r), G = curveLUT(c.g), B = curveLUT(c.b), A = curveLUT(c.rgb);
    const data = new Uint8Array(256 * 4);
    const at = (lut, v) => lut[Math.round(Math.min(1, Math.max(0, v)) * 255)];
    const F = fade || { master: [0, 1], r: [0, 1], g: [0, 1], b: [0, 1] };
    const fd = (v, [lo, hi]) => lo + v * (hi - lo);   // 프로필 페이드: 커브 끝점 이동
    for (let i = 0; i < 256; i++) {
      const m = fd(A[i], F.master);
      data[i * 4] = fd(at(R, m), F.r) * 255;
      data[i * 4 + 1] = fd(at(G, m), F.g) * 255;
      data[i * 4 + 2] = fd(at(B, m), F.b) * 255;
      data[i * 4 + 3] = 255;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  /** 설정을 셰이더에 넣고 out(없으면 화면 캔버스)에 그린다 */
  draw(user, autoEV, original, out) {
    const set = this.set, gl = this.gl;
    if (!set) return;
    const st = effective(user);   // 프로필을 사용자 슬라이더 아래에 깔기
    if (st.detail.sharpen.radius !== set.sharpRadius && set.source) this.build(set.source, set.w, set.h, st.detail.sharpen.radius);
    this.uploadLUT(st.curve, st._fade);
    const L = st.light, C = st.color, E = st.effects, D = st.detail, G = st.grading, P = st.point;
    const g3 = (z) => [z.h / 360, z.s / 100, z.l / 100];
    const L3 = st._lut ? this.luts.get(st._lut.id) : null;
    this.pass(this.main, out, [['uSrc', set.src], ['uS', set.S.t], ['uM', set.M.t], ['uL', set.L.t], ['uLut', this.lut],
      ['uLut3', L3 ? L3.tex : this.dummy3, gl.TEXTURE_3D], ['uTone', this.toneTex], ['uHsv', this.hsvTex]], (u) => {
      const K = this.look, m3 = (n, m) => u[n] && gl.uniformMatrix3fv(u[n], true, m.flat());
      gl.uniform1f(u.uCam, K ? 1 : 0);
      if (K) {
        m3('uCamM', K.matrix); m3('uToPP', TO_PROPHOTO); m3('uFromPP', FROM_PROPHOTO); m3('uTo709', REC2020_SRGB);
        gl.uniform1f(u.uHsvOn, K.table ? 1 : 0);
        gl.uniform1f(u.uHsvSrgb, K.table && K.table.srgb_value ? 1 : 0);
        if (K.table) gl.uniform3f(u.uHsvDim, K.table.hue_divisions, K.table.sat_divisions, K.table.val_divisions);
        gl.uniform1fv(u.uChroma, K.chroma);
      }
      gl.uniform1f(u.uLutAmt, L3 ? st._lut.amount : 0);
      gl.uniform1i(u.uLutIn, L3 ? ({ srgb: 0, flog: 1, flog2: 2 })[L3.input] ?? 0 : 0);
      const f = (n, v) => u[n] && gl.uniform1f(u[n], v);
      const v3 = (n, a) => u[n] && gl.uniform3fv(u[n], a);
      gl.uniform2f(u.uRes, out ? out.w : this.canvas.width, out ? out.h : this.canvas.height);
      f('uOriginal', original ? 1 : 0); f('uSeed', this.seed);
      f('uExposure', L.exposure + (st.autoExposure ? autoEV : 0));
      f('uContrast', L.contrast / 100); f('uHighlights', L.highlights / 100); f('uShadows', L.shadows / 100);
      f('uWhites', L.whites / 100); f('uBlacks', L.blacks / 100);
      f('uTemp', C.temp / 100); f('uTint', C.tint / 100); f('uVibrance', C.vibrance / 100); f('uSaturation', C.saturation / 100);
      f('uRefineSat', st.curve.refineSat / 100);
      v3('uMix', st.mixer.flatMap((b) => [b.h / 100, b.s / 100, b.l / 100]));
      if (u.uBWMix) gl.uniform1fv(u.uBWMix, st.bw.map((v) => v / 100));
      f('uBW', st.treatment === 'bw' ? 1 : 0);
      const R = st.curve.region;
      gl.uniform4f(u.uRegion, R.highlights / 100, R.lights / 100, R.darks / 100, R.shadows / 100);
      gl.uniform4f(u.uPoint, P.hue / 360, P.range / 360, 0, P.active ? 1 : 0);
      v3('uPointAdj', [P.hueShift / 100, P.satShift / 100, P.lumShift / 100]);
      v3('uGradeS', g3(G.shadows)); v3('uGradeM', g3(G.midtones)); v3('uGradeH', g3(G.highlights)); v3('uGradeG', g3(G.global));
      f('uBlend', G.blending / 100); f('uBalance', G.balance / 100);
      f('uTexture', E.texture / 100); f('uClarity', E.clarity / 100); f('uDehaze', E.dehaze / 100);
      const V = E.vignette;
      gl.uniform4f(u.uVig, V.amount / 100, V.midpoint / 100, V.feather / 100, V.roundness / 100);
      f('uVigHi', V.highlights / 100);
      v3('uGrain', [E.grain.amount / 100, E.grain.size / 100, E.grain.roughness / 100]);
      v3('uSharp', [D.sharpen.amount / 100, D.sharpen.detail / 100, D.sharpen.masking / 100]);
      v3('uNR', [D.nr.amount / 100, D.nr.detail / 100, D.nr.contrast / 100]);
      v3('uCNR', [D.cnr.amount / 100, D.cnr.detail / 100, D.cnr.smoothness / 100]);
    });
  }

  /** 화면 미리보기용 원본 지정 */
  setPreview(source, w, h, sharpRadius) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.build(source, w, h, sharpRadius);
    this.set.source = source;
  }

  /** 지금 화면 그림의 밝기·RGB 히스토그램 (64칸) */
  histogram() {
    const gl = this.gl, w = 160, h = Math.max(1, Math.round(160 * this.canvas.height / this.canvas.width));
    const t = this.target(w, h);
    this.pass(this.copy, t, [['t', this.canvasTex()]]);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.deleteTexture(t.t); gl.deleteFramebuffer(t.fb);
    const H = { r: new Array(64).fill(0), g: new Array(64).fill(0), b: new Array(64).fill(0) };
    for (let i = 0; i < px.length; i += 4) { H.r[px[i] >> 2]++; H.g[px[i + 1] >> 2]++; H.b[px[i + 2] >> 2]++; }
    return H;
  }

  canvasTex() {
    const gl = this.gl;
    if (!this._ct) this._ct = this.tex(1, 1);
    gl.bindTexture(gl.TEXTURE_2D, this._ct);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return this._ct;
  }

  /** 작은 원본 하나에 설정 여러 개를 그려 캔버스 목록으로 (프로필 썸네일). 미리보기 상태는 되살린다. */
  renderMany(source, w, h, list, autoEV) {
    const keep = this.set, gl = this.gl;
    this.set = null;
    this.build(source, w, h, 1);
    const out = this.target(w, h), px = new Uint8Array(w * h * 4), row = w * 4, res = [];
    for (const st of list) {
      this.draw(st, autoEV, false, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d'), img = x.createImageData(w, h);
      for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      x.putImageData(img, 0, 0);
      res.push(c);
    }
    gl.deleteTexture(out.t); gl.deleteFramebuffer(out.fb);
    this.free(this.set);
    this.set = keep;
    return res;
  }

  /** 내보내기: source(w×h 캔버스)를 같은 설정으로 그려 2D 캔버스로 돌려준다. 미리보기 상태는 되살린다. */
  renderFull(source, w, h, st, autoEV) {
    const keep = this.set;
    this.set = null;
    this.build(source, w, h, st.detail.sharpen.radius);
    const out = this.target(w, h);
    this.draw(st, autoEV, false, out);
    const gl = this.gl, px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.deleteTexture(out.t); gl.deleteFramebuffer(out.fb);
    this.free(this.set);
    this.set = keep;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d'), img = ctx.createImageData(w, h), row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);  // 위아래 뒤집기
    ctx.putImageData(img, 0, 0);
    return c;
  }
}
