// 원본 JPEG의 EXIF(촬영 날짜·위치·카메라)를 읽고, 내보낸 JPEG에 다시 넣는다.
// 브라우저가 캔버스로 JPEG를 만들면 EXIF가 전부 빠지기 때문.

const TIFF = 10;   // APP1 세그먼트 안 TIFF 헤더 위치: FF E1 + 길이 2 + "Exif\0\0"

/** JPEG 앞부분에서 EXIF APP1 세그먼트(마커 포함)를 찾는다. JPEG가 아니거나 없으면 null */
export async function readExif(blob) {
  const b = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 < b.length && b[p] === 0xff) {
    const m = b[p + 1], len = (b[p + 2] << 8) | b[p + 3];
    if (m === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
      const seg = b.slice(p, p + 2 + len);
      return { seg, info: info(seg) };
    }
    if (m === 0xda || m === 0xd9) break;
    p += 2 + len;
  }
  return null;
}

function view(seg) {
  const le = seg[TIFF] === 0x49;
  const dv = new DataView(seg.buffer, seg.byteOffset + TIFF, seg.length - TIFF);
  return {
    dv, le,
    u16: (o) => dv.getUint16(o, le), u32: (o) => dv.getUint32(o, le),
    set16: (o, v) => dv.setUint16(o, v, le),
  };
}

function entries(T, off) {
  if (!off || off + 2 > T.dv.byteLength) return [];
  const n = T.u16(off), out = [];
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    if (e + 12 > T.dv.byteLength) break;
    out.push({ tag: T.u16(e), type: T.u16(e + 2), count: T.u32(e + 4), at: e + 8 });
  }
  return out;
}

const find = (list, tag) => list.find((e) => e.tag === tag);

function ascii(T, e) {
  if (!e) return null;
  const o = e.count <= 4 ? e.at : T.u32(e.at);
  let s = '';
  for (let i = 0; i < e.count - 1 && o + i < T.dv.byteLength; i++) s += String.fromCharCode(T.dv.getUint8(o + i));
  return s.trim() || null;
}

function rationals(T, e) {
  if (!e) return null;
  const o = T.u32(e.at), out = [];
  for (let i = 0; i < e.count; i++) out.push(T.u32(o + i * 8) / (T.u32(o + i * 8 + 4) || 1));
  return out;
}

/** 화면에 띄울 날짜·카메라·위치 */
export function info(seg) {
  try {
    const T = view(seg), ifd0 = entries(T, T.u32(4));
    const ex = find(ifd0, 0x8769), gp = find(ifd0, 0x8825);
    const exif = ex ? entries(T, T.u32(ex.at)) : [];
    const date = ascii(T, find(exif, 0x9003)) || ascii(T, find(ifd0, 0x0132));
    const model = ascii(T, find(ifd0, 0x0110));
    let gps = null;
    if (gp) {
      const g = entries(T, T.u32(gp.at));
      const la = rationals(T, find(g, 0x0002)), lo = rationals(T, find(g, 0x0004));
      if (la && lo) {
        const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
        gps = { lat: dms(la) * (ascii(T, find(g, 0x0001)) === 'S' ? -1 : 1), lon: dms(lo) * (ascii(T, find(g, 0x0003)) === 'W' ? -1 : 1) };
      }
    }
    return { date, model, gps };
  } catch {
    return { date: null, model: null, gps: null };
  }
}

/**
 * 내보낼 EXIF: 방향(Orientation)은 이미 사진에 입혔으니 1로, keepGPS가 false면 위치 항목을 비운다.
 * 원본 세그먼트는 건드리지 않고 사본을 고친다.
 */
export function prepare(seg, keepGPS) {
  const s = seg.slice(), T = view(s), ifd0 = entries(T, T.u32(4));
  const o = find(ifd0, 0x0112);
  if (o) T.set16(o.at, 1);
  const gp = find(ifd0, 0x8825);
  if (!keepGPS && gp) {
    const off = T.u32(gp.at);
    if (off + 2 <= T.dv.byteLength) T.set16(off, 0);   // GPS 항목 수 0 → 읽는 프로그램에 위치가 없음
  }
  return s;
}

/** 캔버스가 만든 JPEG에 EXIF APP1을 넣는다 (SOI 바로 뒤, JFIF APP0은 뺌) */
export async function insertExif(jpeg, seg) {
  const b = new Uint8Array(await jpeg.arrayBuffer());
  let p = 2;
  if (b[2] === 0xff && b[3] === 0xe0) p = 4 + ((b[4] << 8) | b[5]);
  return new Blob([b.subarray(0, 2), seg, b.subarray(p)], { type: 'image/jpeg' });
}
