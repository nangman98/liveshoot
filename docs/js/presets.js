// 기본 프리셋: LightCraft (https://github.com/storytold/lightcraft, MIT OR Apache-2.0, © the LightCraft authors)
// crates/engine/src/presets.rs의 builtin() 41개 (커밋 23e1812). 값은 LightCraft가 직접 정한 것 ("all values are our own").
// 프리셋은 들어 있는 항목만 바꾼다 (Lightroom·LightCraft와 같음). 아래 lcPaths가 LightCraft 설정 이름을 LiveShoot 경로로 옮긴다.

const MIX = { red: 0, orange: 1, yellow: 2, green: 3, aqua: 4, blue: 5, purple: 6, magenta: 7 };

// [묶음, id, 이름, LightCraft 부분 설정]
const DATA = [
  ["Color", "warm-glow", "Warm Glow", {"wb": {"mode": "custom", "temp": 7200.0, "tint": 8.0}, "light": {"contrast": 8.0, "shadows": 12.0}, "color": {"vibrance": 18.0}}],
  ["Color", "cool-morning", "Cool Morning", {"wb": {"mode": "custom", "temp": 5600.0, "tint": -4.0}, "light": {"highlights": -20.0}, "color": {"vibrance": 10.0}, "grading": {"shadows": {"hue": 215.0, "sat": 12.0, "lum": 0.0}}}],
  ["Color", "teal-orange", "Teal & Orange", {"grading": {"shadows": {"hue": 195.0, "sat": 28.0, "lum": 0.0}, "highlights": {"hue": 35.0, "sat": 22.0, "lum": 0.0}, "balance": 10.0}, "color": {"vibrance": 12.0}, "light": {"contrast": 14.0}}],
  ["Color", "vivid-pop", "Vivid Pop", {"color": {"vibrance": 40.0, "saturation": 8.0}, "light": {"contrast": 18.0, "whites": 10.0, "blacks": -10.0}, "effects": {"clarity": 12.0}}],
  ["Color", "soft-pastel", "Soft Pastel", {"light": {"contrast": -25.0, "highlights": -30.0, "shadows": 35.0, "blacks": 20.0}, "color": {"saturation": -18.0, "vibrance": 10.0}, "curve": {"shadows": 25.0}}],
  ["Film", "faded-matte", "Faded Matte", {"curve": {"shadows": 40.0, "highlights": -15.0}, "light": {"contrast": -10.0}, "color": {"saturation": -12.0}, "grain": {"amount": 18.0, "size": 25.0, "roughness": 50.0}}],
  ["Film", "warm-film", "Warm Film", {"wb": {"mode": "custom", "temp": 6900.0, "tint": 5.0}, "curve": {"shadows": 22.0}, "grading": {"highlights": {"hue": 45.0, "sat": 15.0, "lum": 0.0}}, "grain": {"amount": 22.0, "size": 30.0, "roughness": 55.0}, "vignette": {"amount": -12.0}}],
  ["Film", "muted-film", "Muted Film", {"color": {"saturation": -25.0, "vibrance": 5.0}, "light": {"contrast": 10.0}, "curve": {"shadows": 18.0}, "grain": {"amount": 15.0}}],
  ["B&W", "bw-high-contrast", "High Contrast B&W", {"treatment": "bw", "light": {"contrast": 45.0, "whites": 20.0, "blacks": -25.0}, "effects": {"clarity": 20.0}, "bw_mix": {"blue": -30.0, "red": 15.0}}],
  ["B&W", "bw-soft", "Soft B&W", {"treatment": "bw", "light": {"contrast": -15.0, "shadows": 25.0}, "curve": {"shadows": 15.0}}],
  ["B&W", "bw-selenium", "Selenium Tone", {"treatment": "bw", "light": {"contrast": 20.0}, "grading": {"shadows": {"hue": 285.0, "sat": 18.0, "lum": 0.0}, "highlights": {"hue": 40.0, "sat": 10.0, "lum": 0.0}}}],
  ["Landscape", "crisp-landscape", "Crisp Landscape", {"light": {"highlights": -45.0, "shadows": 30.0, "contrast": 12.0}, "effects": {"clarity": 22.0, "dehaze": 12.0, "texture": 15.0}, "color": {"vibrance": 25.0}}],
  ["Landscape", "golden-hour", "Golden Hour", {"wb": {"mode": "custom", "temp": 7600.0, "tint": 12.0}, "light": {"highlights": -35.0, "shadows": 20.0}, "grading": {"highlights": {"hue": 38.0, "sat": 25.0, "lum": 5.0}}, "vignette": {"amount": -15.0}}],
  ["Landscape", "blue-hour", "Blue Hour Boost", {"wb": {"mode": "custom", "temp": 5200.0, "tint": 6.0}, "light": {"shadows": 25.0, "exposure": 0.2}, "mixer": {"blue": {"hue": 0.0, "sat": 25.0, "lum": 0.0}, "purple": {"hue": 0.0, "sat": 15.0, "lum": 0.0}}}],
  ["Portrait", "soft-skin", "Soft Skin", {"effects": {"texture": -25.0, "clarity": -10.0}, "light": {"contrast": -5.0, "shadows": 15.0}, "mixer": {"orange": {"hue": 0.0, "sat": -8.0, "lum": 10.0}}}],
  ["Portrait", "bright-airy", "Bright & Airy", {"light": {"exposure": 0.45, "contrast": -15.0, "highlights": -40.0, "shadows": 40.0, "whites": 15.0}, "color": {"vibrance": 8.0, "saturation": -8.0}}],
  ["Style", "moody", "Moody", {"light": {"exposure": -0.3, "contrast": 20.0, "highlights": -30.0, "blacks": -15.0}, "color": {"saturation": -20.0}, "grading": {"shadows": {"hue": 200.0, "sat": 15.0, "lum": -5.0}}, "vignette": {"amount": -30.0}}],
  ["Style", "cinematic", "Cinematic", {"curve": {"shadows": 20.0, "highlights": -10.0}, "grading": {"shadows": {"hue": 190.0, "sat": 25.0, "lum": 0.0}, "highlights": {"hue": 30.0, "sat": 18.0, "lum": 0.0}}, "light": {"contrast": 15.0}, "vignette": {"amount": -20.0}}],
  ["Portrait", "moody-portrait", "Moody Portrait", {"light": {"exposure": -0.25, "contrast": 20.0, "highlights": -30.0, "blacks": -12.0}, "color": {"saturation": -15.0}, "vignette": {"amount": -25.0, "midpoint": 40.0}, "mixer": {"orange": {"sat": 6.0}}}],
  ["Portrait", "golden-glow", "Golden Glow", {"grading": {"highlights": {"hue": 40.0, "sat": 18.0, "lum": 0.0}, "midtones": {"hue": 35.0, "sat": 8.0, "lum": 0.0}}, "light": {"shadows": 15.0}, "effects": {"clarity": -8.0}}],
  ["Portrait", "clean-studio", "Clean Studio", {"light": {"contrast": 10.0, "whites": 15.0, "blacks": -8.0}, "effects": {"texture": -10.0}, "color": {"vibrance": 5.0}}],
  ["Landscape", "crisp-vista", "Crisp Vista", {"effects": {"dehaze": 15.0, "clarity": 18.0, "texture": 12.0}, "light": {"contrast": 12.0, "highlights": -25.0, "shadows": 18.0}, "color": {"vibrance": 20.0}}],
  ["Landscape", "deep-sky", "Deep Sky", {"mixer": {"blue": {"lum": -25.0, "sat": 15.0}, "aqua": {"lum": -10.0}}, "light": {"highlights": -30.0}, "effects": {"dehaze": 10.0}}],
  ["Landscape", "lush-greens", "Lush Greens", {"mixer": {"green": {"hue": 12.0, "sat": 18.0, "lum": 8.0}, "yellow": {"hue": 10.0, "sat": 10.0}}, "color": {"vibrance": 12.0}, "effects": {"clarity": 8.0}}],
  ["Landscape", "desert-warmth", "Desert Warmth", {"mixer": {"orange": {"sat": 15.0, "lum": 5.0}, "yellow": {"hue": -8.0, "sat": 10.0}, "blue": {"sat": -10.0}}, "grading": {"highlights": {"hue": 38.0, "sat": 12.0, "lum": 0.0}}, "light": {"contrast": 10.0}}],
  ["Landscape", "misty-morning", "Misty Morning", {"effects": {"dehaze": -18.0, "clarity": -12.0}, "light": {"contrast": -18.0, "highlights": -10.0}, "grading": {"shadows": {"hue": 210.0, "sat": 10.0, "lum": 0.0}}, "color": {"saturation": -10.0}}],
  ["Urban", "gritty-street", "Gritty Street", {"effects": {"clarity": 35.0, "texture": 20.0}, "light": {"contrast": 25.0, "blacks": -15.0}, "color": {"saturation": -30.0}, "vignette": {"amount": -18.0}}],
  ["Urban", "neon-night", "Neon Night", {"mixer": {"magenta": {"sat": 20.0}, "purple": {"sat": 18.0}, "blue": {"sat": 12.0}, "aqua": {"sat": 15.0}}, "light": {"contrast": 18.0, "blacks": -12.0}, "color": {"vibrance": 15.0}, "grading": {"shadows": {"hue": 250.0, "sat": 15.0, "lum": 0.0}}}],
  ["Urban", "concrete-cool", "Concrete Cool", {"grading": {"shadows": {"hue": 205.0, "sat": 14.0, "lum": 0.0}, "highlights": {"hue": 200.0, "sat": 6.0, "lum": 0.0}}, "color": {"saturation": -20.0}, "light": {"contrast": 12.0}, "effects": {"clarity": 15.0}}],
  ["Urban", "faded-urban", "Faded Urban", {"curve": {"shadows": 30.0}, "color": {"saturation": -22.0}, "light": {"contrast": -8.0}, "grain": {"amount": 12.0, "size": 25.0, "roughness": 45.0}}],
  ["Food", "fresh-bright", "Fresh & Bright", {"light": {"exposure": 0.25, "shadows": 20.0, "whites": 10.0}, "color": {"vibrance": 22.0}, "effects": {"texture": 15.0}}],
  ["Food", "warm-table", "Warm Table", {"grading": {"midtones": {"hue": 32.0, "sat": 10.0, "lum": 0.0}}, "mixer": {"orange": {"sat": 10.0}, "red": {"sat": 8.0}}, "light": {"contrast": 8.0}}],
  ["Food", "dark-moody-food", "Dark & Moody", {"light": {"exposure": -0.3, "contrast": 22.0, "highlights": -20.0, "blacks": -15.0}, "effects": {"texture": 18.0}, "vignette": {"amount": -22.0}}],
  ["Seasons", "autumn-gold", "Autumn Gold", {"mixer": {"green": {"hue": -30.0, "sat": -10.0}, "yellow": {"hue": -15.0, "sat": 15.0}, "orange": {"sat": 18.0}}, "grading": {"highlights": {"hue": 40.0, "sat": 10.0, "lum": 0.0}}}],
  ["Seasons", "winter-blue", "Winter Blue", {"grading": {"shadows": {"hue": 215.0, "sat": 18.0, "lum": 0.0}, "highlights": {"hue": 205.0, "sat": 8.0, "lum": 0.0}}, "color": {"saturation": -12.0}, "light": {"whites": 12.0}}],
  ["Seasons", "spring-fresh", "Spring Fresh", {"mixer": {"green": {"hue": 10.0, "sat": 12.0, "lum": 10.0}, "magenta": {"sat": 10.0}}, "light": {"shadows": 15.0}, "color": {"vibrance": 15.0}}],
  ["Seasons", "summer-haze", "Summer Haze", {"effects": {"dehaze": -12.0}, "curve": {"shadows": 18.0}, "grading": {"highlights": {"hue": 45.0, "sat": 14.0, "lum": 0.0}}, "light": {"contrast": -10.0}}],
  ["Vintage", "instant-70s", "Instant ’70s", {"curve": {"shadows": 28.0, "highlights": -18.0}, "grading": {"shadows": {"hue": 170.0, "sat": 14.0, "lum": 0.0}, "highlights": {"hue": 45.0, "sat": 18.0, "lum": 0.0}}, "color": {"saturation": -10.0}, "vignette": {"amount": -15.0}, "grain": {"amount": 20.0, "size": 30.0, "roughness": 55.0}}],
  ["Vintage", "cross-process", "Cross Process", {"grading": {"shadows": {"hue": 230.0, "sat": 25.0, "lum": 0.0}, "highlights": {"hue": 60.0, "sat": 25.0, "lum": 0.0}}, "light": {"contrast": 22.0}, "color": {"saturation": 10.0}}],
  ["Vintage", "bleach-bypass", "Bleach Bypass", {"color": {"saturation": -40.0}, "light": {"contrast": 35.0, "highlights": -15.0}, "effects": {"clarity": 15.0}}],
  ["B&W", "bw-sepia", "Sepia Tone", {"treatment": "bw", "grading": {"shadows": {"hue": 32.0, "sat": 22.0, "lum": 0.0}, "highlights": {"hue": 42.0, "sat": 18.0, "lum": 0.0}}, "curve": {"shadows": 10.0}}],
];

/** LightCraft 부분 설정 → [[LiveShoot 경로, 값], …] */
function lcPaths(s) {
  const out = [], put = (p, v) => { if (typeof v === 'number' && isFinite(v)) out.push([p, v]); };
  for (const [k, v] of Object.entries(s.light || {})) put('light.' + k, v);
  for (const [k, v] of Object.entries(s.color || {})) put('color.' + k, v);
  for (const [k, v] of Object.entries(s.effects || {})) put('effects.' + k, v);
  for (const [k, v] of Object.entries(s.curve || {})) put('curve.region.' + k, v);   // LightCraft curve.shadows… = parametric 구간
  for (const [band, a] of Object.entries(s.mixer || {})) for (const [k, v] of Object.entries(a)) put(`mixer.${MIX[band]}.${{ hue: 'h', sat: 's', lum: 'l' }[k]}`, v);
  for (const [band, v] of Object.entries(s.bw_mix || {})) put(`bw.${MIX[band]}`, v);
  for (const [z, w] of Object.entries(s.grading || {})) {
    if (typeof w === 'number') put('grading.' + z, w);
    else for (const [k, v] of Object.entries(w)) put(`grading.${z}.${{ hue: 'h', sat: 's', lum: 'l' }[k]}`, v);
  }
  for (const [k, v] of Object.entries(s.vignette || {})) put('effects.vignette.' + k, v);
  for (const [k, v] of Object.entries(s.grain || {})) put('effects.grain.' + k, v);
  // 흰색 균형: LightCraft는 6500 K를 "찍은 그대로"로 둔 상대 눈금. mired 차이를 LiveShoot 색온도 슬라이더로 (1.5배, −100…100)
  if (s.wb && s.wb.temp) put('color.temp', Math.max(-100, Math.min(100, (1e6 / 6500 - 1e6 / s.wb.temp) * 1.5)));
  if (s.wb && s.wb.tint) put('color.tint', s.wb.tint);
  return out;
}

export const BUILTIN_PRESETS = DATA.map(([group, id, name, s]) => ({ id: 'lc.' + id, group, name, paths: lcPaths(s), treatment: s.treatment || null }));
export const BUILTIN_GROUPS = [...new Set(DATA.map((d) => d[0]))];

/** 기본 프리셋을 설정에 입힌다 (들어 있는 항목만) */
export function applyBuiltin(st, p) {
  for (const [path, v] of p.paths) {
    const ks = path.split('.'), last = ks.pop(), o = ks.reduce((a, k) => a && a[k], st);
    if (o && last in o) o[last] = v;
  }
  if (p.treatment) st.treatment = p.treatment;
}
