// 프로필: 사용자 슬라이더 "아래에" 깔리는 값 묶음. 슬라이더는 그대로 두고 강도(0–200 %)만큼 더한다.
// 같은 구조는 LightCraft profiles.rs와 Lightroom 프로필에서 왔고, 값과 Snap 묶음은 LiveShoot이 정함.

export const PROFILE_GROUPS = [
  ['basic', 'Basic'], ['film', 'Film'], ['cine', 'Cinematic'], ['snap', 'Snap'], ['bw', 'B&W'],
];

// d(경로, 값): 슬라이더에 더함 · w(구간, 색상각, 채도, 밝기): 컬러 그레이딩 휠에 색 벡터로 더함
// f(채널, 검정, 흰색): 커브 끝점을 들어 올리거나 내림(페이드) · bw(): 흑백
export const PROFILES = [
  { id: 'color', name: 'Color', ko: '표준', group: 'basic', apply: () => {} },
  { id: 'neutral', name: 'Neutral', ko: '뉴트럴', group: 'basic', apply: ({ d }) => { d('light.contrast', -15); d('color.saturation', -8); d('light.highlights', -8); d('light.shadows', 6); } },
  { id: 'vivid', name: 'Vivid', ko: '비비드', group: 'basic', apply: ({ d }) => { d('light.contrast', 15); d('color.vibrance', 18); d('color.saturation', 8); d('light.blacks', -5); } },
  { id: 'landscape', name: 'Landscape', ko: '풍경', group: 'basic', apply: ({ d }) => {
    d('light.contrast', 10); d('color.vibrance', 12); d('mixer.3.s', 12); d('mixer.4.s', 8); d('mixer.5.s', 12); d('mixer.5.l', -6); d('effects.clarity', 6); } },
  { id: 'portrait', name: 'Portrait', ko: '인물', group: 'basic', apply: ({ d }) => {
    d('light.contrast', -6); d('mixer.1.s', -8); d('mixer.1.l', 6); d('mixer.0.s', -4); d('effects.texture', -8); } },
  { id: 'mono', name: 'Monochrome', ko: '흑백', group: 'basic', apply: ({ d, bw }) => { bw(); d('light.contrast', 8); } },

  { id: 'warm-film', name: 'Warm Film', ko: '따뜻한 필름', group: 'film', apply: ({ d, w, f }) => {
    d('light.contrast', 6); d('color.saturation', -6); f('master', 0.04, 0.97); w('highlights', 40, 16, 0); w('shadows', 25, 8, 0); } },
  { id: 'cool-film', name: 'Cool Film', ko: '차가운 필름', group: 'film', apply: ({ d, w, f }) => {
    d('light.contrast', -6); d('color.saturation', -10); f('master', 0.06, 0.96); w('shadows', 205, 14, 0); w('highlights', 190, 6, 0); } },
  { id: 'faded-film', name: 'Faded Film', ko: '바랜 필름', group: 'film', apply: ({ d, f }) => {
    d('light.contrast', -14); d('color.saturation', -14); d('curve.region.shadows', 10); f('master', 0.09, 0.95); } },
  { id: 'golden-hour', name: 'Golden Hour', ko: '골든 아워', group: 'film', apply: ({ d, w }) => {
    d('color.vibrance', 10); d('color.temp', 12); d('mixer.1.s', 8); d('mixer.2.h', -6); w('global', 42, 8, 0); w('highlights', 35, 18, 0); } },

  { id: 'teal-orange', name: 'Teal & Orange', ko: '틸 앤 오렌지', group: 'cine', apply: ({ d, w }) => {
    d('light.contrast', 10); d('mixer.1.s', 6); d('mixer.3.h', 18); d('mixer.3.s', -18); d('mixer.5.h', -8); w('shadows', 195, 28, 0); w('highlights', 38, 22, 0); } },
  { id: 'night-blue', name: 'Night Blue', ko: '나이트 블루', group: 'cine', apply: ({ d, w }) => {
    d('light.contrast', 12); d('color.saturation', -12); d('curve.region.darks', -8); w('shadows', 220, 26, -4); w('midtones', 215, 8, 0); } },
  { id: 'desert', name: 'Desert', ko: '사막', group: 'cine', apply: ({ d, w }) => {
    d('light.contrast', 8); d('curve.region.lights', 6); d('mixer.5.s', -24); d('mixer.4.s', -18); w('global', 32, 14, 0); w('highlights', 48, 10, 0); } },
  { id: 'neon', name: 'Neon', ko: '네온', group: 'cine', apply: ({ d, w }) => {
    d('light.contrast', 10); d('color.vibrance', 18); d('mixer.7.s', 12); d('mixer.6.s', 12); w('shadows', 265, 20, 0); w('highlights', 330, 12, 0); } },

  { id: 'bright-wedding', name: 'Bright Wedding', ko: '밝은 웨딩', group: 'snap', apply: ({ d, w, f }) => {
    d('light.exposure', 0.25); d('light.contrast', -10); d('light.highlights', -15); d('light.shadows', 15); d('light.whites', 8);
    d('color.vibrance', 6); d('mixer.1.l', 6); f('master', 0.02, 1); w('highlights', 45, 6, 0); } },
  { id: 'cherry-blossom', name: 'Cherry Blossom', ko: '벚꽃', group: 'snap', apply: ({ d, w, f }) => {
    d('light.contrast', -8); d('color.temp', -4); d('color.tint', 6); d('mixer.0.l', 8); d('mixer.7.l', 8); d('mixer.6.s', -6); d('mixer.3.s', -15);
    f('master', 0.03, 1); w('highlights', 340, 6, 0); } },
  { id: 'clean-skin', name: 'Clean Skin', ko: '깨끗한 피부', group: 'snap', apply: ({ d }) => {
    d('light.contrast', -4); d('effects.texture', -12); d('effects.clarity', -6); d('mixer.1.s', -10); d('mixer.1.l', 8); d('mixer.0.s', -6); } },
  { id: 'moody', name: 'Moody', ko: '무디', group: 'snap', apply: ({ d, w, f }) => {
    d('light.exposure', -0.2); d('light.contrast', 12); d('color.saturation', -16); d('mixer.3.s', -30); d('mixer.3.l', -10); d('mixer.2.s', -15);
    d('curve.region.shadows', -6); f('master', 0.05, 1); w('shadows', 200, 10, 0); } },

  { id: 'bw-rich', name: 'Rich', ko: '진한 흑백', group: 'bw', apply: ({ d, bw }) => {
    bw(); d('light.contrast', 18); d('curve.region.darks', -8); d('curve.region.lights', 6); d('bw.0', 8); d('bw.1', 10); d('bw.5', -12); } },
  { id: 'bw-red', name: 'Red Filter', ko: '레드 필터', group: 'bw', apply: ({ d, bw }) => {
    bw(); d('light.contrast', 12); d('bw.0', 40); d('bw.1', 30); d('bw.2', 10); d('bw.3', -20); d('bw.4', -30); d('bw.5', -45); } },
  { id: 'bw-soft', name: 'Soft', ko: '부드러운 흑백', group: 'bw', apply: ({ d, bw, f }) => { bw(); d('light.contrast', -14); d('bw.1', 12); f('master', 0.06, 0.97); } },
  { id: 'bw-sepia', name: 'Sepia', ko: '세피아', group: 'bw', apply: ({ d, bw, w, f }) => {
    bw(); d('light.contrast', 6); f('master', 0.04, 0.98); w('shadows', 28, 18, 0); w('highlights', 45, 14, 0); } },
];

const BY_ID = Object.fromEntries(PROFILES.map((p) => [p.id, p]));
export const profileById = (id) => BY_ID[id] || BY_ID.color;

const RANGE = { 'light.exposure': [-5, 5], 'color.temp': [-100, 100] };

/** 렌더에 실제로 쓰는 설정 = 사용자 설정 + 프로필 × 강도 */
export function effective(st) {
  const p = BY_ID[st.profile?.id];
  const k = Math.min(2, Math.max(0, (st.profile?.amount ?? 100) / 100));
  const e = structuredClone(st);
  e._fade = { master: [0, 1], r: [0, 1], g: [0, 1], b: [0, 1] };
  if (!p || p.id === 'color' || k === 0) return e;
  const get = (path) => path.split('.').reduce((a, x) => a[x], e);
  const set = (path, v) => { const ks = path.split('.'), last = ks.pop(); ks.reduce((a, x) => a[x], e)[last] = v; };
  p.apply({
    d: (path, v) => { const [lo, hi] = RANGE[path] || [-100, 100]; set(path, Math.min(hi, Math.max(lo, get(path) + v * k))); },
    w: (zone, hue, sat, lum) => {   // 휠은 색 벡터로 더해 사용자 휠과 섞임
      const z = e.grading[zone], r = Math.PI / 180;
      const a = z.s * Math.cos(z.h * r) + sat * k * Math.cos(hue * r), b = z.s * Math.sin(z.h * r) + sat * k * Math.sin(hue * r);
      const s = Math.hypot(a, b);
      if (s > 1e-6) z.h = ((Math.atan2(b, a) / r) % 360 + 360) % 360;
      z.s = Math.min(100, s);
      z.l = Math.min(100, Math.max(-100, z.l + lum * k));
    },
    f: (ch, black, white) => { e._fade[ch] = [Math.min(0.45, black * k), Math.max(0.55, 1 - (1 - white) * k)]; },
    bw: () => { e.treatment = 'bw'; },
  });
  return e;
}
