/* P01 core · 渲染器：图层注册 + 60fps 主循环
 *
 * 契约见 docs/SPEC.md §5.2：
 *   P01.render.register({ name, z, draw(ctx, view, frame) })
 *   view = { camera, px, frame, trace, debug, ... }
 * 图层默认画在"世界像素"坐标系（1 格 = 10px，原点在地图左上）；
 * screen:true 的图层画在 960×540 屏幕坐标系（暗角、闪白等）。
 */
import { FPS, PX, VIEW_W, VIEW_H, clamp } from "./util.js";

const P01 = window.P01;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.ctx.imageSmoothingEnabled = false;

    this.layers = [];
    this.timeline = null;
    this.camera = null;

    this.playing = false;
    this.speed = 1;
    this.playhead = 0;
    this.index = -1;
    this.dirty = true;
    this.debug = false;

    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsN = 0;
    this._lastNow = 0;

    this._raf = null;
    this._frameHooks = [];
    this._endHandlers = [];
    this._playHandlers = [];
    this._seekHandlers = [];

    this.view = null;
    this.lastDrawnAt = 0;
  }

  /* ------------------------- 图层 ------------------------- */

  /** 注册图层；返回注销函数。z 越小越先画（背景 0 → 特效 40 → UI 900） */
  register(layer) {
    if (!layer || typeof layer.draw !== "function") {
      console.warn("[P01] render.register 需要 { name, z, draw }");
      return () => {};
    }
    const entry = {
      name: layer.name || "layer-" + this.layers.length,
      z: Number.isFinite(layer.z) ? layer.z : 0,
      screen: !!layer.screen,
      draw: layer.draw,
      enabled: layer.enabled !== false
    };
    this.layers.push(entry);
    this.layers.sort((a, b) => a.z - b.z);
    this.dirty = true;
    return () => this.unregister(entry);
  }

  unregister(layerOrName) {
    const i = this.layers.findIndex(
      (l) => l === layerOrName || l.name === layerOrName || l.draw === layerOrName
    );
    if (i >= 0) this.layers.splice(i, 1);
  }

  clearLayers() { this.layers.length = 0; }

  setLayerEnabled(name, on) {
    for (const l of this.layers) if (l.name === name) l.enabled = !!on;
  }

  /* ------------------------- 事件 ------------------------- */

  onFrame(fn) { this._frameHooks.push(fn); return () => this._off(this._frameHooks, fn); }
  onEnd(fn) { this._endHandlers.push(fn); return () => this._off(this._endHandlers, fn); }
  onPlayChange(fn) { this._playHandlers.push(fn); return () => this._off(this._playHandlers, fn); }
  onSeek(fn) { this._seekHandlers.push(fn); return () => this._off(this._seekHandlers, fn); }

  _off(arr, fn) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }

  /* ------------------------- 时间轴 / 播放 ------------------------- */

  setTimeline(timeline) {
    this.timeline = timeline;
    this.playhead = 0;
    this.index = -1;
    this.dirty = true;
    if (timeline && timeline.totalFrames) this.seek(0, "load");
  }

  setCamera(camera) { this.camera = camera; this.dirty = true; }

  setSpeed(x) {
    const v = clamp(Number(x) || 1, 0.05, 16);
    this.speed = v;
    this._emit(this._playHandlers, { playing: this.playing, speed: this.speed });
    return v;
  }

  get isPlaying() { return this.playing; }

  play() {
    if (!this.timeline) return;
    if (this.index >= this.timeline.totalFrames - 1) this.playhead = 0;
    this.playing = true;
    this._lastNow = 0;
    this._emit(this._playHandlers, { playing: true, speed: this.speed });
  }

  pause() {
    this.playing = false;
    this._emit(this._playHandlers, { playing: false, speed: this.speed });
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  /** 跳帧后立即重绘（同步） */
  seek(n, mode = "seek") {
    const tl = this.timeline;
    if (!tl || !tl.totalFrames) return null;
    const k = clamp(Math.floor(n), 0, tl.totalFrames - 1);
    this.playhead = k;
    const frame = this.drawAt(k, mode);
    this._emit(this._seekHandlers, { frame: k, mode });
    return frame;
  }

  step(delta) {
    if (!this.timeline) return;
    this.pause();
    return this.seek(this.index + delta);
  }

  /* ------------------------- 绘制 ------------------------- */

  drawAt(idx, mode = "seek") {
    const tl = this.timeline;
    if (!tl || !tl.totalFrames) return null;
    const k = clamp(Math.floor(idx), 0, tl.totalFrames - 1);
    const frame = tl.frames[k];
    const prev = this.index >= 0 ? tl.frames[this.index] : null;
    const prevIndex = this.index;

    const cam = this.camera
      ? this.camera.resolve(k, tl)
      : { x: 0, y: 0, w: 96, h: 54, shakeX: 0, shakeY: 0 };

    const view = {
      camera: cam,
      px: PX,
      frame,
      trace: tl.trace,
      debug: this.debug,
      fps: this.fps,
      width: VIEW_W,
      height: VIEW_H,
      timeline: tl,
      mode,
      renderer: this
    };
    this.view = view;

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#05090f";
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    const scale = VIEW_W / (cam.w * PX);

    ctx.save();
    ctx.translate(cam.shakeX || 0, cam.shakeY || 0);
    ctx.scale(scale, scale);
    ctx.translate(-cam.x * PX, -cam.y * PX);
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      if (!l.enabled || l.screen) continue;
      this._safeDraw(l, ctx, view);
    }
    ctx.restore();

    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      if (!l.enabled || !l.screen) continue;
      this._safeDraw(l, ctx, view);
    }

    this.index = k;
    this.dirty = false;
    this.lastDrawnAt = k;

    // 帧回调（视觉层据此触发一次性特效/音效）
    for (let i = 0; i < this._frameHooks.length; i++) {
      try {
        this._frameHooks[i](frame, prev, view, mode, prevIndex);
      } catch (e) {
        console.error("[P01] onFrame 回调异常", e);
      }
    }
    return frame;
  }

  _safeDraw(layer, ctx, view) {
    try {
      layer.draw(ctx, view, view.frame);
    } catch (e) {
      // 单层出错不能拖垮整帧
      if (!this._layerErrors || !this._layerErrors[layer.name]) {
        this._layerErrors = this._layerErrors || {};
        this._layerErrors[layer.name] = true;
        console.error(`[P01] 图层 "${layer.name}" 绘制异常`, e);
      }
    }
  }

  markDirty() { this.dirty = true; }

  /* ------------------------- 主循环 ------------------------- */

  start() {
    if (this._raf) return;
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      this._tick(now);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _tick(now) {
    const tl = this.timeline;
    if (!tl || !tl.totalFrames) return;

    let dt = this._lastNow ? (now - this._lastNow) / 1000 : 0;
    this._lastNow = now;
    if (dt > 0.25) dt = 0.25;
    if (dt > 0) {
      this._fpsAcc += dt;
      this._fpsN += 1;
      if (this._fpsAcc >= 0.4) {
        this.fps = Math.round(this._fpsN / this._fpsAcc);
        this._fpsAcc = 0;
        this._fpsN = 0;
      }
    }

    if (this.playing) {
      this.playhead += dt * FPS * this.speed;
      const last = tl.totalFrames - 1;
      if (this.playhead >= last) {
        this.playhead = last;
        this.drawAt(last, "play");
        this.pause();
        this._emit(this._endHandlers, { frame: last });
        return;
      }
    }

    const idx = Math.floor(this.playhead);
    if (idx !== this.index || this.dirty) {
      this.drawAt(idx, this.playing ? "play" : "idle");
    }
  }

  /* ------------------------- 导出 ------------------------- */

  capture(type = "image/png") {
    return this.canvas.toDataURL(type);
  }

  _emit(arr, payload) {
    for (let i = 0; i < arr.length; i++) {
      try { arr[i](payload); } catch (e) { console.error("[P01] 回调异常", e); }
    }
  }
}
