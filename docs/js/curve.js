import { curveLUT } from './gl.js';

const COLORS = { rgb: '#e8e8e8', r: '#ff6b6b', g: '#5fd068', b: '#5b9dff' };

/** 점 커브 편집기. 끌기 = 옮기기, 빈 곳 누르기 = 점 추가, 점 두 번 누르기 = 지우기 (양 끝 점은 세로로만) */
export class CurveEditor {
  constructor(canvas, getPoints, onChange) {
    this.c = canvas;
    this.get = getPoints;      // (channel) => [[x,y],...]
    this.onChange = onChange;
    this.channel = 'rgb';
    this.hist = null;
    this.drag = -1;
    this.lastTap = { t: 0, i: -1 };
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => { this.drag = -1; });
    canvas.addEventListener('pointercancel', () => { this.drag = -1; });
  }

  pos(e) {
    const r = this.c.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  }

  down(e) {
    e.preventDefault();
    this.c.setPointerCapture(e.pointerId);
    const pts = this.get(this.channel), [x, y] = this.pos(e), r = this.c.getBoundingClientRect();
    let best = -1, bd = 18 / r.width;
    pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
    const now = Date.now();
    if (best >= 0 && this.lastTap.i === best && now - this.lastTap.t < 350 && best > 0 && best < pts.length - 1) {
      pts.splice(best, 1);
      this.lastTap = { t: 0, i: -1 };
      this.drag = -1;
      this.onChange();
      return;
    }
    this.lastTap = { t: now, i: best };
    if (best < 0) {
      pts.push([x, y]);
      pts.sort((a, b) => a[0] - b[0]);
      best = pts.findIndex((p) => p[0] === x && p[1] === y);
      this.lastTap = { t: now, i: best };
      this.onChange();
    }
    this.drag = best;
  }

  move(e) {
    if (this.drag < 0) return;
    const pts = this.get(this.channel), i = this.drag, [x, y] = this.pos(e);
    const lo = i === 0 ? 0 : pts[i - 1][0] + 0.01, hi = i === pts.length - 1 ? 1 : pts[i + 1][0] - 0.01;
    pts[i] = [i === 0 ? pts[i][0] : i === pts.length - 1 ? pts[i][0] : Math.min(hi, Math.max(lo, x)), y];
    this.onChange();
  }

  draw() {
    const c = this.c, dpr = window.devicePixelRatio || 1, W = c.clientWidth * dpr, H = c.clientHeight * dpr;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#1c1c1e';
    g.fillRect(0, 0, W, H);
    if (this.hist) {
      const h = this.hist, mx = Math.max(...h.r, ...h.g, ...h.b, 1);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.beginPath();
      g.moveTo(0, H);
      for (let i = 0; i < 64; i++) g.lineTo((i + 0.5) / 64 * W, H - (h.r[i] + h.g[i] + h.b[i]) / 3 / mx * H * 0.95);
      g.lineTo(W, H);
      g.fill();
    }
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = dpr;
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo(i * W / 4, 0); g.lineTo(i * W / 4, H); g.stroke();
      g.beginPath(); g.moveTo(0, i * H / 4); g.lineTo(W, i * H / 4); g.stroke();
    }
    g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke();
    const pts = this.get(this.channel), lut = curveLUT(pts);
    g.strokeStyle = COLORS[this.channel];
    g.lineWidth = 2 * dpr;
    g.beginPath();
    for (let i = 0; i < 256; i++) { const X = i / 255 * W, Y = H - lut[i] * H; i ? g.lineTo(X, Y) : g.moveTo(X, Y); }
    g.stroke();
    g.fillStyle = '#fff';
    for (const p of pts) { g.beginPath(); g.arc(p[0] * W, H - p[1] * H, 5 * dpr, 0, Math.PI * 2); g.fill(); }
  }
}
