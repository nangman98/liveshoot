import { Pipeline } from './gl.js';
import { store, defaults, withDefaults, clone } from './store.js';
import { CurveEditor } from './curve.js';
import { renderGeometry, geomPlan, geomRows, frameSize, aspectRatio, maxCrop, CropBox, ASPECTS } from './geometry.js';
import { readExif } from './exif.js';
import { isRaw, decodeRaw, rawInfo, rawTiffInfo } from './raw.js';
import { fitCameraLook } from './camera.js';
import { PROFILES, PROFILE_GROUPS, profileById } from './profiles.js';
import { parseLUTFile, INPUTS } from './lut.js';
import { parseXMP } from './xmp.js';

// 가져온 LUT 목록 (표 자체는 IndexedDB 'lut:<id>', 목록은 localStorage)
const lutMeta = () => JSON.parse(localStorage.getItem('ls.luts') || '[]');
const saveLutMeta = (l) => localStorage.setItem('ls.luts', JSON.stringify(l));
const allProfiles = () => [...PROFILES, ...lutMeta().map((l) => ({ id: 'lut:' + l.id, name: l.name, ko: 'LUT', group: 'lut' }))];
import { loadImage, toCanvas, renderJPEG, download, canShareFiles, driveConfig, saveDriveConfig, driveToken, pickDriveFolder, uploadToDrive } from './export.js';

export const VERSION = 'v12';
const PREVIEW = 2048;   // 화면용 긴 변 (px)
const BASE = 3072;      // 자르기·회전 전에 읽어 두는 원본 (긴 변 px)

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
  keepGPS: localStorage.getItem('ls.gps') !== '0',
  base: null, cropping: false, geomKey: '', cropBox: null, hi: null, hiId: null, hiJob: null,
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
  const st = d ? withDefaults(JSON.parse(d)) : defaults();
  st.geometry = defaults().geometry;   // 자르기·회전은 사진마다
  return st;
}

/**
 * 자동 노출: 128 px로 줄인 그림의 log 평균 휘도를 중간 회색(선형 0.18)에 맞추는 EV(±2.5).
 * 올릴 때는 밝은 쪽 1 % 화소(99번째 백분위 채널 최댓값)가 1을 넘지 않는 만큼까지만 올린다.
 */
function autoEV(canvas) {
  const c = toCanvas(canvas, 128), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  let s = 0;
  const mx = [];
  for (let i = 0; i < d.length; i += 4) {
    const r = lin(d[i]), g = lin(d[i + 1]), b = lin(d[i + 2]);
    s += Math.log(Math.max(1e-4, 0.2126 * r + 0.7152 * g + 0.0722 * b));
    mx.push(Math.max(r, g, b));
  }
  mx.sort((a, b) => a - b);
  const p99 = Math.max(1e-4, mx[Math.floor(mx.length * 0.99)]);
  const evMean = Math.log2(0.18 / Math.exp(s / mx.length));
  const ev = evMean > 0 ? Math.min(evMean, Math.max(0, Math.log2(0.98 / p99))) : evMean;
  return Math.max(-2.5, Math.min(2.5, ev));
}

let saveTimer;
function changed(record = true) {
  scheduleRender();
  if (!app.cur) return;
  app.cur.exported = false;
  clearTimeout(saveTimer);
  const m = app.cur;
  saveTimer = setTimeout(() => store.putMeta(m), 400);
  if (record) scheduleRecord(m);
  scheduleThumbs();
}

// ---------- 프로필 썸네일 (지금 사진 + 지금 보정 위에 각 프로필) ----------

let thumbTimer;
function scheduleThumbs() { clearTimeout(thumbTimer); thumbTimer = setTimeout(updateProfileThumbs, 600); }
function updateProfileThumbs() {
  if (!app.cur || !app.preview || !app.profileCells) return;
  // 펼친 묶음에 있는 프로필만
  const open = allProfiles().filter((p) => app.profileCells[p.id]?.closest('details.pgroup')?.open);
  if (!open.length) return;
  try {
    const src = toCanvas(app.preview, 180);
    const list = open.map((p) => ({ ...clone(app.cur.settings), profile: { id: p.id, amount: 100 } }));
    const cs = app.pipe.renderMany(src, src.width, src.height, list, app.cur.autoEV);
    open.forEach((p, i) => { const cell = app.profileCells[p.id]; cell.querySelector('canvas')?.remove(); cell.prepend(cs[i]); });
  } catch (e) {
    toast('썸네일 오류: ' + (e && e.message));
  }
}

/**
 * Auto: 히스토그램 통계로 톤 8개를 정한다 (Lightroom처럼 학습 모델이 아님).
 * 노출은 자동 노출과 같은 규칙, Whites·Blacks는 0.5·99.5 백분위를 0.02·0.97로, 하이라이트·섀도는 날아가거나 묻힌 만큼.
 */
function autoTone() {
  if (!app.cur) return;
  applyAuto(app.cur.settings, shown(app.preview, app.cur.look, 256));
  syncAll();
  changed();
  toast('Auto: 히스토그램 기준으로 톤 8개를 맞춤');
}

/** 보정 전 그대로 보이는 캔버스. 카메라 룩이 있는 RAW는 캔버스가 카메라 RGB라 파이프라인으로 그려야 보인다 */
function shown(canvas, look, edge) {
  const s = toCanvas(canvas, edge);
  if (!look) return s;
  const keep = app.pipe.look, st = defaults();
  st.autoExposure = false;
  app.pipe.setLook(look);
  try { return app.pipe.renderMany(s, s.width, s.height, [st], 0)[0]; } finally { app.pipe.setLook(keep); }
}

/** Auto 값을 st에 적음 (canvas: 보정 전 사진) */
function applyAuto(st, canvas) {
  const ev = autoEV(canvas);
  const c = toCanvas(canvas, 160), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const enc = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const g = Math.pow(2, ev), Ls = [];
  let sat = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = lin(d[i]) * g, gg = lin(d[i + 1]) * g, b = lin(d[i + 2]) * g;
    Ls.push(enc(Math.min(1, 0.2126 * r + 0.7152 * gg + 0.0722 * b)));
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    sat += mx ? (mx - mn) / mx : 0;
  }
  Ls.sort((a, b) => a - b);
  const q = (p) => Ls[Math.min(Ls.length - 1, Math.floor(Ls.length * p))];
  const mean = Ls.reduce((a, b) => a + b, 0) / Ls.length, std = Math.sqrt(Ls.reduce((a, b) => a + (b - mean) ** 2, 0) / Ls.length);
  const cl = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)));
  const smooth = (e0, e1, x) => { const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
  Object.assign(st.light, {
    exposure: Math.round(ev * 100) / 100,
    contrast: cl((0.2 - std) / 0.2 * 60, -30, 30),
    highlights: q(0.99) > 0.95 ? -cl((q(0.99) - 0.9) * 300, 0, 60) : 0,
    shadows: q(0.05) < 0.08 ? cl((0.12 - q(0.05)) * 300, 0, 50) : 0,
    // 슬라이더가 그 밝기에서 먹히는 비율로 나눔 (Whites: smoothstep(0.5, 1, L), Blacks: 1 − smoothstep(0, 0.4, L))
    whites: cl((0.97 - q(0.995)) / (0.25 * Math.max(0.2, smooth(0.5, 1, q(0.995)))) * 100, -80, 80),
    blacks: cl((0.02 - q(0.005)) / (0.2 * Math.max(0.2, 1 - smooth(0, 0.4, q(0.005)))) * 100, -80, 80),
  });
  st.color.vibrance = sat / (d.length / 4) < 0.25 ? 15 : 5;
  st.color.saturation = 0;
  st.autoExposure = false;   // 노출 값을 슬라이더에 직접 적었으니 자동 노출은 끔
}

// ---------- 자동 처리 (Capture One의 Next Capture Adjustments + Export Recipe + capture-done 스크립트를 본뜸) ----------

export const RECIPES = [
  { id: 'web', name: '홈페이지 긴 변 2400 px · 품질 85', edge: 2400, q: 85, suffix: '' },
  { id: 'insta', name: '인스타 긴 변 1350 px · 품질 90', edge: 1350, q: 90, suffix: '_insta' },
  { id: 'full', name: '원본 크기 · 품질 95', edge: 0, q: 95, suffix: '_full' },
];
const allPresets = () => JSON.parse(localStorage.getItem('ls.presets') || '{}');
const autoCfg = () => ({ preset: '', auto: false, recipes: [], autoExport: false, ...JSON.parse(localStorage.getItem('ls.auto') || '{}') });
const saveAutoCfg = (c) => localStorage.setItem('ls.auto', JSON.stringify(c));

// ---------- 되돌리기·다시 하기 (사진마다, 슬라이더를 움직이다 멈춘 때를 한 단계로) ----------

const histories = new Map();
let histTimer;
function hist(m) {
  if (!histories.has(m.id)) histories.set(m.id, { undo: [], redo: [], last: JSON.stringify(m.settings) });
  return histories.get(m.id);
}
function scheduleRecord(m) { clearTimeout(histTimer); histTimer = setTimeout(() => recordHistory(m), 350); }
function recordHistory(m) {
  const h = hist(m), now = JSON.stringify(m.settings);
  if (now === h.last) return;
  h.undo.push(h.last);
  if (h.undo.length > 200) h.undo.shift();
  h.redo = [];
  h.last = now;
  updateUndoButtons();
}
function stepHistory(back) {
  if (!app.cur) return;
  clearTimeout(histTimer);
  recordHistory(app.cur);   // 아직 기록 안 된 마지막 움직임부터 기록
  const h = hist(app.cur), from = back ? h.undo : h.redo, to = back ? h.redo : h.undo;
  if (!from.length) return;
  to.push(h.last);
  h.last = from.pop();
  app.cur.settings = JSON.parse(h.last);
  syncAll();
  changed(false);
  if (app.cropping) showCropBox();
  updateUndoButtons();
}
function updateUndoButtons() {
  const h = app.cur && hist(app.cur);
  $('#undoBtn').disabled = !h || !h.undo.length;
  $('#redoBtn').disabled = !h || !h.redo.length;
}

let raf = 0, histT = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!app.cur || !app.preview) return;
    if (geomKey() !== app.geomKey) refreshPreview();
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
      let img, rawMeta = null, rawHi = null, look = null, camInfo = null, tiff = null;
      if (isRaw(f)) {
        toast(`RAW 해독 중: ${f.name}`);
        // 카메라 JPEG 맞춤: 카메라 RGB로 해독하고 내장 JPEG에 맞춰 룩을 찾는다. 못 찾으면 LibRaw 색으로 다시 해독
        let r = await decodeRaw(f, { half: true, hi: !!app.pipe.half, camera: !app.noCamMatch, thumb: true });
        if (app.noCamMatch) camInfo = { reason: '끔 (시험용)' };
        else if (r.thumb && r.proxy) {
          try {
            const fit = await fitCameraLook(r.proxy, r.thumb, { model: r.meta.camera_model, flip: r.meta.flip, adobe: r.meta.color_data?.ExifColorSpace === 2 });
            look = fit.look; camInfo = fit.info;
          } catch (e) { camInfo = { error: e.message }; }
        } else camInfo = { reason: '내장 JPEG 없음' };
        if (!look) r = await decodeRaw(f, { half: true, hi: !!app.pipe.half });
        img = r.canvas;
        rawMeta = r.meta;
        rawHi = r.hi;
        tiff = await rawTiffInfo(f);
      } else {
        img = await loadImage(f);
      }
      const c = toCanvas(img, BASE);
      const thumb = await new Promise((r) => shown(c, look, 240).toBlob(r, 'image/jpeg', 0.8));
      let settings = app.carry && app.cur ? clone(app.cur.settings) : startSettings();
      const rule = autoCfg(), rp = rule.preset && allPresets()[rule.preset];
      if (rp) settings = withDefaults(rp);           // 새 사진에 입힐 프리셋
      settings.geometry = defaults().geometry;
      if (look) settings.autoExposure = false;        // 카메라 룩이 노출까지 정함
      if (rule.auto) applyAuto(settings, shown(c, look, 256));   // 새 사진에 Auto
      const ex = rawMeta ? null : await readExif(f);
      const meta = {
        id: crypto.randomUUID(), name: f.name || `photo_${Date.now()}.jpg`, added: Date.now(),
        w: rawMeta ? img.width * 2 : img.naturalWidth, h: rawMeta ? img.height * 2 : img.naturalHeight,
        autoEV: look ? 0 : autoEV(c), settings, liked: false, exported: false, thumb,
        exif: rawMeta ? rawInfo(rawMeta, tiff) : ex ? ex.info : null, raw: !!rawMeta,
        ...(rawMeta ? { rawMode: look ? 'camera' : 'srgb', look, camInfo } : {}),
      };
      await store.putBlob(meta.id, f);
      // RAW는 해독이 느리니 화면용 원본을 따로 둔다
      if (rawMeta) await store.putBlob(meta.id + ':base', await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95)));
      await store.putMeta(meta);
      app.photos.unshift(meta);
      n++;
      if (app.follow || !app.cur) await select(meta.id, c, rawHi);
      else renderStrip();
      // 받는 즉시 내보내기: Drive 지정 폴더일 때만 (공유·다운로드는 손으로 눌러야 하는 동작이라)
      if (rule.autoExport && app.dest === 'drive' && driveConfig().folderId) exportPhotos([meta], true);
    } catch (e) {
      toast(isRaw(f) ? `RAW를 열 수 없음: ${f.name} (${e.message})` : `열 수 없는 사진: ${f.name}`);
    }
  }
  renderStrip();
  if (n) toast(`${n}장 가져옴`);
}

// RAW의 16비트 원본 (지금 사진 것만 GPU에 둔다)
function setHi(id, img) {
  if (!app.cur || app.cur.id !== id || !img) return;
  app.pipe.dropHi(app.hi);
  app.hi = app.pipe.hiSource(img);
  app.hiId = app.hi ? id : null;
  if (app.hi && app.base) { refreshPreview(); scheduleRender(); }
}

// 16비트 원본 해제. keep: 이 사진의 해독은 진행 중이면 그대로 둔다
function releaseHi(keep) {
  if (app.hiJob && app.hiJob.id !== keep) { app.hiJob.ctrl.abort(); app.hiJob = null; }
  app.pipe.dropHi(app.hi);
  app.hi = null; app.hiId = null;
}

async function loadHi(m) {
  if (app.hiJob && app.hiJob.id === m.id) return;   // 같은 사진 해독이 이미 진행 중
  if (app.hiJob) app.hiJob.ctrl.abort();
  const job = app.hiJob = { id: m.id, ctrl: new AbortController() };
  try {
    const r = await decodeRaw(await store.getBlob(m.id), { half: true, hi: true, canvas: false, signal: job.ctrl.signal, camera: m.rawMode === 'camera' });
    if (app.hiJob === job) setHi(m.id, r.hi);
  } catch (e) {
    if (!job.ctrl.signal.aborted) toast('16비트 해독 실패, 8비트로 편집: ' + (e && e.message));
  } finally {
    if (app.hiJob === job) app.hiJob = null;
  }
}

// 사진이 하나도 없을 때: GPU의 원본·흐림 단계까지 비운다
function releaseAll() {
  releaseHi();
  app.pipe.free(app.pipe.set);
  app.pipe.set = null;
}

async function select(id, ready, hiImg) {
  const m = app.photos.find((p) => p.id === id);
  if (!m) return;
  app.cur = m;
  if (app.hiId !== id) releaseHi(id);
  app.pipe.setLook(m.look || null);
  let c = ready;
  if (!c) {
    const blob = await store.getBlob(m.raw ? id + ':base' : id);
    c = toCanvas(await loadImage(blob), BASE);
  }
  app.base = c;
  if (app.cropping) toggleCrop(false);
  app.geomKey = '';
  hist(m);   // 이 사진의 기록 시작점
  updateUndoButtons();
  scheduleThumbs();
  refreshPreview();
  document.body.classList.add('has-photo');
  syncAll();
  scheduleRender();
  renderStrip();
  if (m.raw && app.pipe.half && !app.hi) { if (hiImg) setHi(id, hiImg); else loadHi(m); }
  const e = m.exif || {};
  $('#photoName').textContent = [m.name, `${m.w}×${m.h}`, e.date ? e.date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') : '날짜 정보 없음',
    e.gps ? `위치 ${e.gps.lat.toFixed(4)}, ${e.gps.lon.toFixed(4)}` : '위치 정보 없음', e.model, e.lens,
    m.rawMode === 'camera' ? '카메라 JPEG 색' : m.raw ? 'LibRaw 색' : null].filter(Boolean).join(' · ');
  $('#heart').textContent = m.liked ? '♥' : '♡';
}

/** 자르기 편집 중에는 자르기 전 틀 전체를 보여 준다 */
function geomKey() {
  const g = { ...app.cur.settings.geometry };
  if (app.cropping) delete g.crop;
  return JSON.stringify(g) + (app.cropping ? '|crop' : '') + (app.cur.id);
}

function refreshPreview() {
  const m = app.cur, g = m.settings.geometry;
  const was = app.geomKey;
  app.preview = renderGeometry(app.base, g, PREVIEW, { ignoreCrop: app.cropping });
  // RAW는 16비트 원본에서 같은 자르기·회전으로 그린다 (8비트 미리보기는 썸네일·히스토그램용)
  const W = app.preview.width, H = app.preview.height;
  const src = app.hi && app.hiId === m.id
    ? { hiTex: app.hi, ...geomRows(app.hi.w, app.hi.h, geomPlan(app.hi.w, app.hi.h, g, 0, { ignoreCrop: app.cropping, size: [W, H] })) }
    : app.preview;
  app.pipe.setPreview(src, W, H, m.settings.detail.sharpen.radius);
  app.geomKey = geomKey();
  if (app.cropping) requestAnimationFrame(() => showCropBox());
  else if (was && was !== app.geomKey && was.endsWith(m.id)) updateThumb(m);   // 같은 사진에서 기하가 바뀌면 썸네일도
}

function updateThumb(m) {
  shown(app.preview, m.look, 240).toBlob((b) => {
    m.thumb = b;
    if (app.thumbs.has(m.id)) URL.revokeObjectURL(app.thumbs.get(m.id));
    app.thumbs.delete(m.id);
    store.putMeta(m);
    renderStrip();
  }, 'image/jpeg', 0.8);
}

function frameWH() {
  return frameSize(app.base.width, app.base.height, app.cur.settings.geometry);
}

function showCropBox() {
  const g = app.cur.settings.geometry, [W, H] = frameWH();
  if (!g.crop) g.crop = maxCrop(aspectRatio(g, W, H), W, H);
  app.cropBox.show(g.crop, aspectRatio(g, W, H), W, H);
}

function toggleCrop(on) {
  app.cropping = on;
  document.body.classList.toggle('cropping', on);
  $('#cropBtn').textContent = on ? '자르기 완료' : '자르기 편집';
  if (!on) app.cropBox.hide();
  changed();
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

/** 다른 사진의 보정을 입힌다. 자르기·회전은 지금 사진 것을 둔다 (Lightroom과 같음) */
function adopt(st) {
  const g = app.cur.settings.geometry;
  app.cur.settings = withDefaults(st);
  app.cur.settings.geometry = g;
}

/** "내 LUT" 묶음: .cube·HaldCLUT 가져오기, 입력 방식, 지우기 */
function lutGroup() {
  const box = el('details', 'pgroup'), sm = el('summary', null), cnt = el('span', 'muted');
  sm.append(el('span', null, '내 LUT'), cnt);
  box.append(sm);
  box.addEventListener('toggle', () => { if (box.open) scheduleThumbs(); });
  const grid = el('div', 'profiles'), list = el('div', null);
  const imp = el('label', 'btn', 'LUT 가져오기 (.cube, HaldCLUT .png, 묶음 .lsluts)');
  const fi = el('input');
  // accept를 두지 않음: iPad는 iOS가 모르는 확장자(.cube·.lsluts)를 흐리게 해서 못 고르게 함. 형식은 parseLUTFile이 거름
  Object.assign(fi, { type: 'file', multiple: true, hidden: true });
  fi.dataset.role = 'lut-import';
  imp.append(fi);
  const redraw = () => {
    grid.replaceChildren();
    list.replaceChildren();
    for (const k of Object.keys(app.profileCells)) if (k.startsWith('lut:')) delete app.profileCells[k];
    const m = lutMeta();
    cnt.textContent = String(m.length);
    for (const l of m) {
      const cell = el('button', 'prof');
      cell.append(el('span', null, l.name));
      cell.onclick = () => { if (!app.cur) return; app.cur.settings.profile.id = 'lut:' + l.id; syncAll(); changed(); };
      app.profileCells['lut:' + l.id] = cell;
      grid.append(cell);
      const row = el('div', 'btnrow'), s = el('select');
      for (const [v, t] of INPUTS) { const o = el('option', null, t); o.value = v; s.append(o); }
      s.value = l.input;
      s.onchange = () => {
        const mm = lutMeta();
        mm.find((y) => y.id === l.id).input = s.value;
        saveLutMeta(mm);
        const L = app.pipe.luts.get(l.id);
        if (L) L.input = s.value;
        changed();
      };
      const del = el('button', 'btn danger', '지우기');
      del.onclick = async () => {
        if (!confirm(`LUT '${l.name}'을 지울까요?`)) return;
        saveLutMeta(lutMeta().filter((y) => y.id !== l.id));
        await store.delBlob('lut:' + l.id);
        app.pipe.dropLUT(l.id);
        if (app.cur && app.cur.settings.profile.id === 'lut:' + l.id) app.cur.settings.profile.id = 'color';
        redraw();
        changed();
      };
      row.append(el('span', null, l.name), s, del);
      list.append(row);
    }
    if (app.pipe) syncAll();
  };
  fi.onchange = async () => {
    for (const f of fi.files) {
      try {
        const items = await parseLUTFile(f);
        for (const { name, input, data } of items) {
          const id = crypto.randomUUID();
          await store.putBlob('lut:' + id, data);
          saveLutMeta([...lutMeta(), { id, name, input }]);
          app.pipe.setLUT(id, data, input);
        }
        toast(items.length > 1 ? `LUT ${items.length}개 가져옴: ${f.name}` : `LUT 가져옴: ${items[0].name} (입력 ${items[0].input})`);
      } catch (e) {
        toast(`LUT를 못 읽음: ${f.name} (${e.message})`);
      }
    }
    fi.value = '';
    redraw();
    box.open = true;
    scheduleThumbs();
  };
  redraw();
  box.append(grid, imp, list, el('div', 'hint', 'LUT 파일은 이 기기 브라우저 안에만 저장됨. 후지 공식 LUT(F-Log2 to …)는 입력을 F-Log2로 둠. 노출·화이트밸런스 바로 뒤에 입혀짐'));
  return box;
}

function autoSection() {
  const cfg = autoCfg(), put = (k, v) => saveAutoCfg({ ...autoCfg(), [k]: v });
  const ps = el('select');
  const fill = () => {
    ps.replaceChildren(el('option', null, '프리셋 없음'));
    ps.firstChild.value = '';
    for (const k of Object.keys(allPresets())) { const o = el('option', null, k); o.value = k; ps.append(o); }
    ps.value = autoCfg().preset || '';
  };
  fill();
  ps.addEventListener('focus', fill);
  ps.onchange = () => put('preset', ps.value);
  const chk = (label, key) => {
    const l = el('label', 'chk'), i = el('input');
    i.type = 'checkbox'; i.checked = !!cfg[key];
    i.onchange = () => put(key, i.checked);
    l.append(i, el('span', null, label));
    return l;
  };
  const rec = el('div', null);
  for (const r of RECIPES) {
    const l = el('label', 'chk'), i = el('input');
    i.type = 'checkbox'; i.checked = cfg.recipes.includes(r.id);
    i.onchange = () => { const s = new Set(autoCfg().recipes); i.checked ? s.add(r.id) : s.delete(r.id); put('recipes', [...s]); };
    l.append(i, el('span', null, r.name));
    rec.append(l);
  }
  const row = el('div', 'btnrow');
  row.append(el('span', null, '새 사진에 입힐 프리셋'), ps);
  return section('자동 처리', null,
    row, chk('새 사진에 Auto', 'auto'),
    sub('내보내기 레시피 (고르면 레시피마다 한 장씩)'), rec,
    chk('받는 즉시 내보내기 (보낼 곳이 Google Drive 지정 폴더일 때)', 'autoExport'),
    el('div', 'hint', 'Capture One의 "다음 촬영에 보정 입히기 + 내보내기 레시피 여러 개 + 촬영할 때마다 실행"을 본뜸. 레시피를 하나도 안 고르면 아래 내보내기의 크기·품질을 씀'));
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

  const b = (t, f, cls = '') => { const x = el('button', 'btn ' + cls, t); x.onclick = f; return x; };
  const quick = el('div', 'btnrow');
  const bwBtn = b('B&W', () => { if (!app.cur) return; const s = app.cur.settings; s.treatment = s.treatment === 'bw' ? 'color' : 'bw'; syncAll(); changed(); });
  quick.append(b('Auto', autoTone, 'primary'), bwBtn);
  app.syncers.push(() => bwBtn.classList.toggle('on', !!app.cur && app.cur.settings.treatment === 'bw'));
  const row1 = el('div', 'btnrow');
  row1.append(
    b('복사', () => { if (app.cur) { app.clipboard = clone(app.cur.settings); toast('보정을 복사함'); } }),
    b('붙여넣기', () => { if (app.cur && app.clipboard) { adopt(app.clipboard); syncAll(); changed(); } }),
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
    if (p && app.cur) { adopt(p); syncAll(); changed(); toast(`프리셋 '${sel.value}' 적용`); }
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
  // Lightroom·Camera Raw 프리셋(.xmp) 가져오기
  const xr = el('div', 'btnrow');
  const xl = el('label', 'btn', 'Lightroom 프리셋 가져오기 (.xmp)');
  const xi = el('input');
  Object.assign(xi, { type: 'file', multiple: true, hidden: true });   // accept 없음: iPad가 .xmp를 흐리게 할 수 있음
  xi.dataset.role = 'xmp-import';
  xl.append(xi);
  xi.onchange = async () => {
    const msgs = [];
    for (const f of xi.files) {
      try {
        const r = parseXMP(await f.text());
        const name = f.name.replace(/\.[^.]+$/, '');
        const all = presets(); all[name] = r.settings;
        localStorage.setItem('ls.presets', JSON.stringify(all));
        if (app.cur && xi.files.length === 1) { adopt(r.settings); syncAll(); changed(); }
        msgs.push(`'${name}' ${r.used.length}개 항목` + (r.skipped.length ? `, 못 옮김 ${r.skipped.length}개(${r.skipped.slice(0, 6).join(', ')}${r.skipped.length > 6 ? ' …' : ''})` : ''));
      } catch (e) {
        msgs.push(`${f.name}: ${e.message}`);
      }
    }
    xi.value = '';
    fillPresets();
    toast('프리셋 가져옴: ' + msgs.join(' / '));
  };
  xr.append(xl);

  P.append(section('기본', null, hist, quick, autoBox, row1, row2, carry, pre, xr));
  P.append(autoSection());

  // 프로필
  const curName = el('div', 'subhead');
  app.syncers.push(() => {
    const id = app.cur?.settings.profile.id;
    const p = allProfiles().find((x) => x.id === id) || profileById('color');
    curName.textContent = `${p.name} · ${p.ko}`;
    for (const [id, cell] of Object.entries(app.profileCells || {})) cell.classList.toggle('on', id === p.id);
  });
  app.profileCells = {};
  // 묶음은 접어 두고, 펼친 묶음만 썸네일을 그린다
  const profGroups = PROFILE_GROUPS.map(([g, label]) => {
    const box = el('details', 'pgroup');
    const list = PROFILES.filter((x) => x.group === g);
    const sm = el('summary', null);
    sm.append(el('span', null, label), el('span', 'muted', String(list.length)));
    box.append(sm);
    box.addEventListener('toggle', () => { if (box.open) scheduleThumbs(); });
    const grid = el('div', 'profiles');
    box.append(grid);
    for (const p of list) {
      const cell = el('button', 'prof');
      cell.append(el('span', null, p.name));
      cell.title = p.ko;
      cell.onclick = () => { if (!app.cur) return; app.cur.settings.profile.id = p.id; syncAll(); changed(); };
      app.profileCells[p.id] = cell;
      grid.append(cell);
    }
    return box;
  });
  P.append(section('프로필', ['profile'], curName,
    slider({ label: '강도 Amount', path: 'profile.amount', min: 0, max: 200, fmt: (v) => Math.round(v) + ' %' }),
    ...profGroups,
    lutGroup(),
    el('div', 'hint', '묶음을 누르면 펼쳐짐. 썸네일은 지금 사진과 지금 보정 위에 각 프로필을 얹은 모습. 프로필은 슬라이더를 움직이지 않고 그 아래에 깔림. Ricoh·Fujifilm 풍은 공개된 설명을 바탕으로 만든 근사이고 제조사 색과 같지 않음'),
  ));

  // 자르기·회전
  const G = () => app.cur.settings.geometry;
  const rot = el('div', 'btnrow');
  rot.append(
    b('⟲ 90°', () => { if (!app.cur) return; G().rotate = (G().rotate + 270) % 360; G().crop = null; changed(); }),
    b('⟳ 90°', () => { if (!app.cur) return; G().rotate = (G().rotate + 90) % 360; G().crop = null; changed(); }),
    b('좌우 뒤집기', () => { if (!app.cur) return; G().flip = !G().flip; changed(); }),
  );
  const asp = el('select');
  for (const [v, t] of ASPECTS) { const o = el('option', null, t); o.value = v; asp.append(o); }
  asp.onchange = () => {
    if (!app.cur) return;
    G().aspect = asp.value;
    const [W, H] = frameWH();
    G().crop = asp.value === 'free' ? (G().crop || null) : maxCrop(aspectRatio(G(), W, H), W, H);
    if (!app.cropping && asp.value !== 'free') toggleCrop(true); else changed();
    if (app.cropping) showCropBox();
  };
  app.syncers.push(() => { asp.value = app.cur ? G().aspect : 'original'; });
  const cropRow = el('div', 'btnrow');
  const cropBtn = b('자르기 편집', () => { if (app.cur) toggleCrop(!app.cropping); }, 'primary');
  cropBtn.id = 'cropBtn';
  cropRow.append(el('span', null, '비율'), asp, cropBtn,
    b('자르기 없애기', () => { if (!app.cur) return; G().crop = null; if (app.cropping) showCropBox(); changed(); }));
  P.append(section('자르기·회전', ['geometry'],
    rot,
    slider({ label: '수평 맞추기 Straighten', path: 'geometry.angle', min: -45, max: 45, step: 0.1, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + '°' }),
    cropRow,
    el('div', 'hint', '자르기 편집: 틀 안을 끌면 옮기기, 모서리를 끌면 크기. 수평을 맞추면 빈 모서리가 안 생기게 자동으로 확대됨'),
  ));

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
    sub('구간 Region'),
    slider({ label: 'Highlights', path: 'curve.region.highlights', min: -100, max: 100 }),
    slider({ label: 'Lights', path: 'curve.region.lights', min: -100, max: 100 }),
    slider({ label: 'Darks', path: 'curve.region.darks', min: -100, max: 100 }),
    slider({ label: 'Shadows', path: 'curve.region.shadows', min: -100, max: 100 }),
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

  // B&W Mix
  P.append(section('B&W Mix', ['bw'],
    el('div', 'hint', '흑백(B&W)일 때 색마다 회색 밝기를 바꿈. 예: 파랑 −로 하늘을 어둡게'),
    ...BANDS.map(([n, col], i) => slider({ label: n, path: `bw.${i}`, min: -100, max: 100, track: `linear-gradient(90deg,#222,${col},#eee)` })),
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
          if (app.photos[0]) select(app.photos[0].id); else { releaseAll(); document.body.classList.remove('has-photo'); renderStrip(); }
        }, 'danger'),
        b('전부 지우기', async () => {
          if (!confirm('가져온 사진을 모두 지울까요? (사진 보관함·Drive의 원본은 그대로)')) return;
          await store.clear();
          app.photos = []; app.cur = null;
          releaseAll();
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

  const gps = el('label', 'chk');
  const gpsIn = el('input'); gpsIn.type = 'checkbox'; gpsIn.checked = app.keepGPS;
  gpsIn.onchange = () => { app.keepGPS = gpsIn.checked; localStorage.setItem('ls.gps', app.keepGPS ? '1' : '0'); };
  gps.append(gpsIn, el('span', null, '위치 정보(GPS) 함께 저장'));
  const grid = el('div', 'form');
  grid.append(el('span', null, '크기'), sizeSel, el('span', null, '품질'), q, el('span', null, '보낼 곳'), destSel);
  return section('내보내기', null, grid, gps, drive, row,
    el('div', 'hint', '원본에서 다시 그려 JPEG로 만듭니다. 촬영 날짜·카메라 정보(원본이 JPEG일 때)는 함께 저장되고, 원본은 바뀌지 않습니다.'));
}

async function exportPhotos(list, auto = false) {
  try {
    if (app.dest === 'drive') await driveToken();   // 누른 순간에 로그인 창
    // 고른 레시피가 있으면 레시피마다 한 장씩, 없으면 위 크기·품질로
    const chosen = RECIPES.filter((r) => autoCfg().recipes.includes(r.id));
    const jobs = chosen.length ? chosen : [{ edge: app.exportEdge, q: app.quality, suffix: '' }];
    const files = [];
    let k = 0;
    for (const m of list) {
      const blob = await store.getBlob(m.id);
      for (const j of jobs) {
        toast(`내보내는 중 ${++k}/${list.length * jobs.length}`);
        const r = await renderJPEG(app.pipe, m, blob, j.edge, j.q, app.keepGPS);
        if (j.suffix) r.file = new File([r.file], r.file.name.replace(/\.jpg$/, j.suffix + '.jpg'), { type: 'image/jpeg' });
        if (app.dest === 'drive') await uploadToDrive(r.file);
        files.push(r);
      }
      m.exported = true;
      store.putMeta(m);
    }
    renderStrip();
    const info = `${files.length}개 파일` + (chosen.length ? ` · 레시피 ${chosen.length}개` : ` · 긴 변 ${Math.max(files[0].w, files[0].h)} px · 품질 ${app.quality}`) + (auto ? ' · 자동' : '');
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
    if (app.cropping) return;
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

  app.cropBox = new CropBox(v, cv, (crop) => {
    app.cur.settings.geometry.crop = crop;
    clearTimeout(saveTimer);
    const m = app.cur;
    saveTimer = setTimeout(() => store.putMeta(m), 400);
    scheduleRecord(m);
  });
  window.addEventListener('resize', () => { if (app.cropping) app.cropBox.place(); });
  $('#undoBtn').onclick = () => stepHistory(true);
  $('#redoBtn').onclick = () => stepHistory(false);
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
    e.preventDefault();
    stepHistory(!e.shiftKey);
  });
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
  // 오류를 화면에 띄움 (iPad에서 캡처로 원인을 받기 위해)
  window.addEventListener('error', (e) => toast(`오류: ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => toast('오류: ' + (e.reason && e.reason.message || e.reason)));
  try {
    app.pipe = new Pipeline($('#gl'));
  } catch (e) {
    $('#empty').textContent = e.message;
    return;
  }
  // 저장해 둔 LUT를 GPU에 올림
  for (const l of lutMeta()) {
    const data = await store.getBlob('lut:' + l.id);
    if (data) app.pipe.setLUT(l.id, data, l.input);
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
  window.__ls = Object.assign(app, { rerender: () => { syncAll(); changed(); }, select, store, exportPhotos });   // 시험용

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // 새로고침을 강제하지 않는다 (사진을 고르는 중일 수 있음). sw.js가 네트워크 먼저라 열 때마다 최신판을 받는다.
    navigator.serviceWorker.register('sw.js');
  }
}

main();
