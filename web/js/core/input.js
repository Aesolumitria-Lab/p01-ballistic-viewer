/* P01 core · 输入：键盘快捷键 + 画布拖拽/滚轮 */
import { clamp } from "./util.js";

const IGNORE_TAGS = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/;

export function bindInput({ renderer, camera, actions, canvas, getTimeline }) {
  const onKey = (e) => {
    const t = e.target;
    if (t && (IGNORE_TAGS.test(t.tagName) || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const tl = getTimeline();
    const shift = e.shiftKey;
    let handled = true;

    switch (e.key) {
      case " ":
      case "Spacebar":
        actions.toggle();
        break;
      case "ArrowLeft":
        actions.step(shift ? -10 : -1);
        break;
      case "ArrowRight":
        actions.step(shift ? 10 : 1);
        break;
      case "[":
        actions.speedStep(-1);
        break;
      case "]":
        actions.speedStep(1);
        break;
      case "d":
      case "D":
        actions.toggleDebug();
        break;
      case "u":
      case "U":
        actions.toggleUI();
        break;
      case "f":
      case "F":
        actions.fullscreen();
        break;
      case "m":
      case "M":
        actions.toggleMute();
        break;
      case "r":
      case "R":
        actions.restart();
        break;
      case "c":
      case "C":
        actions.cycleCamera();
        break;
      case ",":
        actions.moment(-1);
        break;
      case ".":
        actions.moment(1);
        break;
      case "Home":
        if (tl) actions.seekFrame(0);
        break;
      case "End":
        if (tl) actions.seekFrame(tl.totalFrames - 1);
        break;
      case "PageUp":
        actions.roundStep(-1);
        break;
      case "PageDown":
        actions.roundStep(1);
        break;
      case "Escape":
        actions.escape();
        break;
      case "1":
      case "2":
      case "3":
      case "4":
        actions.follow(parseInt(e.key, 10) - 1);
        break;
      default:
        handled = false;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  window.addEventListener("keydown", onKey);

  /* ---------------- 画布：拖拽 / 滚轮 ---------------- */

  let dragging = false;
  let lastX = 0, lastY = 0;

  const toCanvas = (ev) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * canvas.width,
      y: ((ev.clientY - r.top) / r.height) * canvas.height,
      w: canvas.width,
      h: canvas.height
    };
  };

  const onWheel = (ev) => {
    const tl = getTimeline();
    if (!tl) return;
    ev.preventDefault();
    const p = toCanvas(ev);
    camera.zoomAt(p.x, p.y, ev.deltaY, tl, p.w, p.h);
    renderer.markDirty();
    actions.cameraChanged(camera.modeString);
  };

  const onDown = (ev) => {
    const tl = getTimeline();
    if (!tl || ev.button !== 0) return;
    const p = toCanvas(ev);
    const cur = camera.resolve(tl.index, tl);
    // 双击复位由 dblclick 处理；这里先记录
    dragging = true;
    lastX = p.x;
    lastY = p.y;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* 合成事件 */ }
    canvas.style.cursor = "grabbing";
    // 拖拽同时把当前相机固定为手动，避免与平滑冲突
    if (camera.mode !== "manual") {
      camera.manual = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
      camera.mode = "manual";
      actions.cameraChanged(camera.modeString);
    }
  };

  const onMove = (ev) => {
    if (!dragging) return;
    const tl = getTimeline();
    if (!tl) return;
    const p = toCanvas(ev);
    const dx = p.x - lastX;
    const dy = p.y - lastY;
    if (!dx && !dy) return;
    lastX = p.x;
    lastY = p.y;
    camera.panBy(dx, dy, tl, p.w, p.h);
    renderer.markDirty();
  };

  const onUp = (ev) => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = "";
    if (canvas.releasePointerCapture && ev.pointerId !== undefined) {
      try { canvas.releasePointerCapture(ev.pointerId); } catch (_) { /* noop */ }
    }
  };

  const onDblClick = () => {
    actions.setCamera("auto");
  };

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  canvas.addEventListener("dblclick", onDblClick);

  return function unbind() {
    window.removeEventListener("keydown", onKey);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("dblclick", onDblClick);
  };
}

/**
 * 全局动作代理：HUD 里任何带 data-p01-action 的元素都能触发播放控制，
 * 视觉层自己画的按钮只要带上同样属性就能工作，核心不需要知道 DOM 结构。
 */
export function bindActionDelegation(root, actions) {
  const onClick = (ev) => {
    const el = ev.target && ev.target.closest ? ev.target.closest("[data-p01-action]") : null;
    if (!el || !root.contains(el)) return;
    ev.preventDefault();
    const action = el.getAttribute("data-p01-action");
    const value = el.getAttribute("data-value");
    const fn = actions[action];
    if (typeof fn === "function") fn(value, el);
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}

export function clientToCanvas(canvas, clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((clientX - r.left) / r.width) * canvas.width,
    y: ((clientY - r.top) / r.height) * canvas.height
  };
}

export function ratioFromEvent(track, clientX) {
  const r = track.getBoundingClientRect();
  return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
}
