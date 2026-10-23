// RAW(ARW·CR3·RAF·DNG 등)를 LibRaw(WebAssembly, docs/vendor/libraw)로 해독한다. 해독은 Web Worker에서.

import { libraw709, linearToSrgb, sensorProxy } from './camera.js';
import { tiffInfo } from './exif.js';

export const RAW_EXT = /\.(arw|srf|sr2|cr2|cr3|crw|nef|nrw|raf|rw2|rwl|orf|pef|dng|srw|3fr|iiq|x3f|erf|mef|mos|kdc)$/i;
export const isRaw = (f) => RAW_EXT.test(f.name || '');

let LibRaw;
const lib = async () => (LibRaw ||= (await import('../vendor/libraw/index.js')).default);

// 0–65535 → 반정밀도(half float) 비트. 16비트 해독값을 GPU의 RGBA16F 텍스처로 올릴 때 쓴다.
let HALF;
function halfTable() {
  if (HALF) return HALF;
  HALF = new Uint16Array(65536);
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  for (let v = 0; v < 65536; v++) {
    f[0] = v / 65535;
    const x = u[0], e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
    if (v === 0) HALF[v] = 0;
    else if (e <= 0) HALF[v] = Math.round(f[0] * 2 ** 24);                    // 비정규수 (v/65535 < 2^-14)
    else HALF[v] = (e << 10) + Math.round(m / 8192);                          // 반올림 넘침은 지수로 자연히 올라감
  }
  return HALF;
}

// 카메라 RGB 모드: LibRaw BT.709 출력 → 선형 → sRGB 부호화 (편집 파이프라인이 sRGB 부호화 값을 받음)
let CAM;
function camTables() {
  if (CAM) return CAM;
  const inv = libraw709(), T = halfTable(), half = new Uint16Array(65536), b8 = new Uint8Array(65536);
  for (let v = 0; v < 65536; v++) {
    const s = Math.min(1, Math.max(0, linearToSrgb(inv(v / 65536))));
    half[v] = T[Math.round(s * 65535)];
    b8[v] = Math.round(s * 255);
  }
  CAM = { half, b8, inv };
  return CAM;
}

/**
 * RAW → 방향을 맞춘 RGB 캔버스와 메타데이터.
 * half: 1/2 크기(2×2 묶음, 빠름). 화면용과 긴 변 2400–3000 px 내보내기에 충분.
 * hi: 16비트로 해독해 { width, height, data: RGBA half float }도 돌려준다 (섀도를 크게 올려도 계조가 안 끊기게).
 * canvas: 8비트 캔버스가 필요 없으면 false. thumb: 카메라가 넣어 둔 JPEG(Blob)도 꺼낸다.
 * camera: LibRaw 색 matrix 대신 화이트밸런스만 한 카메라 RGB (자동 밝기 끔). 카메라 JPEG 맞춤(camera.js)용이며
 *   proxy(96 px 선형 센서 그림)도 돌려준다. 캔버스·16비트 값은 sRGB 부호화한 카메라 RGB.
 */
export async function decodeRaw(blob, { half = true, hi = false, canvas = true, thumb = false, signal = null, camera = false } = {}) {
  const L = await lib(), raw = new L();
  // 취소: Worker를 끝내면 진행 중인 해독이 바로 실패로 끝나고 메모리를 돌려준다
  if (signal) { if (signal.aborted) raw.dispose(); else signal.addEventListener('abort', () => raw.dispose(), { once: true }); }
  try {
    await raw.open(new Uint8Array(await blob.arrayBuffer()), {
      halfSize: half, useCameraWb: true, userQual: 3,
      ...(camera ? { outputColor: 0, outputBps: 16, noAutoBright: true } : { outputColor: 1, outputBps: hi ? 16 : 8 }),
    });
    const meta = await raw.metadata(true);
    const img = await raw.imageData();
    if (!img || !img.data) throw new Error('RAW 해독 실패');
    const s = img.data, W = img.width, H = img.height, n = W * H;
    let c = null, hiImg = null, jpeg = null, proxy = null;
    const C = camera ? camTables() : null;
    if (camera) proxy = sensorProxy(s, W, H, C.inv);
    if (canvas) {
      c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const x = c.getContext('2d'), id = x.createImageData(W, H), d = id.data;
      // 16비트 → 8비트: Uint8ClampedArray가 반올림하므로 나누기만
      if (C) for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = C.b8[s[i]]; d[j + 1] = C.b8[s[i + 1]]; d[j + 2] = C.b8[s[i + 2]]; d[j + 3] = 255; }
      else if (hi) for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = s[i] / 257; d[j + 1] = s[i + 1] / 257; d[j + 2] = s[i + 2] / 257; d[j + 3] = 255; }
      else for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = s[i]; d[j + 1] = s[i + 1]; d[j + 2] = s[i + 2]; d[j + 3] = 255; }
      x.putImageData(id, 0, 0);
    }
    if (hi) {
      const T = C ? C.half : halfTable(), out = new Uint16Array(n * 4), one = 0x3c00;
      for (let i = 0, j = 0; i < n * 3; i += 3, j += 4) { out[j] = T[s[i]]; out[j + 1] = T[s[i + 1]]; out[j + 2] = T[s[i + 2]]; out[j + 3] = one; }
      hiImg = { width: W, height: H, data: out };
    }
    if (thumb) {
      try {
        const t = await raw.thumbnailData();
        if (t && t.format === 'jpeg' && t.data && Math.max(t.width, t.height) >= 640) jpeg = new Blob([t.data], { type: 'image/jpeg' });
      } catch { /* 내장 JPEG가 없는 RAW */ }
    }
    return { canvas: c, hi: hiImg, thumb: jpeg, proxy, meta };
  } finally {
    raw.dispose();
  }
}

/** ARW·NEF·DNG 같은 TIFF 구조 RAW의 EXIF (LibRaw가 못 읽는 Sony GPS 등). TIFF가 아니면 null */
export async function rawTiffInfo(blob) {
  const b = new Uint8Array(await blob.slice(0, 2 * 1024 * 1024).arrayBuffer());
  const le = b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0, be = b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a;
  return le || be ? tiffInfo(b) : null;
}

/** LibRaw 메타데이터 → 화면 표시용 info와 EXIF를 새로 쓸 재료. tiff: rawTiffInfo 결과(GPS·렌즈 보충) */
export function rawInfo(m, tiff) {
  const t = m.timestamp instanceof Date && !isNaN(m.timestamp) ? m.timestamp : null;
  // LibRaw는 카메라 시각을 UTC처럼 넘긴다 (Worker 시간대 UTC). 그대로 적는다.
  const p = (n) => String(n).padStart(2, '0');
  const date = t ? `${t.getUTCFullYear()}:${p(t.getUTCMonth() + 1)}:${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}` : null;
  const g = m.gps_data;
  let gps = null;
  if (g && g.gpsparsed && g.latref && g.longref) {
    const dec = (a) => a[0] + a[1] / 60 + a[2] / 3600;
    gps = { lat: dec(g.latitude) * (g.latref === 'S' ? -1 : 1), lon: dec(g.longitude) * (g.longref === 'W' ? -1 : 1) };
  }
  if (!gps && tiff && tiff.gps) gps = tiff.gps;
  // 촬영 시각은 TIFF의 카메라 현지 시각을 먼저 (LibRaw 값은 기기 시간대만큼 밀림: KST에서 −9시간)
  return {
    date: (tiff && tiff.date) || date, gps,
    model: (m.camera_model || '').trim() || null,
    make: (m.camera_make || '').trim() || null,
    lens: (m.lens && (m.lens.Lens || m.lens.makernotes?.Lens) || '').trim() || (tiff && tiff.lens) || null,
    iso: m.iso_speed || null, shutter: m.shutter || null, aperture: m.aperture || null, focal: m.focal_len || null,
  };
}
