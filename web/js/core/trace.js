/* P01 core · trace 载入与校验
 * 契约见 docs/SPEC.md §4。前端只消费 trace，不自行判定胜负。
 */
import { GRID_W, GRID_H, fetchJSON } from "./util.js";

const P01 = window.P01;
export const SCHEMA = "p01viz/1";

/** 载入：url 字符串 或 已解析的 trace 对象 */
export async function loadTrace(src, opts = {}) {
  let raw = null;
  let source = null;

  if (typeof src === "string") {
    source = src;
    try {
      raw = await fetchJSON(src, opts);
    } catch (e) {
      throw new Error(`trace 载入失败：${e.message || e}`);
    }
  } else if (src && typeof src === "object") {
    raw = src;
    source = opts.source || null;
  } else {
    throw new Error("loadTrace 需要 trace 的 URL 或对象");
  }

  const trace = normalizeTrace(raw);
  const warnings = validateTrace(trace);
  trace.__source = source;
  trace.__warnings = warnings;
  return trace;
}

function normalizeTrace(raw) {
  const t = raw;
  if (!t || typeof t !== "object") throw new Error("trace 内容不是对象");

  t.meta = t.meta || {};
  const seats = Number(t.meta.seats || 4) || 4;
  t.meta.seats = seats;

  if (!Array.isArray(t.meta.bots)) t.meta.bots = [];
  while (t.meta.bots.length < seats) t.meta.bots.push("bot-" + t.meta.bots.length);
  if (!Array.isArray(t.meta.bot_labels) || t.meta.bot_labels.length !== t.meta.bots.length) {
    t.meta.bot_labels = t.meta.bots.map((b) => String(b || "").toUpperCase());
  }
  if (t.meta.seed === undefined || t.meta.seed === null) t.meta.seed = 0;

  t.map = t.map || {};
  if (!Array.isArray(t.map.grid)) t.map.grid = [];

  t.initial = t.initial || {};
  if (!Array.isArray(t.initial.worms)) t.initial.worms = [];
  if (!Array.isArray(t.initial.hp)) t.initial.hp = new Array(seats).fill(0);
  if (!Array.isArray(t.initial.dealt)) t.initial.dealt = new Array(seats).fill(0);

  // 初始虫：补齐 seat / alive 字段
  t.initial.worms = t.initial.worms.map((w, i) => ({
    id: Number.isFinite(w.id) ? w.id : i,
    seat: Number.isFinite(w.seat) ? w.seat : Math.floor(i / 3),
    x: w.x | 0, y: w.y | 0,
    hp: Number.isFinite(w.hp) ? w.hp : 100,
    grenades: Number.isFinite(w.grenades) ? w.grenades : 0,
    drills: Number.isFinite(w.drills) ? w.drills : 0,
    alive: w.alive !== false
  }));

  t.rounds = Array.isArray(t.rounds) ? t.rounds : [];
  t.rounds.forEach((r, i) => {
    if (!Number.isFinite(r.round)) r.round = i + 1;
    if (!Array.isArray(r.events)) r.events = [];
    if (!Array.isArray(r.shots)) r.shots = [];
    if (!r.orders || typeof r.orders !== "object") r.orders = {};
    if (!r.end || typeof r.end !== "object") r.end = {};
    if (!Array.isArray(r.end.hp)) r.end.hp = t.initial.hp.slice();
    if (!Array.isArray(r.end.dealt)) r.end.dealt = t.initial.dealt.slice();
    if (!Array.isArray(r.end.worms)) r.end.worms = [];
    r.end.over = !!r.end.over;
  });

  t.result = t.result || {};
  if (!Array.isArray(t.result.hp)) t.result.hp = t.initial.hp.slice();
  if (!Array.isArray(t.result.dealt)) t.result.dealt = t.initial.dealt.slice();
  if (t.result.winner === undefined) t.result.winner = -1;
  if (t.result.rounds === undefined) t.result.rounds = t.rounds.length;
  if (!Array.isArray(t.result.faults)) t.result.faults = new Array(seats).fill(0);
  if (!Array.isArray(t.result.dead_bots)) t.result.dead_bots = [];

  return t;
}

/** 返回警告列表；结构性错误直接抛错 */
export function validateTrace(t) {
  const warn = [];
  if (t.schema !== SCHEMA) {
    throw new Error(`trace schema 不匹配：期望 "${SCHEMA}"，实际 "${t.schema}"`);
  }
  if (!Array.isArray(t.map.grid) || t.map.grid.length !== GRID_H) {
    throw new Error(`trace.map.grid 行数应为 ${GRID_H}，实际 ${t.map.grid ? t.map.grid.length : 0}`);
  }
  for (let y = 0; y < GRID_H; y++) {
    const row = t.map.grid[y];
    if (typeof row !== "string" || row.length !== GRID_W) {
      throw new Error(`trace.map.grid[${y}] 宽度应为 ${GRID_W}，实际 ${typeof row === "string" ? row.length : typeof row}`);
    }
  }
  if (!t.initial.worms.length) throw new Error("trace.initial.worms 为空");
  if (t.initial.worms.length !== t.meta.seats * 3) {
    warn.push(`initial.worms 数量 ${t.initial.worms.length}，与 seats×3=${t.meta.seats * 3} 不一致`);
  }
  if (!t.rounds.length) throw new Error("trace.rounds 为空");

  let lastRound = 0;
  for (const r of t.rounds) {
    if (r.round < lastRound) warn.push(`round 序号回退：${lastRound} → ${r.round}`);
    lastRound = r.round;
    if (!r.end || typeof r.end !== "object") warn.push(`round ${r.round} 缺少 end`);
    for (const s of r.shots) {
      if (!Number.isFinite(s.angle) || !Number.isFinite(s.power)) {
        warn.push(`round ${r.round} 的 shots 缺少 angle/power`);
        break;
      }
    }
  }
  if (t.rounds[t.rounds.length - 1] && !t.rounds[t.rounds.length - 1].end.over) {
    warn.push("最后一轮 end.over 为 false，按 trace 原样播放（可能达到 40 轮上限）");
  }
  if (warn.length && typeof console !== "undefined") {
    // 仅提示，不打断播放
    console.info("[P01] trace 校验警告：\n· " + warn.join("\n· "));
  }
  return warn;
}

/** 便捷：从 catalog 拿样例地址 */
export function traceLabel(t) {
  return `${t.meta.map || "map"} · s${t.meta.seed} · ${(t.meta.bot_labels || []).join(" / ")}`;
}
