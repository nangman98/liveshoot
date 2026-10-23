// 3D LUT 가져오기: .cube(Adobe/Resolve 형식)와 HaldCLUT PNG → 64³ RGB 표. 파일은 이 기기에만 저장한다.

import { loadImage } from './export.js';

export const LUT_SIZE = 64;
export const INPUTS = [['srgb', 'sRGB (일반 사진)'], ['flog2', 'F-Log2 (후지 공식 LUT)'], ['flog', 'F-Log (후지 공식 LUT)']];

/** 파일 이름·제목으로 입력 방식을 짐작 (후지 공식 LUT 이름에 FLog2·FLog가 들어 있음) */
export function guessInput(name) {
  if (/f-?log2/i.test(name)) return 'flog2';
  if (/f-?log/i.test(name)) return 'flog';
  return 'srgb';
}

/** src(N³, RGB 0–1, 빨강이 가장 빨리 바뀜)를 64³ Uint8 RGB로 다시 표본 (삼선형 보간) */
function resample(src, N) {
  const M = LUT_SIZE, out = new Uint8Array(M * M * M * 3);
  const at = (r, g, b, c) => src[((b * N + g) * N + r) * 3 + c];
  for (let b = 0; b < M; b++) for (let g = 0; g < M; g++) for (let r = 0; r < M; r++) {
    const fr = r / (M - 1) * (N - 1), fg = g / (M - 1) * (N - 1), fb = b / (M - 1) * (N - 1);
    const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
    const r1 = Math.min(N - 1, r0 + 1), g1 = Math.min(N - 1, g0 + 1), b1 = Math.min(N - 1, b0 + 1);
    const dr = fr - r0, dg = fg - g0, db = fb - b0;
    for (let c = 0; c < 3; c++) {
      const c00 = at(r0, g0, b0, c) * (1 - dr) + at(r1, g0, b0, c) * dr, c10 = at(r0, g1, b0, c) * (1 - dr) + at(r1, g1, b0, c) * dr;
      const c01 = at(r0, g0, b1, c) * (1 - dr) + at(r1, g0, b1, c) * dr, c11 = at(r0, g1, b1, c) * (1 - dr) + at(r1, g1, b1, c) * dr;
      const v = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
      out[((b * M + g) * M + r) * 3 + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return out;
}

export function parseCube(text) {
  let N = 0, lo = [0, 0, 0], hi = [1, 1, 1], title = null;
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const k = line.split(/\s+/);
    if (k[0] === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (k[0] === 'LUT_3D_SIZE') N = +k[1];
    else if (k[0] === 'LUT_1D_SIZE') throw new Error('1D LUT는 지원하지 않음');
    else if (k[0] === 'DOMAIN_MIN') lo = k.slice(1, 4).map(Number);
    else if (k[0] === 'DOMAIN_MAX') hi = k.slice(1, 4).map(Number);
    else if (/^[-+.\d]/.test(k[0]) && k.length >= 3) vals.push(+k[0], +k[1], +k[2]);
  }
  if (!N || vals.length !== N * N * N * 3) throw new Error(`.cube 형식이 맞지 않음 (크기 ${N}, 값 ${vals.length / 3}개)`);
  if (lo.some((v) => v !== 0) || hi.some((v) => v !== 1)) throw new Error('DOMAIN이 0–1이 아닌 .cube는 아직 지원하지 않음');
  return { data: resample(Float32Array.from(vals), N), title };
}

/** HaldCLUT: 단계 L이면 그림이 L³ × L³, 표 한 변이 L². 왼쪽 위부터 한 줄씩, 빨강이 가장 빨리 바뀜 */
export async function parseHald(blob) {
  const img = await loadImage(blob);
  const W = img.naturalWidth, H = img.naturalHeight, L = Math.round(Math.cbrt(W));
  if (W !== H || L * L * L !== W) throw new Error(`HaldCLUT 크기가 아님 (${W}×${H})`);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const px = x.getImageData(0, 0, W, H).data, N = L * L, src = new Float32Array(N * N * N * 3);
  for (let i = 0; i < N * N * N; i++) for (let k = 0; k < 3; k++) src[i * 3 + k] = px[i * 4 + k] / 255;
  return { data: resample(src, N) };
}

/** LiveShoot LUT 묶음(.lsluts): gzip JSON { format: 'liveshoot-luts', size: 64, luts: [{ name, input, data(base64) }] } */
export async function parseBundle(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const stream = head[0] === 0x1f && head[1] === 0x8b ? file.stream().pipeThrough(new DecompressionStream('gzip')) : file.stream();
  const j = JSON.parse(await new Response(stream).text());
  if (j.format !== 'liveshoot-luts' || j.size !== LUT_SIZE) throw new Error('LiveShoot LUT 묶음이 아님');
  return j.luts.map((l) => {
    const bin = atob(l.data), data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    if (data.length !== LUT_SIZE ** 3 * 3) throw new Error(`묶음 안 LUT 크기가 맞지 않음: ${l.name}`);
    return { name: l.name, input: l.input, data };
  });
}

/** 파일 하나 → [{ name, input, data }] (.cube·.png는 1개, .lsluts는 여러 개) */
export async function parseLUTFile(file) {
  const stem = file.name.replace(/\.[^.]+$/, '');
  if (/\.lsluts$/i.test(file.name)) return parseBundle(file);
  if (/\.cube$/i.test(file.name)) {
    const r = parseCube(await file.text());
    return [{ name: (r.title || stem).slice(0, 40), input: guessInput(file.name + ' ' + (r.title || '')), data: r.data }];
  }
  if (/\.png$/i.test(file.name)) return [{ name: stem.slice(0, 40), input: 'srgb', data: (await parseHald(file)).data }];
  throw new Error('.cube, HaldCLUT .png, .lsluts만 가져올 수 있음');
}
