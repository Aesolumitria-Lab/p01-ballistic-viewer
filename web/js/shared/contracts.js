/* P01 visualizer · shared contract (read-only for core/visual owners)
 *
 * core 与 visual 两层都只读此文件，不在此处写业务逻辑。
 * 所有模块通过 window.P01 命名空间协作。
 */
(function () {
  const P01 = (window.P01 = window.P01 || {});

  P01.version = "0.1.0";
  P01.schema = "p01viz/1";

  // 逻辑画布：96×54 格 × 10px = 960×540（16:9）
  P01.GRID_W = 96;
  P01.GRID_H = 54;
  P01.PX = 10;
  P01.VIEW_W = P01.GRID_W * P01.PX;
  P01.VIEW_H = P01.GRID_H * P01.PX;
  P01.FPS = 60;
  P01.ROUNDS = 40;

  // 四席固定颜色（色盲可区分）+ 图形纹样，视觉层可微调明度，不得换色相。
  P01.seats = [
    { id: 0, key: "cyan",   name: "SEAT 1", color: "#35e0d0", dark: "#0e6f68", light: "#b8fff7", glyph: "circle" },
    { id: 1, key: "amber",  name: "SEAT 2", color: "#ffb340", dark: "#8a5410", light: "#ffe3ae", glyph: "diamond" },
    { id: 2, key: "violet", name: "SEAT 3", color: "#b07cff", dark: "#5a2f9e", light: "#e6d4ff", glyph: "triangle" },
    { id: 3, key: "lime",   name: "SEAT 4", color: "#9fe35a", dark: "#4c7a1e", light: "#e2ffb8", glyph: "square" }
  ];

  P01.palette = {
    // 天/海/地形/UI 基础色；可在 theme.css 里扩展
    skyTop: "#07101c",
    skyMid: "#0d2433",
    skyLow: "#1b4a58",
    sun: "#ffb56b",
    seaFar: "#12384a",
    seaNear: "#0c2633",
    dirt0: "#6b4226",
    dirt1: "#7d4f2d",
    dirt2: "#54321d",
    dirtSpeck: "#9a6537",
    rock0: "#2d3a4b",
    rock1: "#202b39",
    rockEdge: "#44566b",
    grass0: "#4f8f5a",
    grass1: "#356b3f",
    water0: "#1d6d93",
    water1: "#2b8fb4",
    waterFoam: "#a8f3ff",
    ink: "#eaf6ff",
    inkDim: "#93aec2",
    danger: "#ff5d5d",
    gold: "#ffd166",
    panel: "#0b1826",
    panel2: "#12263a",
    line: "#2b4a63"
  };

  P01.weapons = {
    1: { id: "ROCKET",  label: "火箭",  short: "RKT", color: "#ff9e64" },
    2: { id: "GRENADE", label: "手雷",  short: "GRN", color: "#ffd166" },
    3: { id: "DRILL",   label: "钻头",  short: "DRL", color: "#8be9fd" }
  };

  P01.eventTypes = [
    "round", "move", "settle", "fire", "tick", "bounce", "dig",
    "explode", "water", "turn_end"
  ];

  P01.faultText = ["正常", "非法", "超时", "崩溃"];

  // 工具函数（纯函数，双方可用）
  P01.util = {
    clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
    lerp(a, b, t) { return a + (b - a) * t; },
    easeOutCubic(t) { t = 1 - t; return 1 - t * t * t; },
    easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    // 确定性伪随机（不要用 Math.random 做视觉随机）
    rng(seed) {
      let s = seed >>> 0;
      return function () {
        s = (s + 0x9e3779b9) >>> 0;
        let t = s;
        t ^= t >>> 16; t = Math.imul(t, 0x21f0aaad) >>> 0;
        t ^= t >>> 15; t = Math.imul(t, 0x735a2d97) >>> 0;
        t ^= t >>> 15;
        return (t >>> 0) / 4294967296;
      };
    },
    q16(v) { return v / 65536; },
    safeText(v) { return v === null || v === undefined ? "" : String(v); },
    fmt(n) { return (n >= 0 ? "+" : "") + n; }
  };

  // 视觉层在加载后填充并 resolve；核心等待此 Promise 再初始化。
  P01.visual = null;
  P01.visualReady = new Promise((resolve) => { P01._resolveVisual = resolve; });
  P01.provideVisual = function (api) {
    P01.visual = api;
    P01._resolveVisual(api);
  };

  // 核心在初始化后填充，供调试/Remotion 使用。
  P01.core = null;
  P01.ready = new Promise((resolve) => { P01._resolveCore = resolve; });
  P01.provideCore = function (api) {
    P01.core = api;
    P01._resolveCore(api);
  };
})();
