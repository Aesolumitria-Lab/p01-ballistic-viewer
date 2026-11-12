/* P01 core · 相机
 * full / auto / follow:seat / manual（滚轮缩放 + 拖拽）。
 * 平滑用"按帧步进的指数滤波"，可从任意帧重新推导 → seek 结果确定一致。
 */
import { GRID_W, GRID_H, clamp, lerp, noise2 } from "./util.js";

const FULL = { x: 0, y: 0, w: GRID_W, h: GRID_H };
const ASPECT = GRID_H / GRID_W; // 0.5625
const TAU = 9;                  // 平滑时间常数（帧）
const REBUILD = 140;            // 回退重算窗口

export class Camera {
  constructor() {
    this.mode = "auto";
    this.seat = 0;
    this.manual = { x: 0, y: 0, w: GRID_W, h: GRID_H };
    this._smooth = { idx: -1, cam: null };
  }

  /** 'full' | 'auto' | 'follow:2' | 'manual' */
  setMode(mode, timeline) {
    const m = String(mode || "auto");
    if (m === "full" || m === "auto" || m === "manual") {
      this.mode = m;
    } else if (m.startsWith("follow")) {
      this.mode = "follow";
      const n = parseInt(m.split(":")[1], 10);
      this.seat = Number.isFinite(n) ? clamp(n, 0, 3) : 0;
    } else {
      this.mode = "auto";
    }
    if (this.mode === "manual" && timeline) {
      const cur = this.resolve(timeline.index, timeline);
      this.manual = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
    }
    this._smooth = { idx: -1, cam: null };
    return this.modeString;
  }

  get modeString() {
    return this.mode === "follow" ? "follow:" + this.seat : this.mode;
  }

  setFollow(seat, timeline) {
    this.mode = "follow";
    this.seat = clamp(seat | 0, 0, 3);
    this._smooth = { idx: -1, cam: null };
    return this.modeString;
  }

  /* ------------------------- 目标矩形 ------------------------- */

  target(idx, tl) {
    if (this.mode === "manual") return this._clampRect(this.manual);
    if (this.mode === "full") return FULL;

    const f = tl.frames[idx];
    if (!f) return FULL;

    if (this.mode === "follow") {
      const box = this._seatBox(f, this.seat);
      if (box) return this._fit(box, 9, 40);
      return FULL;
    }

    // auto
    const recentBoom = (f.fxLive || []).filter((fx) => fx.type === "explode" && idx - fx.frame < 26);
    if (f.projs && f.projs.length) {
      const pts = f.projs.map((p) => [p.x, p.y]);
      for (const fx of recentBoom) pts.push([fx.x, fx.y]);
      return this._fit(boxOf(pts, (p) => p), 8, 46);
    }
    if (recentBoom.length) {
      return this._fit(boxOf(recentBoom, (fx) => [fx.x, fx.y]), 10, 48);
    }
    if (f.aim && f.aim.length) {
      const pts = [];
      for (const a of f.aim) {
        pts.push(a.from);
        if (a.land) pts.push(a.land);
        if (a.pts && a.pts.length > 2) pts.push(a.pts[Math.floor(a.pts.length / 2)]);
      }
      return this._fit(boxOf(pts, (p) => p), 9, 46);
    }
    if (f.phase === "final" && f.winner >= 0) {
      const box = this._seatBox(f, f.winner);
      if (box) return this._fit(box, 10, 40);
      return FULL;
    }
    const alive = (f.worms || []).filter((w) => w.alive);
    if (alive.length && alive.length < f.worms.length) {
      return this._fit(boxOf(alive, (w) => [w.x, w.y]), 8, 56);
    }
    return FULL;
  }

  _seatBox(frame, seat) {
    const mine = (frame.worms || []).filter((w) => w.seat === seat && w.alive);
    if (!mine.length) return null;
    return boxOf(mine, (w) => [w.x, w.y]);
  }

  _fit(box, pad, minW) {
    let { minX, minY, maxX, maxY } = box;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    let w = Math.max(maxX - minX, (maxY - minY) / ASPECT, minW);
    w = clamp(w, 34, GRID_W);
    const h = w * ASPECT;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return this._clampRect({ x: cx - w / 2, y: cy - h / 2, w, h });
  }

  _clampRect(r) {
    let w = clamp(r.w, 22, GRID_W);
    let h = w * ASPECT;
    if (h > GRID_H) { h = GRID_H; w = h / ASPECT; }
    const x = clamp(r.x, 0, GRID_W - w);
    const y = clamp(r.y, 0, GRID_H - h);
    return { x, y, w, h };
  }

  /* ------------------------- 求值（含平滑 + 震屏） ------------------------- */

  resolve(idx, tl) {
    if (!tl || !tl.totalFrames) return Object.assign({}, FULL, { zoom: 1, shakeX: 0, shakeY: 0 });

    const i = clamp(idx | 0, 0, tl.totalFrames - 1);
    let cam;

    if (this.mode === "manual" || this.mode === "full") {
      cam = this.target(i, tl);
    } else {
      const cache = this._smooth;
      if (cache.idx === i && cache.cam) {
        cam = cache.cam;
      } else if (cache.cam && cache.idx === i - 1) {
        cam = mixRect(cache.cam, this.target(i, tl), 1 - Math.exp(-1 / TAU));
        this._smooth = { idx: i, cam };
      } else {
        const start = Math.max(0, i - REBUILD);
        let c = this.target(start, tl);
        const k = 1 - Math.exp(-1 / TAU);
        for (let n = start + 1; n <= i; n++) c = mixRect(c, this.target(n, tl), k);
        cam = c;
        this._smooth = { idx: i, cam };
      }
    }

    const shake = this.shakeAt(i, tl);
    return {
      x: cam.x, y: cam.y, w: cam.w, h: cam.h,
      zoom: GRID_W / cam.w,
      shakeX: shake.x, shakeY: shake.y, shakeAmp: shake.amp,
      mode: this.modeString
    };
  }

  shakeAt(idx, tl) {
    const f = tl.frames[idx];
    if (!f || !f.fxLive) return { x: 0, y: 0, amp: 0 };
    let amp = 0, seed = 0;
    for (const fx of f.fxLive) {
      if (fx.type !== "explode") continue;
      const age = idx - fx.frame;
      if (age < 0 || age > 22) continue;
      const a = (1 - age / 22) * (fx.radius >= 3 ? 4.6 : 3.2);
      if (a > amp) { amp = a; seed = fx.id; }
    }
    if (amp < 0.05) return { x: 0, y: 0, amp: 0 };
    const nx = noise2(idx, 17, 3 + seed) * 2 - 1;
    const ny = noise2(idx, 29, 7 + seed) * 2 - 1;
    return { x: nx * amp, y: ny * amp * 0.7, amp };
  }

  /* ------------------------- 手动交互 ------------------------- */

  zoomAt(screenX, screenY, deltaY, tl, canvasW, canvasH) {
    const cur = this.resolve(tl.index, tl);
    if (this.mode !== "manual") {
      this.manual = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
      this.mode = "manual";
    }
    const factor = Math.exp(clamp(deltaY, -240, 240) * 0.0016);
    const w = clamp(this.manual.w * factor, 26, GRID_W);
    const h = w * ASPECT;
    const u = clamp(screenX / canvasW, 0, 1);
    const v = clamp(screenY / canvasH, 0, 1);
    const wx = this.manual.x + u * this.manual.w;
    const wy = this.manual.y + v * this.manual.h;
    this.manual = this._clampRect({ x: wx - u * w, y: wy - v * h, w, h });
    return this.modeString;
  }

  panBy(dxPx, dyPx, tl, canvasW, canvasH) {
    const cur = this.resolve(tl.index, tl);
    if (this.mode !== "manual") {
      this.manual = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
      this.mode = "manual";
    }
    const gx = (dxPx / canvasW) * this.manual.w;
    const gy = (dyPx / canvasH) * this.manual.h;
    this.manual = this._clampRect({
      x: this.manual.x - gx, y: this.manual.y - gy,
      w: this.manual.w, h: this.manual.h
    });
    return this.modeString;
  }
}

function mixRect(a, b, k) {
  return {
    x: lerp(a.x, b.x, k),
    y: lerp(a.y, b.y, k),
    w: lerp(a.w, b.w, k),
    h: lerp(a.h, b.h, k)
  };
}

function boxOf(arr, pick) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of arr) {
    const p = pick(it);
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: GRID_W, maxY: GRID_H };
  return { minX, minY, maxX, maxY };
}
