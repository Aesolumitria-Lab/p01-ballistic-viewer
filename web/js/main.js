/* P01 BALLISTIC · 观战器入口
 *
 * 负责：页面骨架装配、setup → stage 流程、trace 载入、视觉层对接、
 *       URL 参数、window.__P01V__（Remotion / 调试）。
 * 帧烘焙在 core/timeline.js，绘制在 core/render.js，相机/输入/HUD 分文件。
 */
import { loadTrace } from "./core/trace.js";
import { createTimeline } from "./core/timeline.js";
import { Renderer } from "./core/render.js";
import { Camera } from "./core/camera.js";
import { bindInput, bindActionDelegation } from "./core/input.js";
import { CoreHUD, createDebugLayers } from "./core/hud.js";
import { createFallbackVisual } from "./core/fallback-visual.js";
import { clamp, fetchJSONTimeout, el, clearNode } from "./core/util.js";

const P01 = window.P01;
const SPEEDS = [0.25, 0.5, 1, 2, 4];

const DEFAULT_BOTS = ["tide_hard", "tide_normal", "tide_easy", "random4"];

const SAMPLE_FALLBACK = [
  { id: "demo-4seat", label: "4 SEAT · 标准局", sub: "public4-01 · seed 1" }
];

/* ================================================================ */
/* 状态                                                              */
/* ================================================================ */

const params = new URLSearchParams(location.search);

const state = {
  trace: null,
  timeline: null,
  meta: null,
  catalog: null,
  visual: null,
  realVisual: false,
  ui: params.get("ui") !== "0",
  debug: params.get("debug") === "1",
  muted: params.get("muted") === "1",
  speed: 1,
  lastRun: null,
  resultShown: false,
  initialFrame: params.has("frame") ? Math.max(0, parseInt(params.get("frame"), 10) || 0) : null
};

const SAMPLE_BASE = /\/web\/[^/]*$/.test(location.pathname)
  ? "../traces/samples/"
  : "/traces/samples/";
const SAMPLE_ABS = "/traces/samples/";

const $ = (id) => document.getElementById(id);

const canvas = $("scene");
const renderer = new Renderer(canvas);
P01.render = renderer;

const camera = new Camera();
renderer.setCamera(camera);

const hud = new CoreHUD({ onAction: dispatch, canvas });

/* ================================================================ */
/* 动作分发（HUD / 键盘 / 调试都用这一套）                            */
/* ================================================================ */

const actions = {
  toggle: () => renderer.toggle(),
  play: () => renderer.play(),
  pause: () => renderer.pause(),
  step: (v) => { renderer.pause(); renderer.seek(renderer.index + (parseInt(v, 10) || 1)); },
  seekFrame: (v) => { renderer.pause(); renderer.seek(parseInt(v, 10) || 0); },
  setSpeed: (v) => setSpeed(parseFloat(v)),
  speedStep: (dir) => {
    const i = SPEEDS.indexOf(nearestSpeed(state.speed));
    setSpeed(SPEEDS[clamp(i + dir, 0, SPEEDS.length - 1)]);
  },
  moment: (dir) => jumpMoment(parseInt(dir, 10) || 1),
  seekRound: (v) => jumpRound(parseInt(v, 10)),
  roundStep: (dir) => jumpRound(null, parseInt(dir, 10) || 1),
  setCamera: (mode) => {
    camera.setMode(mode, state.timeline);
    hud.setCameraLabel(camera.modeString);
    renderer.markDirty();
  },
  cameraChanged: (mode) => hud.setCameraLabel(mode),
  cycleCamera: () => {
    const order = ["auto", "full", "follow:0", "follow:1", "follow:2", "follow:3", "manual"];
    const i = order.indexOf(camera.modeString);
    actions.setCamera(order[(i + 1) % order.length]);
  },
  follow: (seat) => actions.setCamera("follow:" + seat),
  toggleDebug: () => setDebug(!state.debug),
  toggleUI: () => setUI(!state.ui),
  toggleMute: () => setMuted(!state.muted),
  fullscreen: () => toggleFullscreen(),
  restart: () => restart(),
  rematch: () => rematch(),
  nextmap: () => nextMap(),
  setup: () => showSetup(),
  escape: () => showSetup()
};

function dispatch(action, value) {
  const fn = actions[action];
  if (typeof fn === "function") fn(value);
}

bindActionDelegation(document.body, actions);

/* ================================================================ */
/* 播放控制                                                          */
/* ================================================================ */

function nearestSpeed(v) {
  let best = SPEEDS[0], d = Infinity;
  for (const s of SPEEDS) {
    const dd = Math.abs(Math.log(s) - Math.log(v));
    if (dd < d) { d = dd; best = s; }
  }
  return best;
}

function setSpeed(v) {
  if (!Number.isFinite(v)) return;
  state.speed = renderer.setSpeed(v);
  hud.setPlayState({ speed: state.speed });
}

function jumpMoment(dir) {
  const tl = state.timeline;
  if (!tl) return;
  const m = tl.nextMoment(null, renderer.index, dir);
  if (m) {
    renderer.pause();
    renderer.seek(m.frame);
  }
}

/** 跳轮：roundNo 为 1 起的轮号；省略时按方向跳到上/下一轮开头 */
function jumpRound(roundNo, dir) {
  const tl = state.timeline;
  if (!tl) return;
  let target = null;
  if (Number.isFinite(roundNo)) {
    target = tl.frameOfRound(roundNo);
  } else {
    const cur = tl.roundAt(renderer.index);
    const i = cur ? tl.roundRanges.indexOf(cur) : -1;
    const next = tl.roundRanges[clamp(i + (dir || 1), 0, tl.roundRanges.length - 1)];
    target = next ? next.start : null;
  }
  if (target !== null && target !== undefined) {
    renderer.pause();
    renderer.seek(target);
  }
}

function restart() {
  const tl = state.timeline;
  if (!tl) return;
  state.resultShown = false;
  renderer.seek(0);
  renderer.play();
}

async function rematch() {
  const run = state.lastRun;
  if (!run) return restart();
  try {
    setStatus("再战：seed " + (run.seed + 1) + " …", "ok");
    await runMatch({ map: run.map, seed: run.seed + 1, bots: run.bots });
  } catch (e) {
    setStatus("再战失败：" + e.message, "error");
  }
}

async function nextMap() {
  const cat = state.catalog;
  const run = state.lastRun;
  if (!cat || !cat.maps || !cat.maps.length || !run) return showSetup();
  const i = cat.maps.findIndex((m) => m.id === run.map);
  const next = cat.maps[(i + 1 + cat.maps.length) % cat.maps.length];
  try {
    setStatus("下一图：" + next.id + " …", "ok");
    await runMatch({ map: next.id, seed: run.seed, bots: run.bots });
  } catch (e) {
    setStatus("载入下一图失败：" + e.message, "error");
  }
}

function setMuted(on) {
  state.muted = !!on;
  if (state.visual && state.visual.audio && state.visual.audio.setMuted) {
    state.visual.audio.setMuted(state.muted);
  }
  hud.setMuted(state.muted);
  try { localStorage.setItem("p01.muted.v2", state.muted ? "1" : "0"); } catch (_) { /* noop */ }
}

function setUI(on) {
  state.ui = !!on;
  document.body.dataset.ui = state.ui ? "1" : "0";
  renderer.markDirty();
}

function setDebug(on) {
  state.debug = !!on;
  renderer.debug = state.debug;
  hud.update(renderer.timeline ? renderer.timeline.frameAt(renderer.index) : null, state.trace, frameInfo());
  renderer.markDirty();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
  }
}

/* ================================================================ */
/* 视觉层对接                                                        */
/* ================================================================ */

let _roots = null;
function hudRoots() {
  if (_roots) return _roots;
  _roots = {
    top: $("hud-top-info"),
    seats: $("hud-seats"),
    feed: $("hud-feed"),
    timeline: $("hud-timeline"),
    banner: $("hud-banner"),
    result: $("hud-result"),
    debug: $("debug-panel"),
    boot: $("boot"),
    controls: $("core-controls"),
    stage: $("stage-frame")
  };
  return _roots;
}

async function initVisual() {
  let v = null;
  if (params.get("visual") !== "0") {
    try {
      await import("./visual/index.js");
      // 视觉层通常在模块求值时同步调用 P01.provideVisual(api)
      v = P01.visual || await Promise.race([
        P01.visualReady,
        new Promise((res) => setTimeout(() => res(null), 2000))
      ]);
    } catch (e) {
      v = null; // 视觉层尚未交付：走兜底
    }
  }
  if (v && typeof v.registerLayers === "function") {
    try {
      await v.init({ canvas, hudRoots: hudRoots(), palette: P01.palette });
      await v.registerLayers(renderer);
      state.realVisual = true;
    } catch (e) {
      console.error("[P01] 视觉层初始化失败，切换兜底渲染", e);
      state.realVisual = false;
    }
  }
  if (!state.realVisual) {
    const fb = createFallbackVisual();
    fb.registerLayers(renderer);
    v = fb;
  }
  state.visual = v;
  hud.fallback = !state.realVisual || typeof v.renderHUD !== "function";
}

/* ================================================================ */
/* 帧回调                                                            */
/* ================================================================ */

function frameInfo() {
  const frame = state.timeline ? state.timeline.frameAt(renderer.index) : null;
  const cam = renderer.view ? renderer.view.camera : null;
  return {
    playing: renderer.playing,
    speed: state.speed,
    fps: renderer.fps,
    camera: camera.modeString,
    camRect: cam,
    debug: state.debug,
    frame
  };
}

let lastBannerKey = "";
let resultAnnounced = false;
const vErr = { onFrame: 0, renderHUD: 0 };

function onFrame(frame, prev, view, mode) {
  if (!frame) return;
  const info = frameInfo();
  hud.update(frame, state.trace, info);

  const v = state.visual;
  if (v) {
    if (typeof v.onFrame === "function" && vErr.onFrame < 3) {
      try { v.onFrame(frame, prev, view, mode); } catch (e) { vErr.onFrame++; console.error("[P01] visual.onFrame 异常", e); }
    }
    // HUD 由视觉层渲染；核心只保留控件条/时间轴/终局按钮等功能件
    if (state.realVisual && typeof v.renderHUD === "function" && vErr.renderHUD < 3) {
      try {
        v.renderHUD(frame, state.trace, {
          playing: renderer.playing,
          speed: state.speed,
          frame: frame.index,
          total: state.timeline ? state.timeline.totalFrames : 0,
          round: frame.round,
          rounds: state.timeline ? state.timeline.roundRanges.length : 0,
          camera: camera.modeString,
          debug: state.debug,
          muted: state.muted,
          seeking: mode === "seek",
          roots: hudRoots()
        });
      } catch (e) {
        vErr.renderHUD++;
        console.error("[P01] visual.renderHUD 异常", e);
      }
    }
    // 实时播放时播放音效；seek 不补音，避免拖动时间轴时爆音
    if (mode === "play" && v.audio && typeof v.audio.play === "function" && frame.audio) {
      for (const cue of frame.audio) {
        try { v.audio.play(cue); } catch (e) { /* 音频失败不影响画面 */ }
      }
    }
    // 横幅切换（实时播放时通知视觉层；seek 时由 renderHUD 用 frame.banner 稳态渲染）
    const key = frame.banner ? frame.banner.text + "|" + frame.banner.sub : "";
    if (key !== lastBannerKey) {
      lastBannerKey = key;
      if (frame.banner && mode !== "seek" && typeof v.showBanner === "function") {
        try { v.showBanner(frame.banner.text, frame.banner.sub, 1200); } catch (e) { /* noop */ }
      }
    }
    if (frame.over && frame.phase === "final" && !resultAnnounced) {
      resultAnnounced = true;
      if (typeof v.showResult === "function") {
        try { v.showResult(state.trace.result || {}, state.trace); } catch (e) { /* noop */ }
      }
    }
  }
}

renderer.onFrame(onFrame);
renderer.onPlayChange(({ playing, speed }) => {
  hud.setPlayState({ playing, speed });
});
renderer.onEnd(() => {
  if (!state.timeline) return;
  const f = state.timeline.frames[state.timeline.totalFrames - 1];
  if (f && f.over) hud.showResult(state.trace.result || {}, state.trace);
});

/* ================================================================ */
/* trace 载入                                                        */
/* ================================================================ */

function setStatus(text, kind) {
  const node = $("boot-status");
  if (!node) return;
  node.textContent = text || "";
  node.className = "boot-status" + (kind ? " is-" + kind : "");
}

async function openTrace(url, opts = {}) {
  const trace = await loadTrace(url);
  const t0 = performance.now();
  const timeline = createTimeline(trace);
  const bakeMs = Math.round(performance.now() - t0);

  state.trace = trace;
  state.timeline = timeline;
  state.meta = trace.meta;
  state.resultShown = false;
  resultAnnounced = false;
  lastBannerKey = "";

  hud.setTimeline(timeline);
  hud.setCameraLabel(camera.modeString);
  camera.setMode(params.get("camera") || state.cameraDefault || "auto", timeline);
  hud.setCameraLabel(camera.modeString);

  renderer.setTimeline(timeline);
  document.body.dataset.screen = "stage";

  const startFrame = opts.frame !== undefined && opts.frame !== null ? opts.frame : 0;
  renderer.seek(startFrame);
  if (opts.autoplay) renderer.play(); else renderer.pause();

  document.title = `P01 · ${trace.meta.map} · s${trace.meta.seed}`;
  setStatus(
    `已载入 ${url} · ${timeline.totalFrames} 帧 (${(timeline.totalFrames / 60).toFixed(0)}s) · 烘焙 ${bakeMs}ms`,
    "ok"
  );
  console.info(
    `[P01] trace ${trace.meta.map} s${trace.meta.seed}: ${timeline.totalFrames} frames, ` +
    `${timeline.stats.shots} shots, ${timeline.stats.booms} booms, bake ${bakeMs}ms`
  );
  return trace.meta;
}

async function runMatch({ map, seed, bots }) {
  state.lastRun = { map, seed, bots };
  setStatus(`生成对局：${map} · seed ${seed} …`);
  let data;
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ map, seed, bots })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} · /api/run`);
    data = await res.json();
  } catch (e) {
    throw new Error(`无法调用 /api/run（${e.message}）。服务未就绪时可先点样例对局。`);
  }
  const url = data.trace_url || (data.id ? "/api/trace?id=" + encodeURIComponent(data.id) : null);
  if (!url) throw new Error("/api/run 未返回 trace_url");
  await openTrace(url, { autoplay: true });
  return data;
}

/* ================================================================ */
/* Setup 页                                                          */
/* ================================================================ */

function sampleUrl(id) {
  return SAMPLE_BASE + id + ".json";
}

/** 统一成 { id, file, title, sub } */
function normalizeSamples(list) {
  return (list || []).map((s) => {
    const meta = s.meta || {};
    const map = meta.map || s.map || "";
    const seed = meta.seed !== undefined ? meta.seed : s.seed;
    const title = s.label || s.id;
    const sub = [map, seed !== undefined && seed !== null ? "s" + seed : ""].filter(Boolean).join(" · ")
      || s.sub || "";
    return { id: s.id, file: s.file || sampleUrl(s.id), title, sub };
  });
}

async function loadCatalog() {
  let cat = null;
  try {
    cat = await fetchJSONTimeout("/api/catalog", 2500);
  } catch (e) {
    cat = null;
  }
  if (cat && cat.maps && cat.maps.length) {
    state.catalog = cat;
    state.samples = normalizeSamples(cat.traces);
    return { catalog: cat, online: true };
  }

  // 离线兜底 1：样例清单（traces/samples/index.json）
  let idx = null;
  try {
    idx = await fetchJSONTimeout(SAMPLE_ABS + "index.json", 1500);
  } catch (e) {
    idx = null;
  }
  let samples;
  if (idx && Array.isArray(idx.samples) && idx.samples.length) {
    samples = normalizeSamples(idx.samples);
  } else {
    samples = normalizeSamples(SAMPLE_FALLBACK.map((s) => ({
      id: s.id, file: sampleUrl(s.id), label: s.label, sub: s.sub, meta: null
    })));
  }

  state.samples = samples;
  state.catalog = {
    maps: [],
    bots: DEFAULT_BOTS.map((b) => ({ id: b, label: b.toUpperCase(), ready: true })),
    traces: samples
  };
  return { catalog: state.catalog, online: false };
}

function fillSelect(node, options, value) {
  if (!node) return;
  clearNode(node);
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.disabled) opt.disabled = true;
    node.appendChild(opt);
  }
  if (value !== undefined) node.value = value;
}

async function initSetup() {
  const { catalog, online } = await loadCatalog();
  const maps = (catalog.maps && catalog.maps.length ? catalog.maps : [{ id: "public4-01", label: "public4-01" }])
    .map((m) => ({ value: m.id, label: `${m.id}${m.type ? " · " + m.type : ""}` }));
  fillSelect($("boot-map"), maps, maps[0].value);
  if (maps.length <= 1) $("boot-map").disabled = true;

  const bots = (catalog.bots || []).map((b) => ({
    value: b.id,
    label: `${(b.label || b.id).toUpperCase()}${b.ready === false ? " (未就绪)" : ""}${b.kind === "submission" ? " · 提交" : ""}`
  }));
  if (!bots.length) DEFAULT_BOTS.forEach((b) => bots.push({ value: b, label: b.toUpperCase() }));
  for (let s = 0; s < 4; s++) {
    fillSelect($("boot-bot-" + s), bots, (DEFAULT_BOTS[s] && bots.some((b) => b.value === DEFAULT_BOTS[s]))
      ? DEFAULT_BOTS[s] : bots[Math.min(s, bots.length - 1)].value);
  }

  buildSampleList(state.samples || [], online);

  if (online && catalog.game && catalog.game.ready === false) {
    setStatus("仅回放模式：未配置 P01 题目包（启动时加 --game <目录> 或设置 P01_GAME）。可播放样例，不能跑新对局。");
  } else if (online) {
    setStatus("服务已就绪：" + (catalog.maps || []).length + " 张地图 · " + (catalog.bots || []).length + " 个 bot", "ok");
  } else {
    setStatus("本地 API 未就绪（server/app.py 尚未启动）。当前可直接播放内置样例；地图/bot 选择在服务就绪后自动启用。");
  }
}

function buildSampleList(samples, online) {
  const root = $("boot-sample-list");
  if (!root) return;
  clearNode(root);

  const list = samples && samples.length ? samples : normalizeSamples(SAMPLE_FALLBACK.map((s) => ({
    id: s.id, file: sampleUrl(s.id), label: s.label, sub: s.sub, meta: null
  })));

  for (const s of list) {
    const b = el("button", "sample-btn");
    b.type = "button";
    b.appendChild(el("span", "", s.title));
    b.appendChild(el("small", "", s.sub || s.id));
    b.title = `${s.id}${online ? "" : " · 本地样例"}`;
    b.addEventListener("click", async () => {
      b.classList.add("is-loading");
      setStatus("载入样例 " + s.id + " …");
      try {
        await openTrace(s.file, { autoplay: true });
      } catch (e) {
        setStatus("样例载入失败：" + e.message, "error");
        b.classList.remove("is-loading");
      }
    });
    root.appendChild(b);
  }
}

function bindSetup() {
  $("boot-start").addEventListener("click", async () => {
    const map = $("boot-map").value;
    const seed = parseInt($("boot-seed").value, 10) || 1;
    const bots = [0, 1, 2, 3].map((s) => $("boot-bot-" + s).value);
    const btn = $("boot-start");
    btn.disabled = true;
    try {
      await runMatch({ map, seed, bots });
    } catch (e) {
      setStatus("生成失败：" + e.message, "error");
    } finally {
      btn.disabled = false;
    }
  });

  $("boot-random").addEventListener("click", () => {
    $("boot-seed").value = String(Math.floor(Math.random() * 9999) + 1);
    const cat = state.catalog;
    if (cat && cat.bots && cat.bots.length) {
      for (let s = 0; s < 4; s++) {
        const pick = cat.bots[Math.floor(Math.random() * cat.bots.length)];
        $("boot-bot-" + s).value = pick.id;
      }
    }
    if (cat && cat.maps && cat.maps.length) {
      $("boot-map").value = cat.maps[Math.floor(Math.random() * cat.maps.length)].id;
    }
  });

  $("boot-help").addEventListener("click", () => {
    const k = $("boot-keys");
    k.hidden = !k.hidden;
  });

  $("boot-seed").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("boot-start").click();
  });
}

function showSetup() {
  renderer.pause();
  document.body.dataset.screen = "boot";
}

/* ================================================================ */
/* 对外 API                                                          */
/* ================================================================ */

let resolveReady;
const ready = new Promise((res) => { resolveReady = res; });

const api = {
  ready,
  loadTrace: async (url) => openTrace(url, { frame: 0, autoplay: false }),
  getMeta: () => state.meta,
  getFrameCount: () => (state.timeline ? state.timeline.totalFrames : 0),
  seekFrame: (n) => { renderer.pause(); renderer.seek(n); },
  renderFrame: (n) => { renderer.pause(); renderer.seek(n); },
  play: () => renderer.play(),
  pause: () => renderer.pause(),
  setSpeed: (x) => setSpeed(Number(x)),
  setCamera: (mode) => actions.setCamera(mode),
  setUI: (on) => setUI(!!on),
  setDebug: (on) => setDebug(!!on),
  getFrameInfo: () => {
    const f = state.timeline ? state.timeline.frameAt(renderer.index) : null;
    const cam = renderer.view ? renderer.view.camera : null;
    return {
      frame: renderer.index,
      total: state.timeline ? state.timeline.totalFrames : 0,
      round: f ? f.round : 0,
      wind: f ? f.wind : 0,
      water: f ? f.water : 0,
      phase: f ? f.phase : "idle",
      tick: f ? f.tick : 0,
      stateHash: f ? f.stateHash : null,
      camera: camera.modeString,
      playing: renderer.playing,
      speed: state.speed,
      camRect: cam ? { x: cam.x, y: cam.y, w: cam.w, h: cam.h } : null
    };
  },
  getKeyMoments: () => (state.timeline ? state.timeline.keyMoments.map((m) => ({
    frame: m.frame, round: m.round, tick: m.tick, type: m.type, label: m.label, seat: m.seat
  })) : []),
  capture: () => renderer.capture(),
  // 便于调试的额外入口
  get timeline() { return state.timeline; },
  get trace() { return state.trace; },
  get renderer() { return renderer; },
  get camera() { return camera; },
  getFrame: (i) => (state.timeline ? state.timeline.frameAt(i === undefined ? renderer.index : i) : null),
  getTerrainSnapshot: (i) => (state.timeline ? state.timeline.getTerrainSnapshot(i) : null),
  setMuted: (on) => setMuted(on)
};

window.__P01V__ = api;
P01.provideCore(api);

/* ================================================================ */
/* 启动                                                              */
/* ================================================================ */

async function boot() {
  try {
    hud.init();
    hud.setPlayState({ playing: false, speed: 1 });
    for (const layer of createDebugLayers()) renderer.register(layer);

    const storedMuted = (() => {
      try { return localStorage.getItem("p01.muted.v2"); } catch (_) { return null; }
    })();
    if (storedMuted !== null && !params.has("muted")) state.muted = storedMuted === "1";
    if (params.get("muted") === "1") state.muted = true;

    if (params.has("speed")) setSpeed(parseFloat(params.get("speed")) || 1);
    if (params.get("camera")) state.cameraDefault = params.get("camera");
    if (params.get("bg")) document.documentElement.style.setProperty("--bg", params.get("bg"));
    setUI(state.ui);
    setDebug(state.debug);

    // 视觉层与 setup 数据并行准备，缩短首屏等待
    bindSetup();
    const setupReady = initSetup();
    await initVisual();
    if (state.visual && state.visual.audio && state.visual.audio.setMuted) {
      state.visual.audio.setMuted(state.muted);
    }
    hud.setMuted(state.muted);
    renderer.start();

    bindInput({
      renderer, camera, actions, canvas,
      getTimeline: () => state.timeline
    });

    await setupReady;

    // URL 直接载入
    const traceUrl = params.get("trace");
    if (traceUrl) {
      const frame = state.initialFrame;
      const autoplay = params.get("autoplay") === "1" || (frame === null && params.get("autoplay") !== "0");
      try {
        await openTrace(traceUrl, { frame: frame === null ? 0 : frame, autoplay });
        if (frame !== null) renderer.pause();
      } catch (e) {
        setStatus("URL 指定的 trace 载入失败：" + e.message, "error");
      }
    }

    resolveReady();
    document.body.dataset.ready = "1";
  } catch (e) {
    console.error("[P01] 启动失败", e);
    setStatus("启动失败：" + (e && e.message ? e.message : e), "error");
    resolveReady();
  }
}

boot();
