// RAW(ARW·CR3·RAF·DNG 등)를 LibRaw(WebAssembly, docs/vendor/libraw)로 해독한다. 해독은 Web Worker에서.

export const RAW_EXT = /\.(arw|srf|sr2|cr2|cr3|crw|nef|nrw|raf|rw2|rwl|orf|pef|dng|srw|3fr|iiq|x3f|erf|mef|mos|kdc)$/i;
export const isRaw = (f) => RAW_EXT.test(f.name || '');

let LibRaw;
const lib = async () => (LibRaw ||= (await import('../vendor/libraw/index.js')).default);

/**
 * RAW → 방향을 맞춘 RGB 캔버스와 메타데이터.
 * half: 1/2 크기(2×2 묶음, 빠름). 화면용과 긴 변 2400–3000 px 내보내기에 충분.
 */
export async function decodeRaw(blob, { half = true } = {}) {
  const L = await lib(), raw = new L();
  try {
    await raw.open(new Uint8Array(await blob.arrayBuffer()), {
      halfSize: half, useCameraWb: true, outputColor: 1, outputBps: 8, userQual: 3,
    });
    const meta = await raw.metadata(true);
    const img = await raw.imageData();
    if (!img || !img.data) throw new Error('RAW 해독 실패');
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const x = c.getContext('2d'), id = x.createImageData(img.width, img.height), s = img.data, d = id.data;
    for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = s[i]; d[j + 1] = s[i + 1]; d[j + 2] = s[i + 2]; d[j + 3] = 255; }
    x.putImageData(id, 0, 0);
    return { canvas: c, meta };
  } finally {
    raw.dispose();
  }
}

/** LibRaw 메타데이터 → 화면 표시용 info와 EXIF를 새로 쓸 재료 */
export function rawInfo(m) {
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
  return {
    date, gps,
    model: (m.camera_model || '').trim() || null,
    make: (m.camera_make || '').trim() || null,
    lens: (m.lens && (m.lens.Lens || m.lens.makernotes?.Lens) || '').trim() || null,
    iso: m.iso_speed || null, shutter: m.shutter || null, aperture: m.aperture || null, focal: m.focal_len || null,
  };
}
