// 내보내기: 원본에서 다시 그려 JPEG로 만들고, 공유 시트·다운로드·Google Drive 폴더로 보낸다.
import { renderGeometry, geomPlan, geomRows, maskFrame } from './geometry.js';
import { readExif, prepare, insertExif, buildExif } from './exif.js';
import { decodeRaw } from './raw.js';

export const MAX_AREA = 16_000_000;   // iPad Safari 캔버스 면적 한도(약 16.7 MP) 안쪽

export function loadImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
    img.src = url;
  });
}

/** 긴 변 maxEdge 이하로 줄인 2D 캔버스 (EXIF 방향은 브라우저가 맞춰 줌) */
export function toCanvas(src, maxEdge) {
  const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
  const s = Math.min(1, maxEdge / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * s));
  c.height = Math.max(1, Math.round(h0 * s));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * 원본 → 자르기·회전 → 보정 → JPEG File. edge 0이면 원본 크기(면적·텍스처 한도 안에서).
 * 원본 JPEG의 EXIF(날짜·카메라, keepGPS면 위치까지)를 다시 넣는다.
 */
export async function renderJPEG(pipe, meta, blob, edge, quality, keepGPS = true) {
  let src, seg = null, hi = null;
  const camera = meta.rawMode === 'camera';
  const maxEdge = Math.min(edge || Infinity, pipe.maxTex);
  if (meta.raw) {
    // 1/2 해독으로 원하는 크기가 나오면 빠른 쪽, 아니면(원본 크기·많이 자름) 전체 해독.
    // 1/2 해독은 16비트로 (전체 해독은 GPU 메모리 때문에 8비트)
    const cr = meta.settings.geometry.crop || { w: 1, h: 1 };
    const halfLong = Math.max(meta.w * cr.w, meta.h * cr.h) / 2;
    const half = !!edge && edge <= halfLong, useHi = half && pipe.half;
    const r = await decodeRaw(blob, { half, hi: useHi, canvas: !useHi, camera });
    if (r.hi) hi = pipe.hiSource(r.hi);
    src = hi ? null : r.canvas || (await decodeRaw(blob, { half, camera })).canvas;
    if (hi) {
      const plan = geomPlan(hi.w, hi.h, meta.settings.geometry, maxEdge, { maxArea: MAX_AREA });
      hi.plan = plan;
      hi.rows = geomRows(hi.w, hi.h, plan);
    }
    seg = buildExif(meta.exif || {}, keepGPS);
  } else {
    src = await loadImage(blob);
    const ex = await readExif(blob);
    if (ex) seg = prepare(ex.seg, keepGPS);
  }
  let out, c;
  if (hi) {
    c = { width: hi.plan.w, height: hi.plan.h };
    const frame = maskFrame(hi.w, hi.h, hi.plan);
    try { out = withLook(pipe, meta, () => pipe.renderFull({ hiTex: hi, ...hi.rows }, c.width, c.height, meta.settings, meta.autoEV, frame)); } finally { pipe.dropHi(hi); }
  } else {
    const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    c = renderGeometry(src, meta.settings.geometry, maxEdge, { maxArea: MAX_AREA });
    const frame = maskFrame(sw, sh, geomPlan(sw, sh, meta.settings.geometry, maxEdge, { maxArea: MAX_AREA }));
    out = withLook(pipe, meta, () => pipe.renderFull(c, c.width, c.height, meta.settings, meta.autoEV, frame));
  }
  let jpg = await new Promise((r) => out.toBlob(r, 'image/jpeg', quality / 100));
  if (seg) jpg = await insertExif(jpg, seg);
  const stem = meta.name.replace(/\.[^.]+$/, '');
  return { file: new File([jpg], `${stem}_edit.jpg`, { type: 'image/jpeg' }), w: c.width, h: c.height, exif: !!seg };
}

/**
 * 이 사진의 RAW 카메라 룩으로 그리고 곧바로 화면 사진 것으로 되돌린다. 기다림(await) 없이 한 번에 하므로
 * 해독을 기다리는 동안 화면 그리기나 사진 바꾸기가 끼어들어도 룩이 섞이지 않는다.
 */
function withLook(pipe, meta, draw) {
  const keep = pipe.look;
  pipe.setLook(meta.rawMode === 'camera' ? meta.look : null);
  try { return draw(); } finally { pipe.setLook(keep); }
}

export function download(files) {
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
}

export const canShareFiles = (files) => !!(navigator.canShare && navigator.canShare({ files }));

// ---- Google Drive (사용자가 만든 OAuth 클라이언트로, drive.file 권한만) ----

const CFG = 'ls.drive';
export const driveConfig = () => JSON.parse(localStorage.getItem(CFG) || '{}');
export const saveDriveConfig = (c) => localStorage.setItem(CFG, JSON.stringify(c));

function script(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('script ' + src));
    document.head.append(s);
  });
}

let token = null, tokenExp = 0;

/** 버튼을 누른 그 순간에 불러야 iPad에서 로그인 창이 막히지 않는다 */
export async function driveToken() {
  const cfg = driveConfig();
  if (!cfg.clientId) throw new Error('Google Drive 설정에서 OAuth 클라이언트 ID를 넣어 주세요');
  if (token && Date.now() < tokenExp) return token;
  await script('https://accounts.google.com/gsi/client');
  return new Promise((res, rej) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (r) => {
        if (r.error) return rej(new Error(r.error));
        token = r.access_token;
        tokenExp = Date.now() + (r.expires_in - 60) * 1000;
        res(token);
      },
    });
    tc.requestAccessToken();
  });
}

/** Google Picker로 저장할 폴더를 고른다 (고른 폴더에만 앱이 쓸 수 있게 됨) */
export async function pickDriveFolder() {
  const cfg = driveConfig();
  if (!cfg.apiKey || !cfg.appId) throw new Error('API 키와 프로젝트 번호를 넣어 주세요');
  const tk = await driveToken();
  await script('https://apis.google.com/js/api.js');
  await new Promise((r) => gapi.load('picker', r));
  return new Promise((res) => {
    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
    new google.picker.PickerBuilder()
      .addView(view).setOAuthToken(tk).setDeveloperKey(cfg.apiKey).setAppId(cfg.appId)
      .setTitle('보정본을 저장할 폴더').setCallback((d) => {
        if (d.action === google.picker.Action.PICKED) {
          const f = d.docs[0];
          saveDriveConfig({ ...driveConfig(), folderId: f.id, folderName: f.name });
          res(f);
        } else if (d.action === google.picker.Action.CANCEL) res(null);
      }).build().setVisible(true);
  });
}

export async function uploadToDrive(file) {
  const cfg = driveConfig();
  if (!cfg.folderId) throw new Error('먼저 저장할 Drive 폴더를 골라 주세요');
  const tk = await driveToken();
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: file.name, parents: [cfg.folderId] })], { type: 'application/json' }));
  form.append('file', file);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tk }, body: form,
  });
  if (!r.ok) throw new Error(`Drive 업로드 실패 ${r.status}`);
  return r.json();
}
