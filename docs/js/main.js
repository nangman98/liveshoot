import { Pipeline } from './gl.js';
import { store, defaults, withDefaults, clone } from './store.js';
import { CurveEditor } from './curve.js';
import { loadImage, toCanvas, renderJPEG, download, canShareFiles, driveConfig, saveDriveConfig, driveToken, pickDriveFolder, uploadToDrive } from './export.js';

export const VERSION = 'v2';
const PREVIEW = 2048;   // 화면용 긴 변 (px)

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const getP = (o, p) => p.split('.').reduce((a, k) => a[k], o);
const setP = (o, p, v) => { const ks = p.split('.'), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

const app = {
  photos: [], cur: null, preview: null, pipe: null, original: false, picking: null,
  clipboard: null, thumbs: new Map(), syncers: [], curve: null,
  follow: true, carry: localStorage.getItem('ls.carry') === '1',
  exportEdge: +(localStorage.getItem('ls.edge') || 2400), quality: +(localStorage.getItem('ls.q') || 85),
  dest: localStorage.getItem('ls.dest') || 'share',
};

// ---------- 공통 ----------

function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(el('span', null, msg));
  if (action) {
    const b = el('button', 'btn primary', action.label);
    b.onclick = () => { action.run(); t.classList.remove('show'); };
    t.append(b);
  }
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), action ? 15000 : 2600);
}

function startSettings() {
  const d = localStorage.getItem('ls.default');
  return d ? withDefaults(JSON.parse(d)) : defaults();
}

/** 64 px로 줄인 그림의 log 평균 휘도를 중간 회색(선형 0.18)에 맞추는 EV, ±2.5 */
function autoEV(canvas) {
  const c = toCanvas(canvas, 64), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  let s = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    s += Math.log(Math.max(1e-4, 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2])));
    n++;
  }
  return Math.max(-2.5, Math.min(2.5, Math.log2(0.18 / Math.exp(s / n))));
}

let saveTimer;
function changed() {
  scheduleRender();
  if (!app.cur) return;
  app.cur.exported = false;
  clearTimeout(saveTimer);
  const m = app.cur;
  saveTimer = setTimeout(() => store.putMeta(m), 400);
}

let raf = 0, histT = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!app.cur || !app.preview) return;
    app.pipe.draw(app.cur.settings, app.cur.autoEV, app.original);
    const now = performance.now();
    if (now - histT > 180) { histT = now; drawHist(app.pipe.histogram()); }
    else { clearTimeout(scheduleRender.h); scheduleRender.h = setTimeout(() => drawHist(app.pipe.histogram()), 200); }
  });
}

function drawHist(H) {
  const c = $('#hist'), dpr = devicePixelRatio || 1, W = c.clientWidth * dpr, Hh = c.clientHeight * dpr;
  c.width = W; c.height = Hh;
  const g = c.getContext('2d'), mx = Math.max(...H.r, ...H.g, ...H.b, 1);
  g.fillStyle = '#1c1c1e'; g.fillRect(0, 0, W, Hh);
  g.globalCompositeOperation = 'lighter';
  for (const [k, col] of [['r', 'rgba(255,80,80,0.75)'], ['g', 'rgba(80,220,100,0.75)'], ['b', 'rgba(80,140,255,0.75)']]) {
    g.fillStyle = col;
    g.beginPath(); g.moveTo(0, Hh);
    H[k].forEach((v, i) => g.lineTo((i + 0.5) / 64 * W, Hh - Math.sqrt(v / mx) * Hh * 0.95));
    g.lineTo(W, Hh); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  if (app.curve) { app.curve.hist = H; app.curve.draw(); }
}

// ---------- 사진 목록 ----------

async function importFiles(files) {
  let n = 0;
  for (const f of files) {
    try {
      const img = await loadImage(f);
      const c = toCanvas(img, PREVIEW);
      const thumb = await new Promise((r) => toCanvas(c, 240).toBlob(r, 'image/jpeg', 0.8));
      const settings = app.carry && app.cur ? clone(app.cur.settings) : startSettings();
      const meta = {
        id: crypto.randomUUID(), name: f.name || `photo_${Date.now()}.jpg`, added: Date.now(),
        w: img.naturalWidth, h: img.naturalHeight, autoEV: autoEV(c), settings, liked: false, exported: false, thumb,
      };
      await store.putBlob(meta.id, f);
      await store.putMeta(meta);
      app.photos.unshift(meta);
      n++;
      if (app.follow || !app.cur) await select(meta.id, c);
      else renderStrip();
    } catch (e) {
      toast(`열 수 없는 사진: ${f.name} (RAW는 Mac mini에서 보정)`);
    }
  }
  renderStrip();
  if (n) toast(`${n}장 가져옴`);
}

async function select(id, ready) {
  const m = app.photos.find((p) => p.id === id);
  if (!m) return;
  app.cur = m;
  let c = ready;
  if (!c) {
    const blob = await store.getBlob(id);
    c = toCanvas(await loadImage(blob), PREVIEW);
  }
  app.preview = c;
  app.pipe.setPreview(c, c.width, c.height, m.settings.detail.sharpen.radius);
  document.body.classList.add('has-photo');
  syncAll();
  scheduleRender();
  renderStrip();
  $('#photoName').textContent = `${m.name} · ${m.w}×${m.h}`;
  $('#heart').textContent = m.liked ? '♥' : '♡';
}

function renderStrip() {
  const s = $('#strip');
  s.replaceChildren();
  for (const m of app.photos) {
    const d = el('button', 'thumb' + (app.cur && m.id === app.cur.id ? ' on' : ''));
    if (!app.thumbs.has(m.id) && m.thumb) app.thumbs.set(m.id, URL.createObjectURL(m.thumb));
    const img = el('img');
    img.src = app.thumbs.get(m.id) || '';
    img.alt = m.name;
    d.append(img);
    if (m.liked) d.append(el('span', 'badge heart', '♥'));
    if (m.exported) d.append(el('span', 'badge done', '✓'));
    d.onclick = () => { app.follow = m.id === app.photos[0]?.id; $('#follow').checked = app.follow; select(m.id); };
    s.append(d);
  }
  $('#count').textContent = `${app.photos.length}장 · 하트 ${app.photos.filter((p) => p.liked).length}`;
  $('#empty').style.display = app.photos.length ? 'none' : '';
}

function toggleLike(m = app.cur) {
  if (!m) return;
  m.liked = !m.liked;
  store.putMeta(m);
  if (m === app.cur) $('#heart').textContent = m.liked ? '♥' : '♡';
  renderStrip();
}

// ---------- 패널 ----------

function syncAll() { for (const f of app.syncers) f(); if (app.curve) app.curve.draw(); }

function slider({ label, path, min, max, step = 1, fmt, track }) {
  const def = getP(defaults(), path);
  const row = el('div', 'sl');
  const top = el('div', 'sl-top'), name = el('span', 'sl-name', label), val = el('span', 'sl-val');
  const input = el('input');
  Object.assign(input, { type: 'range', min, max, step });
  if (track) input.style.setProperty('--track', track);
  top.append(name, val);
  row.append(top, input);
  const show = (v) => { val.textContent = fmt ? fmt(v) : (v > 0 ? '+' : '') + Math.round(v); };
  const sync = () => { const v = app.cur ? getP(app.cur.settings, path) : def; input.value = v; show(+v); };
  input.addEventListener('input', () => { if (!app.cur) return; setP(app.cur.settings, path, +input.value); show(+input.value); changed(); });
  const reset = () => { if (!app.cur) return; setP(app.cur.settings, path, def); sync(); changed(); };
  // 두 번 누르면 기본값 (끌기는 제외)
  let last = 0, x0 = 0;
  row.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
  row.addEventListener('pointerup', (e) => {
    if (Math.abs(e.clientX - x0) > 6) { last = 0; return; }
    const now = Date.now();
    if (now - last < 330) { reset(); last = 0; } else last = now;
  });
  app.syncers.push(sync);
  return row;
}

function section(title, resetPaths, ...children) {
  const d = el('details', 'sec');
  d.open = localStorage.getItem('ls.open.' + title) !== '0';
  d.addEventListener('toggle', () => localStorage.setItem('ls.open.' + title, d.open ? '1' : '0'));
  const sum = el('summary', null);
  sum.append(el('span', null, title));
  if (resetPaths) {
    const r = el('button', 'mini', '초기화');
    r.onclick = (e) => {
      e.preventDefault();
      if (!app.cur) return;
      const d0 = defaults();
      for (const p of resetPaths) setP(app.cur.settings, p, clone(getP(d0, p)));
      syncAll(); changed();
    };
    sum.append(r);
  }
  d.append(sum, ...children);
  return d;
}

const sub = (t) => el('div', 'subhead', t);
const pct = (v) => Math.round(v) + '';
const signed = (v) => (v > 0 ? '+' : '') + Math.round(v);
const HUES = 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)';
const BANDS = [['빨강', '#e5484d'], ['주황', '#f08c2e'], ['노랑', '#e8c547'], ['초록', '#4cb050'], ['아쿠아', '#3cc6c8'], ['파랑', '#3e7be0'], ['보라', '#8a5cd8'], ['마젠타', '#d14fb4']];

function tabs(names, onPick) {
  const bar = el('div', 'tabs');
  const btns = names.map((n, i) => {
    const b = el('button', i === 0 ? 'on' : '', n);
    b.onclick = () => { btns.forEach((x) => x.classList.toggle('on', x === b)); onPick(i); };
    bar.append(b);
    return b;
  });
  return bar;
}

function buildPanel() {
  const P = $('#panel');

  // 히스토그램 + 기본
  const hist = el('canvas'); hist.id = 'hist';
  const autoBox = el('label', 'chk');
  const autoIn = el('input'); autoIn.type = 'checkbox';
  autoIn.onchange = () => { if (app.cur) { app.cur.settings.autoExposure = autoIn.checked; changed(); syncAll(); } };
  const autoTxt = el('span');
  autoBox.append(autoIn, autoTxt);
  app.syncers.push(() => {
    autoIn.checked = app.cur ? app.cur.settings.autoExposure : true;
    autoTxt.textContent = '자동 노출' + (app.cur ? ` (${app.cur.autoEV >= 0 ? '+' : ''}${app.cur.autoEV.toFixed(2)} EV)` : '');
  });

  const row1 = el('div', 'btnrow');
  const b = (t, f, cls = '') => { const x = el('button', 'btn ' + cls, t); x.onclick = f; return x; };
  row1.append(
    b('복사', () => { if (app.cur) { app.clipboard = clone(app.cur.settings); toast('보정을 복사함'); } }),
    b('붙여넣기', () => { if (app.cur && app.clipboard) { app.cur.settings = clone(app.clipboard); syncAll(); changed(); } }),
    b('전체 초기화', () => { if (app.cur) { app.cur.settings = defaults(); syncAll(); changed(); } }),
  );
  const row2 = el('div', 'btnrow');
  row2.append(
    b('새 사진 기본으로 저장', () => { if (app.cur) { localStorage.setItem('ls.default', JSON.stringify(app.cur.settings)); toast('새 사진의 출발점으로 저장함'); } }),
  );
  const carry = el('label', 'chk');
  const carryIn = el('input'); carryIn.type = 'checkbox'; carryIn.checked = app.carry;
  carryIn.onchange = () => { app.carry = carryIn.checked; localStorage.setItem('ls.carry', app.carry ? '1' : '0'); };
  carry.append(carryIn, el('span', null, '새 사진에 지금 보정 이어 쓰기'));

  // 프리셋
  const pre = el('div', 'btnrow');
  const sel = el('select');
  const presets = () => JSON.parse(localStorage.getItem('ls.presets') || '{}');
  const fillPresets = () => {
    sel.replaceChildren(el('option', null, '프리셋 고르기'));
    for (const k of Object.keys(presets())) { const o = el('option', null, k); o.value = k; sel.append(o); }
  };
  fillPresets();
  sel.onchange = () => {
    const p = presets()[sel.value];
    if (p && app.cur) { app.cur.settings = withDefaults(p); syncAll(); changed(); toast(`프리셋 '${sel.value}' 적용`); }
    sel.selectedIndex = 0;
  };
  pre.append(sel,
    b('저장', () => {
      if (!app.cur) return;
      const n = prompt('프리셋 이름');
      if (!n) return;
      const all = presets(); all[n] = app.cur.settings;
      localStorage.setItem('ls.presets', JSON.stringify(all)); fillPresets();
    }),
    b('삭제', () => {
      const all = presets(), names = Object.keys(all);
      const n = prompt('지울 프리셋 이름\n' + names.join(', '));
      if (n && all[n]) { delete all[n]; localStorage.setItem('ls.presets', JSON.stringify(all)); fillPresets(); }
    }));

  P.append(section('기본', null, hist, autoBox, row1, row2, carry, pre));

  // Light
  P.append(section('Light', ['light'],
    slider({ label: '노출 Exposure', path: 'light.exposure', min: -5, max: 5, step: 0.01, fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + ' EV' }),
    slider({ label: '대비 Contrast', path: 'light.contrast', min: -100, max: 100 }),
    slider({ label: '하이라이트 Highlights', path: 'light.highlights', min: -100, max: 100 }),
    slider({ label: '섀도 Shadows', path: 'light.shadows', min: -100, max: 100 }),
    slider({ label: 'Whites', path: 'light.whites', min: -100, max: 100 }),
    slider({ label: 'Blacks', path: 'light.blacks', min: -100, max: 100 }),
  ));

  // Curve
  const cv = el('canvas', 'curve');
  app.curve = new CurveEditor(cv, (ch) => app.cur ? app.cur.settings.curve[ch] : [[0, 0], [1, 1]], () => { app.curve.draw(); changed(); });
  const chs = ['rgb', 'r', 'g', 'b'];
  P.append(section('Curve', ['curve'],
    tabs(['RGB', 'R', 'G', 'B'], (i) => { app.curve.channel = chs[i]; app.curve.draw(); }),
    cv,
    el('div', 'hint', '빈 곳을 누르면 점 추가 · 점을 두 번 누르면 삭제'),
    slider({ label: 'Refine Saturation', path: 'curve.refineSat', min: 0, max: 100, fmt: pct }),
  ));

  // Color
  const wbPick = b('화이트밸런스 스포이트', () => startPick('wb'));
  P.append(section('Color', ['color'],
    wbPick,
    slider({ label: '색온도 Temp', path: 'color.temp', min: -100, max: 100, track: 'linear-gradient(90deg,#4a7bd6,#ddd,#e0b23a)' }),
    slider({ label: '색조 Tint', path: 'color.tint', min: -100, max: 100, track: 'linear-gradient(90deg,#3fb24f,#ddd,#c84fc0)' }),
    slider({ label: 'Vibrance', path: 'color.vibrance', min: -100, max: 100 }),
    slider({ label: '채도 Saturation', path: 'color.saturation', min: -100, max: 100 }),
  ));

  // Color Mixer
  const groups = ['h', 's', 'l'].map((k) => {
    const g = el('div', 'group');
    BANDS.forEach(([n, col], i) => g.append(slider({ label: n, path: `mixer.${i}.${k}`, min: -100, max: 100, track: `linear-gradient(90deg,#555,${col})` })));
    return g;
  });
  groups.forEach((g, i) => { g.hidden = i > 0; });
  P.append(section('Color Mixer', ['mixer'],
    tabs(['Hue', 'Saturation', 'Luminance'], (i) => groups.forEach((g, j) => { g.hidden = j !== i; })),
    ...groups,
  ));

  // Point Color
  const sw = el('div', 'swatch');
  const ptAct = el('label', 'chk');
  const ptIn = el('input'); ptIn.type = 'checkbox';
  ptIn.onchange = () => { if (app.cur) { app.cur.settings.point.active = ptIn.checked; changed(); } };
  ptAct.append(ptIn, el('span', null, '켜기'));
  app.syncers.push(() => {
    const p = app.cur ? app.cur.settings.point : defaults().point;
    ptIn.checked = p.active;
    sw.style.background = p.swatch || 'transparent';
    sw.textContent = p.swatch ? '' : '색 없음';
  });
  const ptRow = el('div', 'btnrow');
  ptRow.append(b('스포이트로 색 고르기', () => startPick('point')), sw, ptAct);
  P.append(section('Point Color', ['point'],
    ptRow,
    slider({ label: '범위 Range', path: 'point.range', min: 5, max: 120, fmt: (v) => Math.round(v) + '°' }),
    slider({ label: 'Hue', path: 'point.hueShift', min: -100, max: 100 }),
    slider({ label: 'Saturation', path: 'point.satShift', min: -100, max: 100 }),
    slider({ label: 'Luminance', path: 'point.lumShift', min: -100, max: 100 }),
  ));

  // Color Grading
  const zones = [['섀도', 'shadows'], ['미드톤', 'midtones'], ['하이라이트', 'highlights'], ['전체', 'global']];
  const zg = zones.map(([, z]) => {
    const g = el('div', 'group');
    g.append(
      slider({ label: 'Hue', path: `grading.${z}.h`, min: 0, max: 360, fmt: (v) => Math.round(v) + '°', track: HUES }),
      slider({ label: 'Saturation', path: `grading.${z}.s`, min: 0, max: 100, fmt: pct }),
      slider({ label: 'Luminance', path: `grading.${z}.l`, min: -100, max: 100 }),
    );
    return g;
  });
  zg.forEach((g, i) => { g.hidden = i > 0; });
  P.append(section('Color Grading', ['grading'],
    tabs(zones.map((z) => z[0]), (i) => zg.forEach((g, j) => { g.hidden = j !== i; })),
    ...zg,
    slider({ label: 'Blending', path: 'grading.blending', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Balance', path: 'grading.balance', min: -100, max: 100 }),
  ));

  // Effects
  P.append(section('Effects', ['effects'],
    slider({ label: 'Texture', path: 'effects.texture', min: -100, max: 100 }),
    slider({ label: 'Clarity', path: 'effects.clarity', min: -100, max: 100 }),
    slider({ label: 'Dehaze', path: 'effects.dehaze', min: -100, max: 100 }),
    sub('Vignette'),
    slider({ label: 'Vignette', path: 'effects.vignette.amount', min: -100, max: 100 }),
    slider({ label: 'Midpoint', path: 'effects.vignette.midpoint', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Feather', path: 'effects.vignette.feather', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Roundness', path: 'effects.vignette.roundness', min: -100, max: 100 }),
    slider({ label: 'Highlights', path: 'effects.vignette.highlights', min: 0, max: 100, fmt: pct }),
    sub('Grain'),
    slider({ label: 'Grain', path: 'effects.grain.amount', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Size', path: 'effects.grain.size', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Roughness', path: 'effects.grain.roughness', min: 0, max: 100, fmt: pct }),
  ));

  // Detail
  P.append(section('Detail', ['detail'],
    sub('Sharpening'),
    slider({ label: 'Sharpening', path: 'detail.sharpen.amount', min: 0, max: 150, fmt: pct }),
    slider({ label: 'Radius', path: 'detail.sharpen.radius', min: 0.5, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) }),
    slider({ label: 'Detail', path: 'detail.sharpen.detail', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Masking', path: 'detail.sharpen.masking', min: 0, max: 100, fmt: pct }),
    sub('Noise Reduction'),
    slider({ label: 'Noise Reduction', path: 'detail.nr.amount', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Detail', path: 'detail.nr.detail', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Contrast', path: 'detail.nr.contrast', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Color Noise Reduction', path: 'detail.cnr.amount', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Detail', path: 'detail.cnr.detail', min: 0, max: 100, fmt: pct }),
    slider({ label: 'Smoothness', path: 'detail.cnr.smoothness', min: 0, max: 100, fmt: pct }),
  ));

  P.append(buildExport());

  // 보관
  P.append(section('보관', null,
    el('div', 'hint', '가져온 원본과 보정값은 이 iPad 브라우저 안에만 있습니다.'),
    (() => {
      const r = el('div', 'btnrow');
      r.append(
        b('이 사진 목록에서 지우기', async () => {
          if (!app.cur || !confirm('이 사진을 목록에서 지울까요? (사진 보관함·Drive의 원본은 그대로)')) return;
          const id = app.cur.id;
          await store.del(id);
          app.photos = app.photos.filter((p) => p.id !== id);
          app.cur = null;
          if (app.photos[0]) select(app.photos[0].id); else { document.body.classList.remove('has-photo'); renderStrip(); }
        }, 'danger'),
        b('전부 지우기', async () => {
          if (!confirm('가져온 사진을 모두 지울까요? (사진 보관함·Drive의 원본은 그대로)')) return;
          await store.clear();
          app.photos = []; app.cur = null;
          document.body.classList.remove('has-photo');
          renderStrip();
        }, 'danger'));
      return r;
    })(),
    el('div', 'hint', `LiveShoot ${VERSION}`),
  ));
}

function buildExport() {
  const sizeSel = el('select');
  for (const [v, t] of [[2400, '2400 px (홈페이지)'], [3000, '3000 px'], [4000, '4000 px'], [0, '원본 크기']]) {
    const o = el('option', null, t); o.value = v; sizeSel.append(o);
  }
  sizeSel.value = app.exportEdge;
  sizeSel.onchange = () => { app.exportEdge = +sizeSel.value; localStorage.setItem('ls.edge', app.exportEdge); };
  const q = el('input'); Object.assign(q, { type: 'number', min: 50, max: 100, step: 5, value: app.quality });
  q.onchange = () => { app.quality = Math.min(100, Math.max(50, +q.value || 85)); q.value = app.quality; localStorage.setItem('ls.q', app.quality); };

  const destSel = el('select');
  for (const [v, t] of [['share', '공유 시트 (사진·파일 앱·Drive 앱)'], ['download', '다운로드 (파일 앱 다운로드 폴더)'], ['drive', 'Google Drive 지정 폴더 (직접 올리기)']]) {
    const o = el('option', null, t); o.value = v; destSel.append(o);
  }
  destSel.value = app.dest;

  // Drive 설정
  const cfg = driveConfig();
  const drive = el('div', 'group');
  const field = (ph, key) => {
    const i = el('input'); i.placeholder = ph; i.value = cfg[key] || '';
    i.onchange = () => saveDriveConfig({ ...driveConfig(), [key]: i.value.trim() });
    return i;
  };
  const folderTxt = el('div', 'hint');
  const showFolder = () => { const c = driveConfig(); folderTxt.textContent = c.folderName ? `저장 폴더: ${c.folderName}` : '저장 폴더: 아직 안 고름'; };
  showFolder();
  const pickBtn = el('button', 'btn', 'Drive 폴더 고르기');
  pickBtn.onclick = async () => { try { await pickDriveFolder(); showFolder(); } catch (e) { toast(e.message); } };
  drive.append(field('OAuth 클라이언트 ID', 'clientId'), field('API 키', 'apiKey'), field('Google Cloud 프로젝트 번호', 'appId'), pickBtn, folderTxt,
    el('div', 'hint', '설정 방법은 GitHub README의 "Google Drive 직접 올리기" 절'));
  const showDrive = () => { drive.hidden = destSel.value !== 'drive'; };
  showDrive();
  destSel.onchange = () => { app.dest = destSel.value; localStorage.setItem('ls.dest', app.dest); showDrive(); };

  const row = el('div', 'btnrow');
  const one = el('button', 'btn primary', '이 사진 내보내기');
  one.onclick = () => app.cur && exportPhotos([app.cur]);
  const all = el('button', 'btn', '하트 전부 내보내기');
  all.onclick = () => { const l = app.photos.filter((p) => p.liked); l.length ? exportPhotos(l) : toast('하트 표시한 사진이 없습니다'); };
  row.append(one, all);

  const grid = el('div', 'form');
  grid.append(el('span', null, '크기'), sizeSel, el('span', null, '품질'), q, el('span', null, '보낼 곳'), destSel);
  return section('내보내기', null, grid, drive, row, el('div', 'hint', '원본에서 다시 그려 JPEG로 만듭니다. 원본은 바뀌지 않습니다.'));
}

async function exportPhotos(list) {
  try {
    if (app.dest === 'drive') await driveToken();   // 누른 순간에 로그인 창
    const files = [];
    for (const [i, m] of list.entries()) {
      toast(`내보내는 중 ${i + 1}/${list.length}`);
      const blob = await store.getBlob(m.id);
      const r = await renderJPEG(app.pipe, m, blob, app.exportEdge, app.quality);
      if (app.dest === 'drive') await uploadToDrive(r.file);
      files.push(r);
      m.exported = true;
      store.putMeta(m);
    }
    renderStrip();
    const info = `${files.length}장 · 긴 변 ${Math.max(files[0].w, files[0].h)} px · 품질 ${app.quality}`;
    const fl = files.map((f) => f.file);
    window.__lastExport = files;
    if (app.dest === 'drive') toast(`Drive '${driveConfig().folderName}'에 올림: ${info}`);
    else if (app.dest === 'download' || !canShareFiles(fl)) { download(fl); toast(`다운로드: ${info}`); }
    else toast(`준비됨: ${info}`, { label: '공유 시트 열기', run: () => navigator.share({ files: fl }).catch(() => {}) });
  } catch (e) {
    toast('내보내기 실패: ' + e.message);
  }
}

// ---------- 스포이트·원본 비교·고객 보기 ----------

function startPick(kind) {
  if (!app.cur) return;
  app.picking = kind;
  document.body.classList.add('picking');
  toast(kind === 'wb' ? '사진에서 흰색·회색이어야 할 곳을 누르세요' : '사진에서 바꿀 색을 누르세요');
}

function sampleAt(e) {
  const cv = $('#gl'), r = cv.getBoundingClientRect(), p = app.preview;
  const x = Math.round((e.clientX - r.left) / r.width * p.width), y = Math.round((e.clientY - r.top) / r.height * p.height);
  const d = p.getContext('2d').getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
  return [R / n / 255, G / n / 255, B / n / 255];
}

function applyPick(e) {
  const kind = app.picking;
  app.picking = null;
  document.body.classList.remove('picking');
  const [r, g, b] = sampleAt(e), st = app.cur.settings;
  if (kind === 'wb') {
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const R = lin(r), G = lin(g), B = lin(b);
    const t = (B - R) / (0.3 * (R + B) + 1e-6);
    const avg = (R * (1 + 0.3 * t) + B * (1 - 0.3 * t)) / 2;
    const k = (1 - avg / Math.max(G, 1e-6)) / 0.25;
    st.color.temp = Math.max(-100, Math.min(100, Math.round(t * 100)));
    st.color.tint = Math.max(-100, Math.min(100, Math.round(k * 100)));
  } else {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dd = mx - mn;
    let h = 0;
    if (dd > 1e-6) h = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
    st.point.hue = ((h * 60) + 360) % 360;
    st.point.active = true;
    st.point.swatch = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  }
  syncAll();
  changed();
}

function setupViewer() {
  const v = $('#viewer'), cv = $('#gl');
  let x0 = 0, y0 = 0, t0 = 0, lastTap = 0, lp = 0;
  v.addEventListener('pointerdown', (e) => {
    if (app.picking && e.target === cv) { applyPick(e); return; }
    x0 = e.clientX; y0 = e.clientY; t0 = Date.now();
    if (document.body.classList.contains('client')) lp = setTimeout(() => exitClient(), 1000);
  });
  v.addEventListener('pointerup', (e) => {
    clearTimeout(lp);
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) && app.cur) {   // 좌우로 넘기기
      const i = app.photos.findIndex((p) => p.id === app.cur.id), j = i + (dx < 0 ? 1 : -1);
      if (app.photos[j]) { app.follow = j === 0; $('#follow').checked = app.follow; select(app.photos[j].id); }
      return;
    }
    if (Date.now() - t0 < 250 && Math.abs(dx) < 10) {
      const now = Date.now();
      if (now - lastTap < 330 && e.target === cv) { toggleLike(); lastTap = 0; } else lastTap = now;
    }
  });
  v.addEventListener('pointercancel', () => clearTimeout(lp));

  const before = $('#beforeBtn');
  const on = (e) => { e.preventDefault(); app.original = true; before.classList.add('on'); scheduleRender(); };
  const off = () => { app.original = false; before.classList.remove('on'); scheduleRender(); };
  before.addEventListener('pointerdown', on);
  before.addEventListener('pointerup', off);
  before.addEventListener('pointerleave', off);
  window.addEventListener('keydown', (e) => { if (e.key === '\\') { app.original = !app.original; scheduleRender(); } });
  $('#heart').onclick = () => toggleLike();
  $('#clientBtn').onclick = () => { if (app.cur) { document.body.classList.add('client'); document.documentElement.requestFullscreen?.().catch(() => {}); } };
  $('#exitClient').onclick = exitClient;
}

function exitClient() {
  document.body.classList.remove('client');
  if (document.fullscreenElement) document.exitFullscreen?.();
}

// ---------- 시작 ----------

async function main() {
  try {
    app.pipe = new Pipeline($('#gl'));
  } catch (e) {
    $('#empty').textContent = e.message;
    return;
  }
  buildPanel();
  setupViewer();
  $('#file').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
  window.addEventListener('resize', () => { histT = 0; scheduleRender(); if (app.curve) app.curve.draw(); });
  $('#follow').checked = app.follow;
  $('#follow').onchange = (e) => { app.follow = e.target.checked; if (app.follow && app.photos[0]) select(app.photos[0].id); };
  // 화면 위로 끌어다 놓기 (Mac·iPad 분할 화면)
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); importFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name))); });

  app.photos = (await store.list()).map((m) => ({ ...m, settings: withDefaults(m.settings) }));
  renderStrip();
  if (app.photos[0]) await select(app.photos[0].id);
  syncAll();

  // 받기 앱(카메라 FTP·GR)이 사진을 넘기는 입구
  window.LiveShoot = {
    version: VERSION,
    addFiles: (files) => importFiles([...files]),
    async addURL(url, name) {
      const b = await (await fetch(url)).blob();
      return importFiles([new File([b], name || url.split('/').pop(), { type: b.type || 'image/jpeg' })]);
    },
  };
  window.__ls = Object.assign(app, { rerender: () => { syncAll(); changed(); }, select, store });   // 시험용

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // 새로고침을 강제하지 않는다 (사진을 고르는 중일 수 있음). sw.js가 네트워크 먼저라 열 때마다 최신판을 받는다.
    navigator.serviceWorker.register('sw.js');
  }
}

main();
