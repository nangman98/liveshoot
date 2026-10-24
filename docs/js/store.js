// 가져온 원본과 보정값을 브라우저(IndexedDB)에 둔다. 서버로는 아무것도 보내지 않는다.
// meta(보정값·썸네일)와 blob(원본)을 나눠, 슬라이더를 움직일 때 원본을 다시 쓰지 않게 한다.

const DB = 'liveshoot';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'id' });
      r.result.createObjectStore('blob');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

let dbp;
async function tx(name, mode, fn) {
  const db = await (dbp ||= open());
  return new Promise((res, rej) => {
    const t = db.transaction(name, mode);
    const req = fn(t.objectStore(name));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
  });
}

export const store = {
  putMeta: (m) => tx('meta', 'readwrite', (s) => s.put(m)),
  putBlob: (id, b) => tx('blob', 'readwrite', (s) => s.put(b, id)),
  getBlob: (id) => tx('blob', 'readonly', (s) => s.get(id)),
  delBlob: (id) => tx('blob', 'readwrite', (s) => s.delete(id)),
  list: async () => ((await tx('meta', 'readonly', (s) => s.getAll())) || []).sort((a, b) => b.added - a.added),
  async del(id) {
    await tx('meta', 'readwrite', (s) => s.delete(id));
    await tx('blob', 'readwrite', (s) => s.delete(id));
    await tx('blob', 'readwrite', (s) => s.delete(id + ':base'));
  },
  async clear() {
    await tx('meta', 'readwrite', (s) => s.clear());
    await tx('blob', 'readwrite', (s) => s.clear());
  },
};

export const defaults = () => ({
  autoExposure: true,
  profile: { id: 'color', amount: 100 },
  treatment: 'color',
  bw: [0, 0, 0, 0, 0, 0, 0, 0],
  geometry: { rotate: 0, flip: false, angle: 0, crop: null, aspect: 'original' },
  light: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
  curve: { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]], refineSat: 100,
    region: { highlights: 0, lights: 0, darks: 0, shadows: 0 } },
  color: { temp: 0, tint: 0, vibrance: 0, saturation: 0 },
  mixer: Array.from({ length: 8 }, () => ({ h: 0, s: 0, l: 0 })),
  point: { active: false, hue: 0, range: 30, hueShift: 0, satShift: 0, lumShift: 0, swatch: null },
  grading: {
    shadows: { h: 220, s: 0, l: 0 }, midtones: { h: 40, s: 0, l: 0 },
    highlights: { h: 40, s: 0, l: 0 }, global: { h: 0, s: 0, l: 0 },
    blending: 50, balance: 0,
  },
  effects: {
    texture: 0, clarity: 0, dehaze: 0,
    vignette: { amount: 0, midpoint: 50, feather: 50, roundness: 0, highlights: 0 },
    grain: { amount: 0, size: 25, roughness: 50 },
  },
  detail: {
    sharpen: { amount: 0, radius: 1.0, detail: 25, masking: 0 },
    nr: { amount: 0, detail: 50, contrast: 0 },
    cnr: { amount: 0, detail: 50, smoothness: 50 },
  },
  masks: [],   // 국소 보정 (masks.js)
});

/** 저장된 보정값에 새로 생긴 항목이 빠져 있으면 기본값으로 채운다 */
export function withDefaults(st) {
  const d = defaults();
  if (!st) return d;
  const fill = (a, b) => {
    for (const k of Object.keys(b)) {
      if (a[k] === undefined) a[k] = b[k];
      else if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) fill(a[k], b[k]);
    }
    return a;
  };
  return fill(structuredClone(st), d);
}

export const clone = (x) => structuredClone(x);
