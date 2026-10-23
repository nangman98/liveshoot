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
    const model = ascii(T, find(ifd0, 0x0110)), lens = ascii(T, find(exif, 0xa434));
    let gps = null;
    if (gp) {
      const g = entries(T, T.u32(gp.at));
      const la = rationals(T, find(g, 0x0002)), lo = rationals(T, find(g, 0x0004));
      if (la && lo) {
        const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
        gps = { lat: dms(la) * (ascii(T, find(g, 0x0001)) === 'S' ? -1 : 1), lon: dms(lo) * (ascii(T, find(g, 0x0003)) === 'W' ? -1 : 1) };
      }
    }
    return { date, model, gps, lens };
  } catch {
    return { date: null, model: null, gps: null, lens: null };
  }
}

/** TIFF 파일 앞부분(ARW 등) → info와 같은 모양 */
export function tiffInfo(bytes) {
  const seg = new Uint8Array(TIFF + bytes.length);
  seg.set(bytes, TIFF);
  return info(seg);
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

/**
 * RAW처럼 JPEG식 EXIF가 없는 원본용: 날짜·카메라·렌즈·촬영값·(keepGPS면) 위치로 EXIF APP1을 새로 쓴다.
 * info = { make, model, date 'YYYY:MM:DD HH:MM:SS', lens, iso, shutter(s), aperture, focal(mm), gps {lat, lon} }
 */
export function buildExif(info, keepGPS) {
  const ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5, BYTE = 1;
  const rat = (v, den = 10000) => { if (v >= 1 || v === 0) return [Math.round(v * den), den]; const d = Math.round(1 / v); return [1, d]; };
  const ifd0 = [], exif = [], gps = [];
  const add = (list, tag, type, value) => { if (value != null && value !== '' && !(typeof value === 'number' && !isFinite(value))) list.push({ tag, type, value }); };
  add(ifd0, 0x010f, ASCII, info.make);
  add(ifd0, 0x0110, ASCII, info.model);
  add(ifd0, 0x0112, SHORT, [1]);
  add(ifd0, 0x0132, ASCII, info.date);
  add(exif, 0x829a, RATIONAL, info.shutter ? [rat(info.shutter)] : null);
  add(exif, 0x829d, RATIONAL, info.aperture ? [rat(info.aperture, 100)] : null);
  add(exif, 0x8827, SHORT, info.iso ? [Math.min(65535, Math.round(info.iso))] : null);
  add(exif, 0x9003, ASCII, info.date);
  add(exif, 0x920a, RATIONAL, info.focal ? [rat(info.focal, 100)] : null);
  add(exif, 0xa434, ASCII, info.lens);
  if (keepGPS && info.gps) {
    const dms = (v) => { v = Math.abs(v); const d = Math.floor(v), m = Math.floor((v - d) * 60), s = (v - d - m / 60) * 3600; return [[d, 1], [m, 1], [Math.round(s * 10000), 10000]]; };
    add(gps, 0x0000, BYTE, [2, 3, 0, 0]);
    add(gps, 0x0001, ASCII, info.gps.lat < 0 ? 'S' : 'N');
    add(gps, 0x0002, RATIONAL, dms(info.gps.lat));
    add(gps, 0x0003, ASCII, info.gps.lon < 0 ? 'W' : 'E');
    add(gps, 0x0004, RATIONAL, dms(info.gps.lon));
  }
  if (exif.length) ifd0.push({ tag: 0x8769, type: LONG, value: [0], ptr: 'exif' });
  if (gps.length) ifd0.push({ tag: 0x8825, type: LONG, value: [0], ptr: 'gps' });
  const ifds = [['ifd0', ifd0], ['exif', exif], ['gps', gps]].filter(([, l]) => l.length);
  for (const [, l] of ifds) l.sort((a, b) => a.tag - b.tag);

  const enc = new TextEncoder();
  const size = (e) => e.type === ASCII ? enc.encode(e.value).length + 1 : e.value.length * ({ 1: 1, 3: 2, 4: 4, 5: 8 })[e.type];
  // 배치: 헤더 8 → 각 IFD(2 + 12n + 4) 다음에 그 IFD의 큰 값들
  let off = 8;
  const at = {};
  for (const [name, l] of ifds) {
    at[name] = off;
    off += 2 + 12 * l.length + 4;
    for (const e of l) { const n = size(e); if (n > 4) { e.off = off; off += n + (n & 1); } }
  }
  const buf = new ArrayBuffer(off), dv = new DataView(buf), u8 = new Uint8Array(buf);
  u8.set([0x49, 0x49, 0x2a, 0x00]);
  dv.setUint32(4, 8, true);
  const put = (p, e) => {
    if (e.type === ASCII) { u8.set(enc.encode(e.value), p); u8[p + enc.encode(e.value).length] = 0; }
    else e.value.forEach((v, i) => {
      if (e.type === BYTE) dv.setUint8(p + i, v);
      else if (e.type === SHORT) dv.setUint16(p + i * 2, v, true);
      else if (e.type === LONG) dv.setUint32(p + i * 4, v, true);
      else { dv.setUint32(p + i * 8, v[0], true); dv.setUint32(p + i * 8 + 4, v[1], true); }
    });
  };
  for (const [name, l] of ifds) {
    let p = at[name];
    dv.setUint16(p, l.length, true);
    p += 2;
    for (const e of l) {
      if (e.ptr) e.value = [at[e.ptr]];
      const n = size(e);
      dv.setUint16(p, e.tag, true);
      dv.setUint16(p + 2, e.type, true);
      dv.setUint32(p + 4, e.type === ASCII ? n : e.value.length, true);
      if (n > 4) { dv.setUint32(p + 8, e.off, true); put(e.off, e); } else put(p + 8, e);
      p += 12;
    }
    dv.setUint32(p, 0, true);
  }
  const seg = new Uint8Array(4 + 6 + off), len = 2 + 6 + off;
  seg.set([0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  seg.set(u8, 10);
  return seg;
}
