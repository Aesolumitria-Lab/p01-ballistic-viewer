/* P01 core · 通用小工具（无依赖、纯函数）
 * 仅供 core/** 使用；对外 API 走 P01.core / window.__P01V__。
 */
const P01 = window.P01;

export const GRID_W = P01.GRID_W;
export const GRID_H = P01.GRID_H;
export const PX = P01.PX;
export const FPS = P01.FPS;
export const VIEW_W = P01.VIEW_W;
export const VIEW_H = P01.VIEW_H;

export const AIR = ".";
export const DIRT = "#";
export const ROCK = "X";

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function pad2(n) { return n < 10 ? "0" + n : String(n); }
export function signed(n) { return (n >= 0 ? "+" : "") + n; }
export function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
export function easeOutCubic(t) { const u = 1 - t; return 1 - u * u * u; }

export function fmtClock(frame, fps = FPS) {
  const total = Math.max(0, Math.round(frame / fps));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + (s < 10 ? "0" + s : s);
}

/** 取 (x,y,seed) 的确定性 0..1 噪声 */
export function noise2(x, y, seed = 0) {
  let n = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function isSolidChar(ch) { return ch === DIRT || ch === ROCK; }

export async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { cache: "no-cache", ...opts });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} · ${url}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  return res.json();
}

/** 秒级超时的 fetch，用于 /api 探测（服务未就绪时快速回退） */
export async function fetchJSONTimeout(url, ms = 2500, opts = {}) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, ms);
  try {
    return await fetchJSON(url, ctrl ? { ...opts, signal: ctrl.signal } : opts);
  } finally {
    clearTimeout(timer);
  }
}

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

export function clearNode(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

export function rafLoop(fn) {
  let alive = true;
  const tick = (now) => {
    if (!alive) return;
    fn(now);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => { alive = false; };
}

/** 二分查找：返回 feed 中最后一个 frame <= idx 的下标 */
export function lastIndexAtOrBefore(arr, idx, key = "frame") {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] <= idx) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}
