// 자르기·회전: 90° 단위 회전 → 좌우 뒤집기 → 수평 맞추기(빈 모서리가 안 생기게 확대) → 자르기.
// crop은 회전·수평을 마친 틀 기준 0–1 좌표 {x, y, w, h}.

export const ASPECTS = [['original', '원본 비율'], ['free', '자유'], ['1:1', '1:1'], ['4:5', '4:5'], ['5:4', '5:4'],
  ['3:2', '3:2'], ['2:3', '2:3'], ['16:9', '16:9'], ['9:16', '9:16']];

/** 90° 회전을 마친 틀의 크기 */
export function frameSize(w, h, g) {
  return g.rotate % 180 ? [h, w] : [w, h];
}

/** 원하는 비율(가로/세로, px 기준). free면 null */
export function aspectRatio(g, W, H) {
  if (g.aspect === 'free') return null;
  if (g.aspect === 'original') return W / H;
  const [a, b] = g.aspect.split(':').map(Number);
  return a / b;
}

/** 틀 W×H 안에서 비율 r의 가장 큰 가운데 사각형 (0–1 좌표) */
export function maxCrop(r, W, H) {
  if (!r) return { x: 0, y: 0, w: 1, h: 1 };
  let w = W, h = W / r;
  if (h > H) { h = H; w = H * r; }
  return { x: (1 - w / W) / 2, y: (1 - h / H) / 2, w: w / W, h: h / H };
}

/**
 * src(이미지·캔버스)에 기하 설정을 입혀 새 캔버스로. 긴 변 maxEdge, 면적 maxArea 이하.
 * ignoreCrop이면 자르기 전 전체 틀(자르기 편집 화면용).
 */
/**
 * 원본 sw×sh → 결과 { w, h, m }. m은 원본 화소 좌표(가운데 원점)를 결과 화소 좌표로 옮기는 DOMMatrix.
 * size [w, h]를 주면 그 크기에 맞춘다 (16비트 원본을 8비트 미리보기와 같은 크기로 그릴 때).
 */
export function geomPlan(sw, sh, g, maxEdge, { ignoreCrop = false, maxArea = Infinity, size = null } = {}) {
  const [W, H] = frameSize(sw, sh, g);
  const th = (g.angle || 0) * Math.PI / 180, c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
  const cover = Math.max((W * c + H * s) / W, (W * s + H * c) / H);
  const cr = (!ignoreCrop && g.crop) || { x: 0, y: 0, w: 1, h: 1 };
  const ow = W * cr.w, oh = H * cr.h;
  const k = size ? size[0] / ow : Math.min(1, maxEdge / Math.max(ow, oh), Math.sqrt(maxArea / (ow * oh)));
  const w = size ? size[0] : Math.max(1, Math.round(ow * k)), h = size ? size[1] : Math.max(1, Math.round(oh * k));
  const m = new DOMMatrix().scale(k, k).translate(-cr.x * W, -cr.y * H).translate(W / 2, H / 2)
    .rotate(th * 180 / Math.PI).scale(cover, cover).rotate(g.rotate).scale(g.flip ? -1 : 1, 1);
  return { w, h, m };
}

export function renderGeometry(src, g, maxEdge, opts = {}) {
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  const { w, h, m } = geomPlan(sw, sh, g, maxEdge, opts);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const x = cv.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.setTransform(m);
  x.drawImage(src, -sw / 2, -sh / 2, sw, sh);
  return cv;
}

/** 마스크용: 결과의 정규화 좌표(0–1, 아래로) → 원본 uv. 크기와 상관없어 썸네일·내보내기에 그대로 쓴다 */
export function maskFrame(sw, sh, plan) {
  const { row0, row1 } = geomRows(sw, sh, plan), L = Math.max(sw, sh);
  return { row0: [row0[0] * plan.w, row0[1] * plan.h, row0[2]], row1: [row1[0] * plan.w, row1[1] * plan.h, row1[2]], aspect: [sw / L, sh / L] };
}

/** 16비트 원본용: 결과 화소 → 원본 uv(0–1, 위쪽이 0)로 가는 두 줄 [a, b, c] (geomPlan의 역변환) */
export function geomRows(sw, sh, plan) {
  const v = plan.m.inverse();
  return { row0: [v.a / sw, v.c / sw, (v.e + sw / 2) / sw], row1: [v.b / sh, v.d / sh, (v.f + sh / 2) / sh] };
}

/** 자르기 편집 틀: 화면의 캔버스 위에 사각형을 띄우고 끌어서 옮기기·모서리로 크기 바꾸기 */
export class CropBox {
  constructor(viewer, canvas, onChange) {
    this.v = viewer;
    this.c = canvas;
    this.onChange = onChange;
    this.box = document.createElement('div');
    this.box.className = 'cropbox';
    for (const h of ['nw', 'ne', 'sw', 'se']) {
      const d = document.createElement('i');
      d.dataset.h = h;
      this.box.append(d);
    }
    this.box.hidden = true;
    viewer.append(this.box);
    this.box.addEventListener('pointerdown', (e) => this.down(e));
    this.box.addEventListener('pointermove', (e) => this.move(e));
    this.box.addEventListener('pointerup', (e) => { e.stopPropagation(); this.drag = null; });
    this.box.addEventListener('pointercancel', () => { this.drag = null; });
  }

  show(crop, ratio, W, H) {
    this.crop = { ...crop };
    this.ratio = ratio;
    this.W = W;
    this.H = H;
    this.box.hidden = false;
    this.place();
  }

  hide() { this.box.hidden = true; }

  place() {
    const vr = this.v.getBoundingClientRect(), r = this.c.getBoundingClientRect(), q = this.crop;
    Object.assign(this.box.style, {
      left: `${r.left - vr.left + q.x * r.width}px`, top: `${r.top - vr.top + q.y * r.height}px`,
      width: `${q.w * r.width}px`, height: `${q.h * r.height}px`,
    });
  }

  down(e) {
    e.preventDefault();
    e.stopPropagation();
    this.box.setPointerCapture(e.pointerId);
    this.drag = { h: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, start: { ...this.crop } };
  }

  move(e) {
    if (!this.drag) return;
    e.stopPropagation();
    const r = this.c.getBoundingClientRect(), d = this.drag, s = d.start;
    const dx = (e.clientX - d.x) / r.width, dy = (e.clientY - d.y) / r.height;
    let { x, y, w, h } = s;
    const MIN = 0.05;
    if (d.h === 'move') {
      x = Math.min(1 - w, Math.max(0, s.x + dx));
      y = Math.min(1 - h, Math.max(0, s.y + dy));
    } else {
      const left = d.h.includes('w'), top = d.h.includes('n');
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      if (left) x0 = Math.min(x1 - MIN, Math.max(0, x0 + dx)); else x1 = Math.max(x0 + MIN, Math.min(1, x1 + dx));
      if (top) y0 = Math.min(y1 - MIN, Math.max(0, y0 + dy)); else y1 = Math.max(y0 + MIN, Math.min(1, y1 + dy));
      w = x1 - x0; h = y1 - y0; x = x0; y = y0;
      if (this.ratio) {   // 비율 고정: 가로를 기준으로 세로를 맞추고, 넘치면 세로 기준
        const rN = this.ratio * this.H / this.W;   // 0–1 좌표에서 w/h
        let nh = w / rN;
        if ((top ? y1 - nh : y0 + nh) < 0 || (top ? y1 - nh : y0 + nh) > 1) { nh = top ? y1 : 1 - y0; w = nh * rN; if (left) x = x1 - w; }
        h = nh;
        if (top) y = y1 - h;
        if (x < 0) { x = 0; w = (left ? x1 : 1); h = w / rN; if (top) y = y1 - h; }
        if (x + w > 1) { w = 1 - x; h = w / rN; if (top) y = y1 - h; }
      }
    }
    this.crop = { x, y, w, h };
    this.place();
    this.onChange(this.crop);
  }
}
