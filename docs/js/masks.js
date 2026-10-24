// 마스크(국소 보정): 선형 · 원형 · 브러시 · 밝기 범위 · 색 범위.
// LightCraft (https://github.com/storytold/lightcraft, MIT OR Apache-2.0)의 crates/pipeline/src/masks.rs를 따랐다:
// 모양마다 알파를 만들고 성분을 더하기(max) · 빼기(a·(1−c)) · 교차(a·c)로 합친 뒤 반전·양(Amount)을 곱한다.
// 마스크의 보정값은 전역 슬라이더 위에 더해진다 (Lightroom과 같음). 셰이더는 gl.js의 maskAlphas().
//
// 좌표: 자르기·회전 전 원본의 정규화 좌표 (u, v: 0–1, v는 아래로). 자르거나 돌려도 마스크가 사진 내용에 붙어 있다.
// 거리(원형 반지름, 브러시 크기)는 원본 긴 변을 1로 한 단위.

export const MAX_MASKS = 4, MAX_COMPS = 4;

export const SHAPES = {
  linear: { code: 1, name: '선형' },
  radial: { code: 2, name: '원형' },
  luminance: { code: 3, name: '밝기 범위' },
  color: { code: 4, name: '색 범위' },
  brush: { code: 5, name: '브러시' },
};
export const OPS = [['add', '더하기'], ['subtract', '빼기'], ['intersect', '교차']];

/** 마스크 보정 항목: [키, 이름, 최소, 최대, 단계] (값은 전역 슬라이더 단위) */
export const ADJUST = [
  ['exposure', '노출 Exposure', -4, 4, 0.01], ['contrast', '대비 Contrast', -100, 100, 1],
  ['highlights', '하이라이트 Highlights', -100, 100, 1], ['shadows', '섀도 Shadows', -100, 100, 1],
  ['whites', 'Whites', -100, 100, 1], ['blacks', 'Blacks', -100, 100, 1],
  ['temp', '색온도 Temp', -100, 100, 1], ['tint', '색조 Tint', -100, 100, 1],
  ['saturation', '채도 Saturation', -100, 100, 1], ['texture', 'Texture', -100, 100, 1],
  ['clarity', 'Clarity', -100, 100, 1], ['dehaze', 'Dehaze', -100, 100, 1],
  ['sharpness', '선명도 Sharpness', -100, 100, 1], ['noise', '노이즈 Noise', -100, 100, 1],
];

export function newShape(type) {
  switch (type) {
    case 'linear': return { type, a: [0.5, 0.25], b: [0.5, 0.6] };   // a에서 1, b에서 0
    case 'radial': return { type, c: [0.5, 0.5], rx: 0.2, ry: 0.2, angle: 0, feather: 50 };
    case 'luminance': return { type, lo: 0, hi: 0.5, loFeather: 0.05, hiFeather: 0.15 };
    case 'color': return { type, sample: null, refine: 50 };
    case 'brush': return { type, strokes: [] };
  }
  throw new Error('모르는 마스크 모양: ' + type);
}

export function newMask(type, n) {
  return {
    id: crypto.randomUUID(), name: `${SHAPES[type].name} ${n}`, visible: true, invert: false, amount: 100,
    comps: [{ op: 'add', invert: false, shape: newShape(type) }],
    adjust: Object.fromEntries(ADJUST.map(([k]) => [k, 0])),
  };
}

// ---------- 색 (OkLab, Björn Ottosson 2020) ----------

const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
/** sRGB 부호화 0–1 → OkLab */
export function oklab([r, g, b]) {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
/** 색 범위 허용 거리 (LightCraft color_range_tolerance: Refine 0–100 → 0.015–0.075) */
export const colorTolerance = (refine) => 0.015 + 0.06 * Math.min(1, Math.max(0, refine / 100));

// ---------- 셰이더 uniform ----------

/**
 * 보이는 마스크(최대 4개, 성분 최대 4개)를 uniform 배열로.
 * aspect: 원본 [가로/긴 변, 세로/긴 변]. 돌려주는 값은 gl.js draw()가 그대로 넣는다.
 */
export function packMasks(masks, aspect) {
  const list = (masks || []).filter((m) => m.visible && m.comps.length).slice(0, MAX_MASKS);
  const ct = new Float32Array(MAX_MASKS * MAX_COMPS * 4), cp = new Float32Array(ct.length), cq = new Float32Array(ct.length);
  const amt = [0, 0, 0, 0], inv = [0, 0, 0, 0], adj = ADJUST.map(() => [0, 0, 0, 0]);
  const [ax, ay] = aspect, brushes = [];
  list.forEach((m, mi) => {
    amt[mi] = Math.min(1, Math.max(0, (m.amount ?? 100) / 100));
    inv[mi] = m.invert ? 1 : 0;
    ADJUST.forEach(([k], j) => { adj[j][mi] = m.adjust[k] || 0; });
    m.comps.slice(0, MAX_COMPS).forEach((c, ci) => {
      const i = (mi * MAX_COMPS + ci) * 4, s = c.shape, code = SHAPES[s.type]?.code || 0;
      if (s.type === 'color' && !s.sample) return;   // 아직 색을 안 골랐으면 비움
      let ch = 0;
      if (s.type === 'brush') { if (brushes.length >= 4) return; ch = brushes.length; brushes.push(s); }   // 브러시 성분마다 채널 하나 (R·G·B·A)
      ct.set([code, OPS.findIndex((o) => o[0] === c.op), c.invert ? 1 : 0, ch], i);
      if (s.type === 'linear') cp.set([s.a[0] * ax, s.a[1] * ay, s.b[0] * ax, s.b[1] * ay], i);
      else if (s.type === 'radial') { cp.set([s.c[0] * ax, s.c[1] * ay, s.rx, s.ry], i); cq.set([s.angle * Math.PI / 180, s.feather / 100, 0, 0], i); }
      else if (s.type === 'luminance') cp.set([s.lo, s.hi, Math.max(s.loFeather, 1e-3), Math.max(s.hiFeather, 1e-3)], i);
      else if (s.type === 'color') cp.set([...s.sample, colorTolerance(s.refine)], i);
    });
  });
  return { n: list.length, ct, cp, cq, amt, inv, adj: adj.flat(), brushKey: JSON.stringify(brushes.map((s) => s.strokes)), brushes };
}

// ---------- 브러시 ----------

/**
 * 브러시 성분마다 그 성분의 채널(R·G·B·A, 화면 전체에서 4개까지)에 획을 그린다. 결과: 긴 변 1024 px RGBA, 원본 좌표.
 * 성분마다 따로라서 한 마스크 안에서 브러시끼리 빼기·교차를 해도 서로 섞이지 않는다.
 * 획: { pts: [[u, v], …], size(긴 변 대비 반지름), feather 0–100, flow 0–100, erase }
 */
export function rasterBrush(brushes, aspect) {
  const L = 1024, W = Math.max(1, Math.round(L * aspect[0])), H = Math.max(1, Math.round(L * aspect[1]));
  const out = new Uint8Array(W * H * 4);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  brushes.forEach((shape, mi) => {
    const strokes = shape.strokes;
    if (!strokes.length) return;
    x.globalCompositeOperation = 'source-over';
    x.clearRect(0, 0, W, H);
    for (const s of strokes) {
      const r = Math.max(0.5, s.size * L), hard = 1 - Math.min(1, Math.max(0, s.feather / 100)), a = Math.min(1, Math.max(0.01, s.flow / 100));
      x.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
      const dab = (px, py) => {
        const g = x.createRadialGradient(px, py, r * hard * 0.999, px, py, r);
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g;
        x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
      };
      const P = s.pts.map(([u, v]) => [u * W, v * H]);
      if (P.length) dab(...P[0]);
      for (let i = 1; i < P.length; i++) {   // 반지름의 1/4 간격으로 찍기
        const [x0, y0] = P[i - 1], [x1, y1] = P[i], d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / Math.max(1, r / 4));
        for (let k = 1; k <= n; k++) dab(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n);
      }
    }
    const d = x.getImageData(0, 0, W, H).data;
    for (let i = 0; i < W * H; i++) out[i * 4 + mi] = d[i * 4 + 3];
  });
  return { data: out, w: W, h: H };
}
