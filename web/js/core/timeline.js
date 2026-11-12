/* P01 core · 时间轴：trace → 60fps 确定性帧序列
 *
 * 设计要点（对应 docs/SPEC.md §5.1）：
 *  · 帧内容只由 trace 决定；不用 Math.random / Date.now / 真实时间。
 *  · 每帧是"可渲染快照"：worm / proj / 地形版本 / 特效(出生事件) / 音频 cue / 瞄准弧。
 *  · seek 即数组下标访问，任意跳转都能重建完全相同的画面。
 *  · 轮内地形按 explode.destroyed / dig.cell 增量应用，getTerrainSnapshot(i) 可重放。
 */
import {
  GRID_W, GRID_H, FPS, AIR, DIRT, clamp, lerp, easeInOutQuad, pad2, signed, isSolidChar
} from "./util.js";

const P01 = window.P01;

export const TIMING = {
  intro: 42,        // 开场标题
  roundStart: 34,   // 轮首横幅
  quietRound: 12,   // 无移动无开火的空轮
  movePass: 8,      // 每个移动 pass
  settleFall: 6,    // 摔落/落地补充动画
  aim: 45,          // 瞄准虚线展示
  fire: 2,          // 枪口火光
  impactHold: 5,    // 爆炸瞬间停顿
  koHold: 20,       // 击杀慢镜
  roundEnd: 16,     // 轮末结算
  water: 40,        // 涨水
  final: 90         // 终局
};

const FX_LIFE = {
  fire: 10, explode: 48, bounce: 14, dig: 12, hurt: 34, death: 80,
  drown: 62, water: 48, win: 130, ko: 90, settle: 10, fault: 40
};

const DEFAULT_GRAVITY = 655 / 65536;   // 引擎每 tick 的 vy 增量（由 trace 反推）
const WIND_ACCEL = 1 / 8192;           // 引擎每 tick 的 vx 增量 / 每点风
const WEAPON_RADIUS = { 1: 2, 2: 3, 3: 1 };

const num = (v, d) => (Number.isFinite(v) ? v : d);

/* ------------------------------------------------------------------ */
/* 烘焙                                                                */
/* ------------------------------------------------------------------ */

export function bakeFrames(trace, opts = {}) {
  const T = Object.assign({}, TIMING, opts.timing || {});

  // 允许直接喂原始 trace：补齐 meta 中的可选字段
  trace.meta = trace.meta || {};
  if (!Array.isArray(trace.meta.bots)) trace.meta.bots = [];
  if (!Array.isArray(trace.meta.bot_labels)) trace.meta.bot_labels = trace.meta.bots.slice();
  while (trace.meta.bot_labels.length < trace.meta.bots.length) {
    trace.meta.bot_labels.push(String(trace.meta.bots[trace.meta.bot_labels.length] || "").toUpperCase());
  }

  const frames = [];
  const keyMoments = [];
  const feed = [];
  const roundRanges = [];
  const gridOps = [];
  const snapshots = [];
  const shotsAll = [];

  const grid = trace.map.grid.map((row) => row.split(""));

  let gridVersion = 0;
  let worms = trace.initial.worms.map((w) => ({
    id: w.id, seat: w.seat, x: w.x, y: w.y, hp: w.hp,
    grenades: w.grenades, drills: w.drills, alive: !!w.alive
  }));
  let projs = [];
  let wind = num(trace.initial.wind, 0);
  let water = num(trace.initial.water, 0);
  let hpArr = (trace.initial.hp || []).slice();
  let dealt = (trace.initial.dealt || []).slice();
  let stateHash = trace.initial.state_hash || null;
  let over = !!trace.initial.over;
  let winner = num(trace.initial.winner, -1);
  let reason = trace.initial.reason || "RUNNING";

  let roundNo = 0;
  let roundIndex = -1;
  let tick = 0;

  let banner = null;
  let aim = null;
  let cameraHint = null;

  let fxSeq = 0;
  const live = [];
  let pendingFx = [];
  let pendingAudio = [];

  let boomCount = 0;
  let killCount = 0;
  let shotCount = 0;
  let bounceCount = 0;
  let digCells = 0;
  let maxSingleDamage = 0;
  const dmgBySeat = [0, 0, 0, 0];

  const seatLabel = (s) => "P" + s;
  const kindLabel = (k) => (P01.weapons[k] ? P01.weapons[k].label : "?");

  /* ---------------- 帧推送 ---------------- */

  function snapshotTerrain(idx) {
    snapshots.push({ frame: idx, version: gridVersion, rows: grid.map((r) => r.join("")) });
  }

  function addFx(fx) {
    const f = fx;
    f.id = ++fxSeq;
    f.frame = frames.length;
    if (!f.life) f.life = FX_LIFE[f.type] || 24;
    live.push(f);
    pendingFx.push(f);
    return f;
  }

  function addAudio(cue) {
    pendingAudio.push(Object.assign({ frame: frames.length }, cue));
  }

  function seatHpTotals() {
    const out = [0, 0, 0, 0];
    for (const w of worms) {
      if (w.alive && w.hp > 0) out[w.seat ?? Math.floor(w.id / 3)] += w.hp;
    }
    return out;
  }

  function pushFrame(phaseName, extra) {
    const idx = frames.length;
    for (let i = live.length - 1; i >= 0; i--) {
      if (idx >= live[i].frame + live[i].life) live.splice(i, 1);
    }
    if (idx % 240 === 0) snapshotTerrain(idx);

    const frame = {
      index: idx,
      t: idx / FPS,
      phase: phaseName,
      round: roundNo,
      roundIndex,
      tick,
      wind,
      water,
      gridVersion,
      worms,
      projs,
      effects: pendingFx,
      fxLive: live.slice(),
      audio: pendingAudio,
      banner,
      aim,
      cameraHint,
      hp: seatHpTotals(),
      dealt,
      stateHash,
      over,
      winner,
      reason,
      stats: { shots: shotCount, booms: boomCount, kills: killCount, bounces: bounceCount }
    };
    if (extra) Object.assign(frame, extra);
    frames.push(frame);
    pendingFx = [];
    pendingAudio = [];
    return frame;
  }

  /* ---------------- 状态修改 ---------------- */

  const wormById = (id) => worms.find((w) => w.id === id) || null;

  function setWorm(id, patch) {
    const i = worms.findIndex((w) => w.id === id);
    if (i < 0) return null;
    const next = Object.assign({}, worms[i], patch);
    worms = worms.slice();
    worms[i] = next;
    return next;
  }

  function patchWorms(patches) {
    if (!patches.length) return worms;
    const arr = worms.slice();
    for (const p of patches) {
      const i = arr.findIndex((w) => w.id === p.id);
      if (i >= 0) arr[i] = Object.assign({}, arr[i], p);
    }
    return arr;
  }

  function applyTerrain(cells, kind) {
    if (!cells.length) return;
    gridVersion++;
    gridOps.push({ frame: frames.length, cells, kind, version: gridVersion });
  }

  function destroyCells(list, cellsOut) {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      const x = c[0] | 0, y = c[1] | 0;
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) continue;
      if (grid[y][x] === DIRT) { grid[y][x] = AIR; cellsOut.push([x, y]); }
    }
  }

  function addFeed(entry) {
    feed.push(Object.assign({ frame: frames.length }, entry));
  }

  function addMoment(m) {
    keyMoments.push(Object.assign({ frame: frames.length }, m));
  }

  /* ---------------- 瞄准弧 ---------------- */

  function solidAt(x, y) {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return false;
    return isSolidChar(grid[y][x]);
  }

  function simulateArc(spawn, vel, g, ax, waterY, maxSteps) {
    let x = spawn[0], y = spawn[1], vx = vel[0], vy = vel[1];
    const pts = [[x, y]];
    for (let i = 0; i < maxSteps; i++) {
      x += vx; y += vy; vy += g; vx += ax;
      pts.push([x, y]);
      if (x < -2 || x > GRID_W + 2 || y > GRID_H + 2) break;
      if (y >= waterY) break;
      if (y >= 0 && solidAt(Math.floor(x), Math.floor(y))) break;
    }
    return pts;
  }

  function downsample(pts, maxPts = 48) {
    if (pts.length <= maxPts) return pts;
    const out = [];
    const stride = Math.ceil(pts.length / maxPts);
    for (let i = 0; i < pts.length; i += stride) out.push(pts[i]);
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out;
  }

  function computeAims(round, fireEvents) {
    const ticksBySlot = new Map();
    const velsBySlot = new Map();
    for (const e of round.events) {
      if (e.type !== "tick") continue;
      for (const p of e.proj) {
        let arr = ticksBySlot.get(p.slot);
        if (!arr) { arr = []; ticksBySlot.set(p.slot, arr); }
        arr.push([p.x / 65536, p.y / 65536]);
        let vs = velsBySlot.get(p.slot);
        if (!vs) { vs = []; velsBySlot.set(p.slot, vs); }
        vs.push([p.vx / 65536, p.vy / 65536]);
      }
    }
    const explodes = round.events.filter((e) => e.type === "explode");
    const aims = [];

    fireEvents.forEach((f, i) => {
      const spawn = [f.spawn[0] / 65536, f.spawn[1] / 65536];
      const vel = [f.vel[0] / 65536, f.vel[1] / 65536];
      const worm = wormById(f.worm);
      const shot = (round.shots || [])[i] || null;

      // 槽位归属：先按序，再按首点距离兜底
      let slot = null;
      if (ticksBySlot.has(i)) {
        const first = ticksBySlot.get(i)[0];
        if (Math.abs(first[0] - spawn[0]) + Math.abs(first[1] - spawn[1]) < 2.5) slot = i;
      }
      if (slot === null) {
        let best = Infinity;
        for (const [s, pts] of ticksBySlot) {
          const d = Math.abs(pts[0][0] - spawn[0]) + Math.abs(pts[0][1] - spawn[1]);
          if (d < best) { best = d; slot = s; }
        }
        if (best > 3) slot = null;
      }

      let g = DEFAULT_GRAVITY;
      if (slot !== null) {
        const vs = velsBySlot.get(slot) || [];
        if (vs.length >= 3) {
          const a = vs[1][1] - vs[0][1];
          const b = vs[2][1] - vs[1][1];
          g = (a + b) / 2;
        }
      }

      const pts = [spawn];
      if (slot !== null) {
        const tr = ticksBySlot.get(slot) || [];
        for (const p of downsample(tr, 44)) pts.push(p);
      }

      const boom = explodes.find((e) => e.owner_worm === f.worm && e.owner_seat === f.seat);
      const land = boom ? [boom.x + 0.5, boom.y + 0.5] : pts[pts.length - 1];

      const ax = wind * WIND_ACCEL;
      const noWind = slot !== null ? downsample(simulateArc(spawn, vel, g, 0, water, 260), 40) : [];
      const withWind = slot !== null ? downsample(simulateArc(spawn, vel, g, ax, water, 260), 40) : [];

      const radius = WEAPON_RADIUS[f.kind] || 2;
      const a = {
        seat: f.seat,
        worm: f.worm,
        kind: f.kind,
        kindLabel: kindLabel(f.kind),
        angle: num(f.angle, shot ? shot.angle : 0),
        power: num(f.power, shot ? shot.power : 0),
        from: [worm ? worm.x + 0.5 : spawn[0], worm ? worm.y + 0.5 : spawn[1]],
        spawn,
        vel,
        gravity: g,
        pts: downsample(pts, 52),
        withWind,
        noWind,
        land,
        radius,
        slot,
        fault: shot ? shot.fault | 0 : 0,
        buried: !!f.buried
      };
      aims.push(a);
      shotsAll.push(a);
    });

    return aims;
  }

  /* ---------------- 各阶段 ---------------- */

  function emitIntro() {
    const bots = (trace.meta.bot_labels || trace.meta.bots || []).join(" · ");
    banner = {
      text: "P01 BALLISTIC",
      sub: `${trace.meta.map || "map"}  ·  SEED ${trace.meta.seed}  ·  ${bots}`,
      tone: "intro"
    };
    for (let i = 0; i < T.intro; i++) pushFrame("intro");
    banner = null;
  }

  function emitRoundStart(round, windChanged, count) {
    banner = {
      text: `ROUND ${pad2(round.round)}`,
      sub: `${windChanged ? "WIND → " : "WIND "}${signed(round.wind)}  ·  WATER ${round.water}`,
      tone: windChanged ? "wind" : "round"
    };
    addAudio({ cue: "round" });
    addFeed({ round: round.round, seat: -1, kind: "round", text: `ROUND ${pad2(round.round)} · 风 ${signed(round.wind)}` });
    for (let i = 0; i < count; i++) pushFrame("round");
    banner = null;
  }

  function groupMoves(round) {
    const groups = [];
    let cur = null;
    for (const e of round.events) {
      if (e.type === "move") {
        if (!cur || cur.pass !== e.pass) {
          cur = { pass: e.pass, moves: [], settles: [] };
          groups.push(cur);
        }
        cur.moves.push(e);
      } else if (e.type === "settle" && e.phase === "move") {
        if (!cur) { cur = { pass: 0, moves: [], settles: [] }; groups.push(cur); }
        cur.settles.push(e);
      } else if (e.type === "fire" || e.type === "tick" || e.type === "turn_end") {
        break;
      }
    }
    return groups;
  }

  function applySettle(s, phase) {
    const w = wormById(s.worm);
    if (!w) return;
    const fall = Math.max(0, s.fall | 0);
    const n = fall > 0 ? (phase === "move" ? T.settleFall : 1) : 1;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const patch = {
        x: lerp(s.from[0], s.to[0], t),
        y: lerp(s.from[1], s.to[1], t)
      };
      if (i === n) {
        patch.hp = num(s.hp, w.hp);
        if (s.death) patch.alive = false;
      }
      setWorm(s.worm, patch);
      if (i === n) {
        const cur = wormById(s.worm);
        if (s.damage > 0) {
          addFx({ type: "hurt", worm: s.worm, seat: cur.seat, dmg: s.damage, x: cur.x + 0.5, y: cur.y });
          addMoment({ round: roundNo, tick, type: "hurt", seat: cur.seat, label: `${seatLabel(cur.seat)} 摔落 -${s.damage}` });
        }
        if (s.death) {
          addFx({ type: "death", worm: s.worm, seat: cur.seat, x: cur.x + 0.5, y: cur.y, cause: s.death });
          addAudio({ cue: "death", cause: s.death });
          addFeed({ round: roundNo, seat: cur.seat, kind: "death", text: `${seatLabel(cur.seat)} ${s.death === "water" ? "落水" : "阵亡"}` });
          addMoment({ round: roundNo, tick, type: "kill", seat: cur.seat, label: `${seatLabel(cur.seat)} ${s.death === "water" ? "落水" : "阵亡"}` });
        }
      }
      pushFrame(phase === "move" ? "settle" : "impact");
    }
  }

  function emitMoveGroup(g) {
    if (g.moves.length) {
      for (let i = 1; i <= T.movePass; i++) {
        const t = i / T.movePass;
        const e = easeInOutQuad(t);
        const patches = g.moves.map((m) => {
          const p = {
            id: m.worm,
            x: lerp(m.from[0], m.to[0], e),
            y: lerp(m.from[1], m.to[1], e)
          };
          if (m.kind === "J") p.y -= Math.sin(Math.PI * t) * 1.35;
          return p;
        });
        const saved = worms;
        worms = patchWorms(patches);
        pushFrame("move");
        worms = saved;
      }
      for (const m of g.moves) {
        const w = wormById(m.worm);
        if (!w) continue;
        setWorm(m.worm, { x: m.to[0], y: m.to[1] });
        if (m.kind === "J") addAudio({ cue: "jump" });
      }
    }
    for (const s of g.settles) applySettle(s, "move");
  }

  function emitAim(aims) {
    aim = aims;
    cameraHint = { mode: "action" };
    for (let i = 0; i < T.aim; i++) pushFrame("aim");
  }

  function emitFire(aims) {
    for (let i = 0; i < T.fire; i++) {
      if (i === 0) {
        for (const a of aims) {
          addFx({
            type: "fire", seat: a.seat, worm: a.worm, kind: a.kind,
            x: a.from[0], y: a.from[1] - 0.2, angle: a.angle, power: a.power
          });
          addAudio({ cue: "fire", kind: a.kind, seat: a.seat });
          addMoment({
            round: roundNo, tick, type: "fire", seat: a.seat, kind: a.kind,
            label: `${seatLabel(a.seat)} ${a.kindLabel} ${a.angle}° ${a.power}%`
          });
          addFeed({
            round: roundNo, seat: a.seat, kind: "fire",
            text: `${seatLabel(a.seat)} ${a.kindLabel} ${a.angle}° ${a.power}%`
          });
        }
        shotCount += aims.length;
      }
      pushFrame("fire");
    }
    aim = null;
  }

  function applyExplode(e) {
    const cells = [];
    destroyCells(e.destroyed, cells);
    applyTerrain(cells, "boom");

    const killed = [];
    let maxDmg = 0;
    for (const d of e.damage || []) {
      const w = wormById(d.worm);
      if (!w) continue;
      setWorm(d.worm, { hp: d.hp, alive: d.killed ? false : w.alive });
      if (d.killed && w.alive) killed.push(d.worm);
      if (d.dmg > maxDmg) maxDmg = d.dmg;
      if (d.dmg > 0) {
        dmgBySeat[e.owner_seat] = (dmgBySeat[e.owner_seat] || 0) + d.dmg;
        if (e.owner_seat >= 0) {
          dealt = dealt.slice();
          dealt[e.owner_seat] = (dealt[e.owner_seat] || 0) + d.dmg;
        }
        const cur = wormById(d.worm);
        addFx({ type: "hurt", worm: d.worm, seat: cur.seat, dmg: d.dmg, x: cur.x + 0.5, y: cur.y });
        if (d.killed) {
          addFx({ type: "death", worm: d.worm, seat: cur.seat, x: cur.x + 0.5, y: cur.y, cause: "boom" });
          addMoment({ round: roundNo, tick, type: "kill", seat: cur.seat, label: `${seatLabel(cur.seat)} 被击毁` });
          addFeed({ round: roundNo, seat: cur.seat, kind: "death", text: `${seatLabel(cur.seat)} KO` });
        }
      }
    }
    if (maxDmg > maxSingleDamage) maxSingleDamage = maxDmg;

    addFx({
      type: "explode", x: e.x, y: e.y, radius: num(e.radius, 2), kind: e.kind,
      seat: e.owner_seat, worm: e.owner_worm,
      damage: e.damage || [], destroyed: e.destroyed || [], killed
    });
    addAudio({ cue: "boom", x: e.x, y: e.y, radius: num(e.radius, 2) });
    boomCount += 1;
    killCount += killed.length;

    const total = (e.damage || []).reduce((a, d) => a + (d.dmg || 0), 0);
    addFeed({
      round: roundNo, seat: e.owner_seat, kind: "boom",
      text: total > 0
        ? `${seatLabel(e.owner_seat)} ${kindLabel(e.kind)}命中 -${total}`
        : `${seatLabel(e.owner_seat)} ${kindLabel(e.kind)}落空`
    });
    addMoment({
      round: roundNo, tick, type: "explode", seat: e.owner_seat, kind: e.kind,
      label: `${seatLabel(e.owner_seat)} ${kindLabel(e.kind)}爆炸`
    });
    return killed.length;
  }

  function emitFlight(round, aims) {
    const groups = [];
    let cur = null;
    let started = false;
    let pendingPre = [];   // 首个 tick 之前发生的爆炸/反弹（如出膛即炸）
    for (const e of round.events) {
      if (e.type === "fire") { started = true; continue; }
      if (!started) continue;
      if (e.type === "tick") {
        cur = { tick: e.tick, pre: pendingPre, proj: e.proj || [] };
        pendingPre = [];
        groups.push(cur);
      } else if (e.type === "bounce" || e.type === "dig" || e.type === "explode" ||
        (e.type === "settle" && e.phase === "boom")) {
        if (cur) cur.pre.push(e);
        else pendingPre.push(e);
      }
    }
    if (pendingPre.length) groups.push({ tick: 1, pre: pendingPre, proj: [] });

    const seatBySlot = new Map();
    for (const a of aims) if (a.slot !== null) seatBySlot.set(a.slot, a.seat);

    for (const g of groups) {
      tick = g.tick;
      let booms = 0, kills = 0;
      for (const e of g.pre) {
        if (e.type === "bounce") {
          addFx({ type: "bounce", x: e.x, y: e.y, slot: e.slot, vx: e.vx / 65536, vy: e.vy / 65536 });
          addAudio({ cue: "bounce", speed: Math.hypot(e.vx, e.vy) / 65536 });
          bounceCount += 1;
          addFeed({ round: roundNo, seat: seatBySlot.get(e.slot) ?? -1, kind: "bounce", text: `${seatLabel(seatBySlot.get(e.slot) ?? 0)} 手雷弹跳` });
        } else if (e.type === "dig") {
          const cells = [];
          if (Array.isArray(e.cell)) destroyCells([e.cell], cells);
          applyTerrain(cells, "dig");
          digCells += cells.length;
          addFx({ type: "dig", x: e.cell[0] + 0.5, y: e.cell[1] + 0.5, slot: e.slot, dug: e.dug });
          addAudio({ cue: "dig", dug: e.dug });
        } else if (e.type === "explode") {
          kills += applyExplode(e) ? 1 : 0;
          booms += 1;
        } else if (e.type === "settle") {
          applySettle(e, "boom");
        }
      }

      projs = (g.proj || []).map((p) => ({
        slot: p.slot,
        kind: p.kind,
        x: p.x / 65536,
        y: p.y / 65536,
        vx: p.vx / 65536,
        vy: p.vy / 65536,
        age: p.age,
        life: p.life,
        stuck: !!p.stuck,
        dug: p.dug | 0,
        seat: seatBySlot.has(p.slot) ? seatBySlot.get(p.slot) : -1
      }));
      pushFrame("flight");

      if (booms > 0) for (let i = 0; i < T.impactHold; i++) pushFrame("impact");
      if (kills > 0) {
        for (let i = 0; i < T.koHold; i++) pushFrame("impact");
        addAudio({ cue: "ko" });
      }
    }
    projs = [];
    tick = 0;
  }

  function applyWaterEvent(e) {
    const from = num(e.from, water);
    const to = num(e.level, water);
    addAudio({ cue: "water" });
    const drowned = Array.isArray(e.drowned) ? e.drowned : [];
    for (const d of drowned) {
      const id = typeof d === "object" && d ? d.worm : d;
      const w = wormById(id);
      if (!w) continue;
      setWorm(id, { alive: false, hp: 0 });
      addFx({ type: "drown", worm: id, seat: w.seat, x: w.x + 0.5, y: w.y });
      addAudio({ cue: "death", cause: "water" });
      addFeed({ round: roundNo, seat: w.seat, kind: "death", text: `${seatLabel(w.seat)} 落水` });
      addMoment({ round: roundNo, tick, type: "kill", seat: w.seat, label: `${seatLabel(w.seat)} 落水` });
    }
    for (let i = 1; i <= T.water; i++) {
      water = lerp(from, to, easeInOutQuad(i / T.water));
      pushFrame("water");
    }
    water = to;
    addFeed({ round: roundNo, seat: -1, kind: "water", text: `水位 ${to}` });
    addMoment({ round: roundNo, tick, type: "water", label: `水位 ${to}` });
  }

  function emitRoundEnd(round, count) {
    const end = round.end || {};
    hpArr = Array.isArray(end.hp) ? end.hp.slice() : hpArr;
    dealt = Array.isArray(end.dealt) ? end.dealt.slice() : dealt;
    stateHash = end.state_hash || stateHash;
    over = !!end.over;
    winner = num(end.winner, winner);
    reason = end.reason || reason;

    if (Array.isArray(end.worms) && end.worms.length) {
      end.worms.forEach((row, i) => {
        const w = worms[i] || { id: i };
        const id = w.id;
        setWorm(id, {
          x: num(row[0], 0), y: num(row[1], 0), hp: num(row[2], 0),
          grenades: num(row[3], 0), drills: num(row[4], 0), alive: !!row[5]
        });
      });
    }
    addAudio({ cue: "turn_end" });
    for (let i = 0; i < count; i++) pushFrame("end");
  }

  function emitFinal() {
    const label = winner >= 0 ? (trace.meta.bot_labels[winner] || trace.meta.bots[winner] || "") : "";
    banner = {
      text: winner >= 0 ? `WINNER · SEAT ${winner + 1}` : "DRAW",
      sub: `${reason}  ·  ${label}`,
      tone: "final"
    };
    cameraHint = winner >= 0 ? { mode: "follow", seat: winner } : null;
    addFx({ type: "win", seat: winner, life: 130 });
    addAudio({ cue: "win" });
    addFeed({ round: roundNo, seat: winner, kind: "end", text: winner >= 0 ? `${seatLabel(winner)} 胜出 · ${reason}` : "平局" });
    addMoment({ round: roundNo, tick, type: "end", seat: winner, label: "终局" });
    for (let i = 0; i < T.final; i++) pushFrame("final");
    banner = null;
  }

  /* ---------------- 主循环 ---------------- */

  emitIntro();

  let prevWind = null;
  for (let ri = 0; ri < trace.rounds.length; ri++) {
    const round = trace.rounds[ri];
    roundIndex = ri;
    roundNo = round.round;

    const moveGroups = groupMoves(round);
    const fireEvents = round.events.filter((e) => e.type === "fire");
    const waterEvent = round.events.find((e) => e.type === "water");
    const quiet = !moveGroups.length && !fireEvents.length;

    const startFrame = frames.length;
    const windChanged = prevWind !== null && round.wind !== prevWind;
    emitRoundStart(round, windChanged, quiet ? T.quietRound : T.roundStart);
    wind = num(round.wind, wind);
    water = num(round.water, water);
    tick = 0;

    for (const g of moveGroups) emitMoveGroup(g);

    if (fireEvents.length) {
      const aims = computeAims(round, fireEvents);
      emitAim(aims);
      emitFire(aims);
      emitFlight(round, aims);
    }

    if (waterEvent) applyWaterEvent(waterEvent);

    cameraHint = null;
    emitRoundEnd(round, quiet ? 6 : T.roundEnd);

    roundRanges.push({
      round: round.round,
      start: startFrame,
      end: frames.length - 1,
      wind: round.wind,
      water: round.water,
      shots: (round.shots || []).length,
      over: !!round.end.over
    });

    prevWind = round.wind;
    if (over) { emitFinal(); break; }
    if (frames.length > 200000) break; // 安全阀
  }

  // 收尾：如果 trace 结束但没有任何 over（40 轮上限），补一个终局
  if (!over && frames.length) {
    const last = frames[frames.length - 1];
    roundNo = last.round;
    winner = num(trace.result && trace.result.winner, -1);
    reason = (trace.result && trace.result.reason) || "MAX_ROUNDS";
    over = true;
    emitFinal();
  }

  /* ---------------- 收尾：索引 ---------------- */

  const totalFrames = frames.length;

  const momentsByType = {};
  for (const m of keyMoments) {
    (momentsByType[m.type] = momentsByType[m.type] || []).push(m);
  }

  const stats = {
    frames: totalFrames,
    rounds: roundRanges.length,
    shots: shotCount,
    booms: boomCount,
    kills: killCount,
    bounces: bounceCount,
    digCells,
    maxSingleDamage,
    dmgBySeat,
    seconds: totalFrames / FPS
  };

  return {
    frames,
    keyMoments,
    totalFrames,
    timing: T,
    trace,
    roundRanges,
    feed,
    gridOps,
    momentsByType,
    stats,
    getTerrainSnapshot: makeTerrainGetter(snapshots, gridOps, grid)
  };
}

/* ------------------------------------------------------------------ */
/* 地形快照                                                            */
/* ------------------------------------------------------------------ */

function makeTerrainGetter(snapshots, gridOps, baseGrid) {
  let cache = { idx: -1, result: null };

  function snapshotAt(idx) {
    if (cache.idx === idx && cache.result) return cache.result;

    let si = 0;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i].frame <= idx) { si = i; break; }
    }
    const snap = snapshots[si];
    const rows = snap ? snap.rows.slice() : baseGrid.map((r) => r.join(""));
    const fromFrame = snap ? snap.frame : 0;
    let version = snap ? snap.version : 0;

    for (let i = 0; i < gridOps.length; i++) {
      const op = gridOps[i];
      if (op.frame <= fromFrame) continue;
      if (op.frame > idx) break;
      for (let k = 0; k < op.cells.length; k++) {
        const x = op.cells[k][0], y = op.cells[k][1];
        const row = rows[y];
        if (row === undefined) continue;
        if (row.charCodeAt(x) === 46) continue; // 已是空气
        rows[y] = row.slice(0, x) + AIR + row.slice(x + 1);
      }
      version = op.version;
    }

    const result = { frame: idx, rows, version, solid: null };
    result.solid = (x, y) => {
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return false;
      return isSolidChar(rows[y].charAt(x));
    };
    cache = { idx, result };
    return result;
  }

  return snapshotAt;
}

/* ------------------------------------------------------------------ */
/* Timeline：播放头 + 查询                                              */
/* ------------------------------------------------------------------ */

export class Timeline {
  constructor(baked) {
    this.baked = baked;
    this.frames = baked.frames;
    this.totalFrames = baked.totalFrames;
    this.index = 0;
    this.playhead = 0;
    this.trace = baked.trace;
    this.keyMoments = baked.keyMoments;
    this.roundRanges = baked.roundRanges;
    this.feed = baked.feed;
    this.stats = baked.stats;
  }

  frameAt(i) {
    const n = this.totalFrames;
    if (!n) return null;
    const k = i < 0 ? 0 : i >= n ? n - 1 : i | 0;
    return this.frames[k];
  }

  seek(i) {
    const n = this.totalFrames;
    const k = n ? clamp(i | 0, 0, n - 1) : 0;
    this.index = k;
    this.playhead = k;
    return this.frameAt(k);
  }

  step(delta) { return this.seek(this.index + (delta | 0)); }

  get frame() { return this.frameAt(this.index); }
  get progress() { return this.totalFrames > 1 ? this.index / (this.totalFrames - 1) : 0; }
  get last() { return this.index >= this.totalFrames - 1; }

  getTerrainSnapshot(i) { return this.baked.getTerrainSnapshot(i === undefined ? this.index : i); }

  /** 当前帧之前（含）的最近 n 条事件流 */
  getFeed(i, n = 6) {
    const idx = i === undefined ? this.index : i;
    const out = [];
    for (let k = this.feed.length - 1; k >= 0 && out.length < n; k--) {
      if (this.feed[k].frame <= idx) out.push(this.feed[k]);
    }
    return out.reverse();
  }

  roundAt(i) {
    const idx = i === undefined ? this.index : i;
    const rr = this.roundRanges;
    let lo = 0, hi = rr.length - 1, ans = rr.length ? rr[0] : null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rr[mid].start <= idx) { ans = rr[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /** 跳轮：round 序号（1 起）或轮下标（0 起，负数不支持） */
  frameOfRound(roundNo) {
    const r = this.roundRanges.find((x) => x.round === roundNo);
    return r ? r.start : null;
  }

  /** 上一个 / 下一个关键事件帧；type 省略则任意类型 */
  nextMoment(type, from, dir = 1) {
    const list = type ? (this.baked.momentsByType[type] || []) : this.keyMoments;
    const idx = from === undefined ? this.index : from;
    if (dir > 0) {
      for (const m of list) if (m.frame > idx) return m;
      return null;
    }
    for (let i = list.length - 1; i >= 0; i--) if (list[i].frame < idx) return list[i];
    return null;
  }

  /** 投射物尾迹：回溯 n 帧取同一 slot 的位置 */
  getProjTrail(i, slot, n = 6) {
    const out = [];
    for (let k = Math.max(0, i - n); k <= i; k++) {
      const f = this.frames[k];
      if (!f || !f.projs) continue;
      for (const p of f.projs) {
        if (p.slot === slot) { out.push([p.x, p.y]); break; }
      }
    }
    return out;
  }
}

export function createTimeline(trace, opts) {
  return new Timeline(bakeFrames(trace, opts));
}
