// Lightroom·Camera Raw 프리셋(.xmp)의 crs: 값을 LiveShoot 보정값으로 옮긴다. 무료 Lightroom 프리셋을 그대로 쓰기 위함.
// 슬라이더 이름과 범위가 같은 것은 그대로, 다른 것은 가장 가까운 슬라이더로 옮긴다. 옮기지 못한 항목은 돌려준다.

import { defaults } from './store.js';

const BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];

// crs 이름 → [보정값 경로, 변환]
const MAP = {
  Exposure2012: ['light.exposure', Number],
  Contrast2012: ['light.contrast', Number],
  Highlights2012: ['light.highlights', Number],
  Shadows2012: ['light.shadows', Number],
  Whites2012: ['light.whites', Number],
  Blacks2012: ['light.blacks', Number],
  IncrementalTemperature: ['color.temp', Number],
  IncrementalTint: ['color.tint', Number],
  Vibrance: ['color.vibrance', Number],
  Saturation: ['color.saturation', Number],
  Texture: ['effects.texture', Number],
  Clarity2012: ['effects.clarity', Number],
  Dehaze: ['effects.dehaze', Number],
  ParametricShadows: ['curve.region.shadows', Number],
  ParametricDarks: ['curve.region.darks', Number],
  ParametricLights: ['curve.region.lights', Number],
  ParametricHighlights: ['curve.region.highlights', Number],
  ColorGradeBlending: ['grading.blending', Number],
  ColorGradeBalance: ['grading.balance', Number],
  SplitToningBalance: ['grading.balance', Number],
  GrainAmount: ['effects.grain.amount', Number],
  GrainSize: ['effects.grain.size', Number],
  GrainFrequency: ['effects.grain.roughness', Number],
  PostCropVignetteAmount: ['effects.vignette.amount', Number],
  PostCropVignetteMidpoint: ['effects.vignette.midpoint', Number],
  PostCropVignetteFeather: ['effects.vignette.feather', Number],
  PostCropVignetteRoundness: ['effects.vignette.roundness', Number],
  PostCropVignetteHighlightContrast: ['effects.vignette.highlights', Number],
  Sharpness: ['detail.sharpen.amount', Number],
  SharpenRadius: ['detail.sharpen.radius', Number],
  SharpenDetail: ['detail.sharpen.detail', Number],
  SharpenEdgeMasking: ['detail.sharpen.masking', Number],
  LuminanceSmoothing: ['detail.nr.amount', Number],
  LuminanceNoiseReductionDetail: ['detail.nr.detail', Number],
  LuminanceNoiseReductionContrast: ['detail.nr.contrast', Number],
  ColorNoiseReduction: ['detail.cnr.amount', Number],
  ColorNoiseReductionDetail: ['detail.cnr.detail', Number],
  ColorNoiseReductionSmoothness: ['detail.cnr.smoothness', Number],
};
BANDS.forEach((b, i) => {
  MAP['HueAdjustment' + b] = [`mixer.${i}.h`, Number];
  MAP['SaturationAdjustment' + b] = [`mixer.${i}.s`, Number];
  MAP['LuminanceAdjustment' + b] = [`mixer.${i}.l`, Number];
  MAP['GrayMixer' + b] = [`bw.${i}`, Number];
});
for (const [lr, z] of [['Shadow', 'shadows'], ['Midtone', 'midtones'], ['Highlight', 'highlights'], ['Global', 'global']]) {
  MAP[`ColorGrade${lr}Hue`] = [`grading.${z}.h`, Number];
  MAP[`ColorGrade${lr}Sat`] = [`grading.${z}.s`, Number];
  MAP[`ColorGrade${lr}Lum`] = [`grading.${z}.l`, Number];
}
// 예전 Split Toning (Lightroom 10 이전): 섀도·하이라이트 휠로
MAP.SplitToningShadowHue = ['grading.shadows.h', Number];
MAP.SplitToningShadowSaturation = ['grading.shadows.s', Number];
MAP.SplitToningHighlightHue = ['grading.highlights.h', Number];
MAP.SplitToningHighlightSaturation = ['grading.highlights.s', Number];

// 값을 옮기지 않는 정보 항목 (이름·버전·지원 표시 등)
const META = /^(Version|ProcessVersion|Name|ShortName|SortName|Group|Cluster|UUID|Description|Copyright|ContactInfo|PresetType|HasSettings|RequiresRGBTables|CameraModelRestriction|Supports\w*|ToneCurveName2012|ToneCurveName|Look\w*|AlreadyApplied|ParametricShadowSplit|ParametricMidtoneSplit|ParametricHighlightSplit|WhiteBalance|Temperature|Tint|CameraProfile)$/;

const RANGE = { 'light.exposure': [-5, 5], 'detail.sharpen.amount': [0, 150], 'detail.sharpen.radius': [0.5, 3], 'effects.grain.amount': [0, 100], 'effects.grain.size': [0, 100], 'effects.grain.roughness': [0, 100],
  'grading.blending': [0, 100], 'effects.vignette.midpoint': [0, 100], 'effects.vignette.feather': [0, 100], 'effects.vignette.highlights': [0, 100] };

/** XMP 문자열 → { name, settings, used: [crs 이름], skipped: [crs 이름] } */
export function parseXMP(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XMP(XML)를 읽을 수 없음');
  const CRS = 'http://ns.adobe.com/camera-raw-settings/1.0/';
  const vals = {}, curves = {};
  for (const node of doc.getElementsByTagName('*')) {
    for (const a of node.attributes) if (a.namespaceURI === CRS) vals[a.localName] = a.value;
    if (node.namespaceURI === CRS) {
      const lis = [...node.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li')];
      if (/^ToneCurvePV2012/.test(node.localName)) curves[node.localName] = lis.map((li) => li.textContent.split(',').map(Number));
      else if (!lis.length && node.children.length === 0 && node.textContent.trim()) vals[node.localName] = node.textContent.trim();
    }
  }
  const st = defaults();
  st.autoExposure = false;   // 프리셋은 노출을 직접 정함
  const used = [], skipped = [];
  const set = (path, v) => {
    const [lo, hi] = RANGE[path] || (path.endsWith('.h') && path.startsWith('grading') ? [0, 360] : [-100, 100]);
    const ks = path.split('.'), last = ks.pop();
    ks.reduce((o, k) => o[k], st)[last] = Math.min(hi, Math.max(lo, v));
  };
  for (const [k, v] of Object.entries(vals)) {
    if (MAP[k]) { const x = MAP[k][1](v); if (isFinite(x)) { set(MAP[k][0], x); used.push(k); } }
    else if (k === 'ConvertToGrayscale') { if (v === 'True') st.treatment = 'bw'; used.push(k); }
    else if (!META.test(k)) skipped.push(k);
  }
  // 톤 커브 (0–255 점) → 0–1
  for (const [k, ch] of [['ToneCurvePV2012', 'rgb'], ['ToneCurvePV2012Red', 'r'], ['ToneCurvePV2012Green', 'g'], ['ToneCurvePV2012Blue', 'b']]) {
    const pts = curves[k];
    if (pts && pts.length >= 2 && pts.every((p) => p.length === 2 && p.every(isFinite))) { st.curve[ch] = pts.map(([x, y]) => [x / 255, y / 255]); used.push(k); }
  }
  // Split Toning만 있는 예전 프리셋은 섞임 정도가 Lightroom과 비슷하게
  if (vals.SplitToningShadowHue && !vals.ColorGradeBlending) st.grading.blending = 100;
  // 흰색 균형 값이 "As Shot"이 아닌 절대 K는 사진마다 의미가 달라 옮기지 않음
  if (vals.Temperature && !vals.IncrementalTemperature) skipped.push('Temperature(K)');
  // 묶음 이름(crs:Group): rdf:Alt 안 글자라 따로 읽음
  const grp = doc.getElementsByTagNameNS(CRS, 'Group')[0];
  const group = (vals.Group || (grp && grp.textContent) || '').trim() || null;
  return { name: vals.Name || null, group, settings: st, used, skipped };
}
