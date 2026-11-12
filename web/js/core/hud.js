/* P01 core · HUD 结构与降级皮肤
 *
 * 分工：
 *  · 核心永远拥有「播放控件条」「可拖拽时间轴」「终局按钮」「调试面板」——它们是功能，不是皮肤。
 *  · 数据面板（顶栏读数 / 四席卡 / 事件流 / 横幅 / 终局统计）默认由视觉层 renderHUD 填充；
 *    视觉层缺席时本文件的 fallback 渲染兜底，保证不白屏。
 */
import { clamp, el, clearNode, fmtClock, pad2, signed } from "./util.js";

const P01 = window.P01;
const SPEEDS = [0.25, 0.5, 1, 2, 4];

export class CoreHUD {
  constructor({ onAction, canvas }) {
    this.onAction = onAction;
    this.canvas = canvas;
    this.dom = {
      controls: document.getElementById("core-controls"),
      topInfo: document.getElementById("hud-top-info"),
      seats: document.getElementById("hud-seats"),
      feed: document.getElementById("hud-feed"),
      banner: document.getElementById("hud-banner"),
      result: document.getElementById("hud-result"),
      resultBar: document.getElementById("core-result-bar"),
      timeline: document.getElementById("hud-timeline"),
      debug: document.getElementById("debug-panel"),
      boot: document.getElementById("boot")
    };

    this.timeline = null;
    this.fallback = false;
    this.playing = false;
    this.speed = 1;
    this.cameraMode = "auto";
    this.muted = false;

    this._seatSig = "";
    this._feedFrame = -1;
    this._bannerKey = "";
    this._resultShown = false;
    this._legendSig = "";
    this._playBtn = null;
    this._camBtn = null;
    this._speedBtns = [];
    this._debugLayerRefs = null;
  }

  init() {
    this._buildControls();
    this._buildTimelineSkeleton();
    this._bindTimeline();
    this.setDebug(false);
  }

  setDebug(on) {
    this.showDebug = !!on;
    if (this.dom.debug && !on) this.dom.debug.hidden = true;
  }

  /* ============================ 控件条 ============================ */

  _buildControls() {
    const root = this.dom.controls;
    if (!root) return;
    clearNode(root);

    const brand = el("div", "p01-brand");
    brand.innerHTML = "<b>P01</b> // BALLISTIC";
    root.appendChild(brand);

    const mk = (label, action, value, title, cls) => {
      const b = el("button", cls || "", label);
      b.type = "button";
      b.setAttribute("data-p01-action", action);
      if (value !== undefined && value !== null) b.setAttribute("data-value", String(value));
      if (title) b.title = title;
      root.appendChild(b);
      return b;
    };

    this._playBtn = mk("PLAY", "toggle", null, "播放 / 暂停 (Space)", "ctl-play");
    mk("|<", "step", -1, "上一帧 (←，Shift 10 帧)");
    mk(">|", "step", 1, "下一帧 (→，Shift 10 帧)");

    root.appendChild(el("div", "ctl-sep"));

    const speeds = el("div", "ctl-group ctl-speeds");
    this._speedBtns = SPEEDS.map((s) => {
      const b = el("button", "", s + "x");
      b.type = "button";
      b.setAttribute("data-p01-action", "setSpeed");
      b.setAttribute("data-value", String(s));
      b.title = "速度 " + s + "x ([ / ])";
      speeds.appendChild(b);
      return b;
    });
    root.appendChild(speeds);

    root.appendChild(el("div", "ctl-sep"));
    mk("<< KEY", "moment", -1, "上一关键事件 (,)");
    mk("KEY >>", "moment", 1, "下一关键事件 (.)");
    root.appendChild(el("div", "ctl-sep"));

    this._camBtn = mk("CAM AUTO", "cycleCamera", null, "相机：全图 / 跟随 / 手动 (C)");
    mk("DBG", "toggleDebug", null, "调试叠加 (D)", "ctl-debug ctl-hide-sm");
    mk("SND ON", "toggleMute", null, "音效开关 (M)", "ctl-mute ctl-hide-sm");
    mk("FS", "fullscreen", null, "全屏 (F)", "ctl-fs ctl-hide-sm");
    mk("RESTART", "restart", null, "重开 (R)", "ctl-restart");
    mk("SETUP", "setup", null, "返回设置 (Esc)", "ctl-setup");
  }

  setPlayState({ playing, speed }) {
    if (typeof playing === "boolean") this.playing = playing;
    if (Number.isFinite(speed)) this.speed = speed;
    if (this._playBtn) this._playBtn.textContent = this.playing ? "PAUSE" : "PLAY";
    for (const b of this._speedBtns) {
      const on = Math.abs(parseFloat(b.getAttribute("data-value")) - this.speed) < 1e-6;
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  setCameraLabel(mode) {
    this.cameraMode = mode;
    if (this._camBtn) this._camBtn.textContent = "CAM " + String(mode).replace("follow:", "P");
  }

  setMuted (on) {
    this.muted = !!on;
    const btn = this.dom.controls && this.dom.controls.querySelector('[data-p01-action="toggleMute"]');
    if (btn) {
      btn.setAttribute("aria-pressed", this.muted ? "true" : "false");
      btn.textContent = this.muted ? "MUTED" : "SND ON";
      btn.title = this.muted ? "已静音 · 点击或按 M 开启音效" : "音效已开 · 点击或按 M 静音";
    }
  }

  /* ============================ 时间轴 ============================ */

  _buildTimelineSkeleton() {
    const root = this.dom.timeline;
    if (!root) return;
    clearNode(root);

    const wrap = el("div", "tl");
    const track = el("div", "tl-track");
    track.tabIndex = 0;
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", "播放时间轴");

    this.tlRounds = el("div", "tl-rounds");
    this.tlMarks = el("div", "tl-marks");
    this.tlHead = el("div", "tl-head");
    track.appendChild(this.tlRounds);
    track.appendChild(this.tlMarks);
    track.appendChild(this.tlHead);

    const legend = el("div", "tl-legend");
    this.lgRound = el("span", "tl-chip", "R --/--");
    this.lgFrame = el("span", "tl-chip", "F 0 / 0");
    this.lgTime = el("span", "tl-chip", "0:00");
    this.lgCam = el("span", "tl-chip", "AUTO");
    legend.appendChild(this.lgRound);
    legend.appendChild(this.lgFrame);
    legend.appendChild(this.lgTime);
    legend.appendChild(this.lgCam);

    wrap.appendChild(track);
    wrap.appendChild(legend);
    root.appendChild(wrap);

    this.tlTrack = track;
  }

  setTimeline(tl) {
    this.timeline = tl;
    this._resultShown = false;
    if (this.dom.result) { this.dom.result.hidden = true; clearNode(this.dom.result); }
    if (this.dom.resultBar) { this.dom.resultBar.hidden = true; clearNode(this.dom.resultBar); }
    this._feedFrame = -1;
    this._bannerKey = "";
    this._seatSig = "";
    this._legendSig = "";
    this._buildMarks();
  }

  _buildMarks() {
    const tl = this.timeline;
    if (!tl || !this.tlRounds) return;
    clearNode(this.tlRounds);
    clearNode(this.tlMarks);

    const total = Math.max(1, tl.totalFrames - 1);

    for (const r of tl.roundRanges) {
      const cell = el("div", "tl-round-cell");
      cell.style.flexGrow = String(Math.max(1, r.end - r.start + 1));
      cell.dataset.round = String(r.round);
      cell.title = `ROUND ${pad2(r.round)} · 风 ${signed(r.wind)} · 水位 ${r.water}`;
      cell.addEventListener("pointerdown", (e) => {
        // 点轮次 = 跳到该轮开头（不要和轨道拖拽抢）
        e.stopPropagation();
        this.onAction("seekRound", r.round);
      });
      this.tlRounds.appendChild(cell);
    }

    const types = { fire: "t-fire", explode: "t-boom", kill: "t-kill", water: "t-water", end: "t-end" };
    const limit = 420;
    let n = 0;
    for (const m of tl.keyMoments) {
      const cls = types[m.type];
      if (!cls || n > limit) continue;
      const s = el("span", "tl-mark " + cls);
      s.style.left = (m.frame / total) * 100 + "%";
      if (P01.seats[m.seat]) s.style.setProperty("--mark-color", P01.seats[m.seat].color);
      s.title = `R${m.round} · ${m.label || m.type}`;
      this.tlMarks.appendChild(s);
      n++;
    }
    this._markEls = Array.from(this.tlMarks.children);
  }

  _bindTimeline() {
    const track = this.tlTrack;
    if (!track) return;
    let dragging = false;

    const seekFrom = (clientX) => {
      const r = track.getBoundingClientRect();
      const ratio = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
      const tl = this.timeline;
      if (!tl) return;
      this.onAction("seekFrame", Math.round(ratio * (tl.totalFrames - 1)));
    };

    track.addEventListener("pointerdown", (e) => {
      if (!this.timeline) return;
      dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件无 pointerId */ }
      seekFrom(e.clientX);
    });
    track.addEventListener("pointermove", (e) => {
      if (dragging) seekFrom(e.clientX);
    });
    const stop = () => { dragging = false; };
    track.addEventListener("pointerup", stop);
    track.addEventListener("pointercancel", stop);
    window.addEventListener("pointerup", stop);
  }

  /* ============================ 帧更新 ============================ */

  update(frame, trace, info) {
    if (!frame) return;
    this._updateTimeline(frame, info);
    this._updateDebug(frame, info);
    if (this.fallback) this._renderFallback(frame, trace, info);
    if (frame.over && frame.phase === "final") this.showResult(trace && trace.result ? trace.result : {}, trace);
    else if (this._resultShown) this.hideResult();
  }

  hideResult() {
    this._resultShown = false;
    if (this.dom.result) { this.dom.result.hidden = true; clearNode(this.dom.result); }
    if (this.dom.resultBar) { this.dom.resultBar.hidden = true; clearNode(this.dom.resultBar); }
    this._bannerKey = "";
  }

  _updateTimeline(frame, info) {
    const tl = this.timeline;
    if (!tl || !this.tlHead) return;
    const total = Math.max(1, tl.totalFrames - 1);
    this.tlHead.style.left = (frame.index / total) * 100 + "%";

    const rr = tl.roundRanges;
    let roundIdx = -1;
    for (let i = 0; i < rr.length; i++) {
      if (frame.index >= rr[i].start && frame.index <= rr[i].end) { roundIdx = i; break; }
    }
    if (this._curRoundIdx !== roundIdx) {
      this._curRoundIdx = roundIdx;
      const cells = this.tlRounds.children;
      for (let i = 0; i < cells.length; i++) {
        cells[i].classList.toggle("is-current", i === roundIdx);
      }
    }

    const sig = `${frame.round}|${rr.length}|${frame.index}|${info.speed}|${info.camera}`;
    if (sig !== this._legendSig) {
      this._legendSig = sig;
      this.lgRound.textContent = `R ${frame.round > 0 ? pad2(frame.round) : "--"}/${pad2(rr.length)}`;
      this.lgFrame.textContent = `F ${frame.index} / ${tl.totalFrames - 1}`;
      this.lgTime.textContent = fmtClock(frame.index);
      this.lgCam.textContent = info.camera === "auto" ? "AUTO" : String(info.camera).toUpperCase();
    }
  }

  _updateDebug(frame, info) {
    const panel = this.dom.debug;
    if (!panel) return;
    if (!info.debug) { panel.hidden = true; return; }
    panel.hidden = false;
    const cam = info.camRect;
    const lines = [
      `FRAME  ${frame.index} / ${this.timeline ? this.timeline.totalFrames - 1 : 0}   FPS ${info.fps || 0}`,
      `ROUND  ${frame.round}   TICK ${frame.tick}   PHASE ${frame.phase}`,
      `WIND   ${signed(frame.wind)}   WATER ${Math.round(frame.water)}`,
      `HASH   ${frame.stateHash || "-"}`,
      cam ? `CAM    ${cam.x.toFixed(1)},${cam.y.toFixed(1)}  ${cam.w.toFixed(1)}×${cam.h.toFixed(1)}  ${info.camera}` : `CAM    ${info.camera}`,
      `PROJ   ${frame.projs.length}   FX ${frame.fxLive.length}`
    ];
    panel.textContent = lines.join("\n");
  }

  /* ---------------- fallback：数据面板 ---------------- */

  _renderFallback(frame, trace, info) {
    this._renderTopInfo(frame, trace, info);
    this._renderSeats(frame, trace);
    this._renderFeed(frame);
    this._renderBanner(frame);
  }

  _renderTopInfo(frame, trace, info) {
    const root = this.dom.topInfo;
    if (!root || !trace) return;
    const key = `${frame.round}|${frame.wind}|${Math.round(frame.water)}|${frame.phase}|${info.speed}|${info.camera}`;
    if (root.dataset.key === key) return;
    root.dataset.key = key;

    const meta = trace.meta || {};
    clearNode(root);
    const add = (label, value, color) => {
      const d = el("span", "top-chip is-" + label.toLowerCase());
      d.innerHTML = `<span class="top-k">${label}</span><b class="top-v"${color ? ` style="color:${color}"` : ""}>${value}</b>`;
      root.appendChild(d);
    };
    add("MAP", String(meta.map || "-").toUpperCase());
    add("SEED", meta.seed);
    add("ROUND", pad2(frame.round) + "/" + pad2((trace.rounds || []).length));
    add("WIND", signed(frame.wind), frame.wind < 0 ? "#8be9fd" : frame.wind > 0 ? "#ffb340" : "#93aec2");
    add("WATER", Math.round(frame.water));
    add("SPEED", info.speed + "x");
    add("CAM", String(info.camera).toUpperCase());
  }

  _renderSeats(frame, trace) {
    const root = this.dom.seats;
    if (!root || !trace) return;

    const sig = frame.worms.map((w) => `${w.id}:${Math.round(w.x)},${Math.round(w.y)},${w.hp},${w.alive ? 1 : 0},${w.grenades},${w.drills}`).join("|")
      + "#" + frame.round + "#" + (frame.aim ? frame.aim.map((a) => a.seat).join(",") : "");
    if (sig === this._seatSig) return;
    this._seatSig = sig;

    const meta = trace.meta || {};
    const labels = meta.bot_labels || meta.bots || [];
    const seats = meta.seats || 4;

    if (root.children.length !== seats) {
      clearNode(root);
      for (let s = 0; s < seats; s++) {
        const card = el("div", "seat-card");
        card.dataset.seat = String(s);
        const seat = P01.seats[s] || { color: "#888" };
        card.style.setProperty("--seat-color", seat.color);

        const head = el("div", "seat-head");
        head.appendChild(el("span", "seat-chip"));
        head.appendChild(el("span", "seat-name", labels[s] || "SEAT " + (s + 1)));
        const act = el("span", "seat-act", "ACT");
        act.hidden = true;
        head.appendChild(act);
        card.appendChild(head);

        const worms = el("div", "seat-worms");
        for (let k = 0; k < 3; k++) {
          const row = el("div", "seat-worm");
          row.dataset.worm = String(s * 3 + k);
          row.appendChild(el("span", "wno", "#" + (s * 3 + k)));
          const bar = el("span", "bar");
          bar.appendChild(el("i"));
          row.appendChild(bar);
          row.appendChild(el("span", "ammo", ""));
          worms.appendChild(row);
        }
        card.appendChild(worms);

        const foot = el("div", "seat-foot");
        foot.innerHTML = `<span>HP <b class="f-hp">0</b></span><span>DMG <b class="f-dmg">0</b></span><span>ALIVE <b class="f-alive">3</b></span>`;
        card.appendChild(foot);
        root.appendChild(card);
      }
    }

    const cards = root.children;
    for (let s = 0; s < cards.length; s++) {
      const card = cards[s];
      const mine = frame.worms.filter((w) => w.seat === s);
      const alive = mine.filter((w) => w.alive);
      const isAct = frame.aim ? frame.aim.some((a) => a.seat === s) : false;
      card.classList.toggle("is-act", isAct);
      card.classList.toggle("is-dead", alive.length === 0);

      const act = card.querySelector(".seat-act");
      if (act) act.hidden = !isAct;

      for (let k = 0; k < 3; k++) {
        const w = mine[k];
        const row = card.querySelector(`.seat-worm[data-worm="${s * 3 + k}"]`);
        if (!row || !w) continue;
        row.classList.toggle("is-dead", !w.alive);
        const bar = row.querySelector(".bar > i");
        if (bar) bar.style.width = clamp(w.hp, 0, 100) + "%";
        const ammo = row.querySelector(".ammo");
        if (ammo) ammo.textContent = `G${w.grenades} D${w.drills}`;
      }

      const hp = mine.reduce((a, w) => a + Math.max(0, w.hp), 0);
      const dealt = (frame.dealt && frame.dealt[s]) || 0;
      const fhp = card.querySelector(".f-hp");
      const fdmg = card.querySelector(".f-dmg");
      const falive = card.querySelector(".f-alive");
      if (fhp) fhp.textContent = hp;
      if (fdmg) fdmg.textContent = dealt;
      if (falive) falive.textContent = alive.length + "/3";
    }
  }

  _renderFeed(frame) {
    const root = this.dom.feed;
    const tl = this.timeline;
    if (!root || !tl) return;
    const entries = tl.getFeed(frame.index, 6);
    const newest = entries.length ? entries[entries.length - 1].frame : -1;
    if (newest === this._feedFrame) return;
    this._feedFrame = newest;

    clearNode(root);
    for (const e of entries) {
      const row = el("div", "feed-row" + (e.kind === "boom" || e.kind === "death" ? " is-big" : ""));
      const color = e.seat >= 0 && P01.seats[e.seat] ? P01.seats[e.seat].color : "#93aec2";
      row.style.setProperty("--feed-color", color);
      row.appendChild(el("span", "fi", e.kind === "boom" ? "*" : e.kind === "water" ? "~" : e.kind === "death" ? "x" : "·"));
      row.appendChild(el("span", "ft", e.text));
      root.appendChild(row);
    }
  }

  _renderBanner(frame) {
    const root = this.dom.banner;
    if (!root) return;
    const b = frame.banner;
    const key = b ? `${b.text}|${b.sub}|${b.tone}` : "";
    if (key === this._bannerKey) return;
    this._bannerKey = key;
    // 终局由 #hud-result 接管，避免同屏两个大标题
    if (!b || frame.phase === "final") { clearNode(root); return; }

    clearNode(root);
    const box = el("div", "banner-box");
    const tone = b.tone === "final" ? (P01.seats[frame.winner] ? P01.seats[frame.winner].color : "#ffd166")
      : b.tone === "wind" ? "#8be9fd" : "#ffd166";
    box.style.setProperty("--banner-color", tone);
    box.appendChild(el("div", "banner-main", b.text));
    if (b.sub) box.appendChild(el("div", "banner-sub", b.sub));
    root.appendChild(box);
  }

  showBanner(text, sub) {
    const root = this.dom.banner;
    if (!root) return;
    clearNode(root);
    const box = el("div", "banner-box");
    box.appendChild(el("div", "banner-main", text));
    if (sub) box.appendChild(el("div", "banner-sub", sub));
    root.appendChild(box);
  }

  showResult(result, trace) {
    if (this._resultShown) return;
    this._resultShown = true;
    if (this.dom.banner) { clearNode(this.dom.banner); this._bannerKey = ""; }

    const root = this.dom.result;
    const bar = this.dom.resultBar;
    const winner = Number.isFinite(result.winner) ? result.winner : -1;
    const seat = P01.seats[winner] || null;
    const meta = (trace && trace.meta) || {};
    const labels = meta.bot_labels || meta.bots || [];
    const label = seat ? (labels[winner] || "") : "";
    const reason = result.reason || "HP";
    const rounds = result.rounds || ((trace && trace.rounds) || []).length;
    const dealt = result.dealt || [];
    const totalDealt = dealt.reduce((a, b) => a + b, 0);
    const traceRounds = (trace && trace.rounds) || [];

    if (root) {
      if (!this.fallback) {
        // 有真视觉层：统计面板交给 visual.showResult，核心只保留操作按钮
        root.hidden = true;
        clearNode(root);
      } else {
        clearNode(root);
        root.hidden = false;
        root.style.setProperty("--winner-color", seat ? seat.color : "#ffd166");
        root.appendChild(el("div", "result-title", winner >= 0 ? `WINNER · SEAT ${winner + 1}` : "DRAW"));
        root.appendChild(el("div", "result-sub", `${label}  ·  ${reason}  ·  ${rounds} ROUNDS`));

        const stats = el("div", "result-stats");
        const mk = (k, v) => {
          const d = el("div", "result-stat");
          d.appendChild(el("span", "", k));
          d.appendChild(el("b", "", String(v)));
          stats.appendChild(d);
        };
        mk("TOTAL DMG", totalDealt);
        mk("TOP DAMAGE", dealt.length ? Math.max.apply(null, dealt) : 0);
        mk("KILLS", traceRounds.reduce((a, r) => a + r.events.filter(
          (e) => e.type === "explode" && (e.damage || []).some((d) => d.killed)
        ).length, 0));
        mk("FRAMES", this.timeline ? this.timeline.totalFrames : 0);
        root.appendChild(stats);
      }
    }

    if (bar) {
      clearNode(bar);
      bar.hidden = false;
      const mk = (label2, action, value, cls) => {
        const b = el("button", cls || "", label2);
        b.type = "button";
        b.setAttribute("data-p01-action", action);
        if (value !== undefined) b.setAttribute("data-value", String(value));
        bar.appendChild(b);
      };
      mk("WATCH AGAIN", "restart", null, "btn");
      mk("REMATCH +1", "rematch", null, "btn btn-primary");
      mk("NEXT MAP", "nextmap", null, "btn");
      mk("SETUP", "setup", null, "btn btn-ghost");
    }
  }
}

/* ---------------- 调试叠加图层 ---------------- */

export function createDebugLayers() {
  const world = {
    name: "debug-world",
    z: 880,
    draw(ctx, view) {
      if (!view.debug) return;
      const cam = view.camera;
      const zoom = 96 / cam.w;
      ctx.save();
      ctx.lineWidth = 1 / Math.max(1, zoom);
      ctx.strokeStyle = "rgba(120, 220, 200, 0.18)";
      if (zoom >= 1.15) {
        ctx.beginPath();
        for (let x = 0; x <= 96; x += 1) {
          ctx.moveTo(x * 10, cam.y * 10);
          ctx.lineTo(x * 10, (cam.y + cam.h) * 10);
        }
        for (let y = 0; y <= 54; y += 1) {
          ctx.moveTo(cam.x * 10, y * 10);
          ctx.lineTo((cam.x + cam.w) * 10, y * 10);
        }
        ctx.stroke();
      }
      const f = view.frame;
      ctx.font = "8px monospace";
      ctx.fillStyle = "#9fe8c6";
      for (const w of f.worms) {
        if (!w.alive) continue;
        ctx.fillText(`#${w.id} ${w.x.toFixed(1)},${w.y.toFixed(1)}`, w.x * 10 + 6, w.y * 10 - 3);
      }
      ctx.strokeStyle = "rgba(255, 209, 102, 0.8)";
      for (const p of f.projs) {
        ctx.beginPath();
        ctx.moveTo(p.x * 10, p.y * 10);
        ctx.lineTo((p.x + p.vx * 3) * 10, (p.y + p.vy * 3) * 10);
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  const screen = {
    name: "debug-screen",
    z: 890,
    screen: true,
    draw(ctx, view) {
      if (!view.debug) return;
      const f = view.frame;
      ctx.save();
      ctx.font = "10px monospace";
      ctx.fillStyle = "rgba(159, 232, 198, 0.9)";
      const lines = [
        `F ${f.index}  R ${f.round}  T ${f.tick}  ${view.fps} FPS`,
        `${f.phase}  hash ${f.stateHash || "-"}`
      ];
      lines.forEach((l, i) => ctx.fillText(l, 10, 522 + i * 12));
      ctx.restore();
    }
  };

  return [world, screen];
}
