/* P01 core · 视觉层缺席时的最小渲染兜底
 * 目标：不白屏——能看懂地形 / 虫 / 弹道 / 爆炸。真正的像素皮肤与特效由 web/js/visual/**提供。
 * 全部程序化绘制，无外链、无 Math.random（噪点用 hash）。
 */
import { GRID_W, GRID_H, PX, AIR, ROCK, isSolidChar, noise2, clamp, easeOutCubic } from "./util.js";

const P01 = window.P01;

export function createFallbackVisual() {
  const pal = P01.palette;
  let terrainCanvas = null;
  let terrainCtx = null;
  let terrainVersion = -1;

  const api = {
    name: "fallback",
    registerLayers,
    onFrame() { /* 兜底层完全由 frame 状态驱动，无需事件 */ },
    audio: { play() {}, setMuted() {} }
  };

  function ensureTerrainCanvas() {
    if (!terrainCanvas) {
      terrainCanvas = document.createElement("canvas");
      terrainCanvas.width = GRID_W * PX;
      terrainCanvas.height = GRID_H * PX;
      terrainCtx = terrainCanvas.getContext("2d");
    }
  }

  function rebuildTerrain(snapshot) {
    ensureTerrainCanvas();
    const ctx = terrainCtx;
    ctx.clearRect(0, 0, terrainCanvas.width, terrainCanvas.height);
    const rows = snapshot.rows;

    for (let y = 0; y < GRID_H; y++) {
      const row = rows[y];
      for (let x = 0; x < GRID_W; x++) {
        const ch = row.charAt(x);
        if (!isSolidChar(ch)) continue;
        const px = x * PX, py = y * PX;
        const n = noise2(x, y, 11);
        if (ch === ROCK) {
          ctx.fillStyle = n > 0.5 ? pal.rock0 : pal.rock1;
        } else {
          ctx.fillStyle = n < 0.34 ? pal.dirt0 : n < 0.72 ? pal.dirt1 : pal.dirt2;
        }
        ctx.fillRect(px, py, PX, PX);

        // 碎石噪点
        if (n > 0.82) {
          ctx.fillStyle = ch === ROCK ? pal.rockEdge : pal.dirtSpeck;
          ctx.fillRect(px + 3, py + 4, 2, 2);
        }
        // 草皮 / 亮边
        const above = y > 0 ? rows[y - 1].charAt(x) : AIR;
        if (!isSolidChar(above)) {
          ctx.fillStyle = ch === ROCK ? pal.rockEdge : pal.grass0;
          ctx.fillRect(px, py, PX, 2);
          ctx.fillStyle = ch === ROCK ? pal.rock0 : pal.grass1;
          ctx.fillRect(px, py + 2, PX, 1);
        }
      }
    }
  }

  function registerLayers(renderer) {
    renderer.register({ name: "fb-bg", z: 0, draw: drawBackground });
    renderer.register({ name: "fb-terrain", z: 10, draw: drawTerrain });
    renderer.register({ name: "fb-aim", z: 25, draw: drawAim });
    renderer.register({ name: "fb-worms", z: 20, draw: drawWorms });
    renderer.register({ name: "fb-water", z: 26, draw: drawWater });
    renderer.register({ name: "fb-projs", z: 30, draw: drawProjs });
    renderer.register({ name: "fb-fx", z: 40, draw: drawFx });
  }

  /* ---------------- 背景（静态层缓存） ---------------- */

  let skyCanvas = null;

  function buildSky() {
    const W = GRID_W * PX, H = GRID_H * PX;
    skyCanvas = document.createElement("canvas");
    skyCanvas.width = W;
    skyCanvas.height = H;
    const ctx = skyCanvas.getContext("2d");

    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, pal.skyTop);
    g.addColorStop(0.55, pal.skyMid);
    g.addColorStop(1, pal.skyLow);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 月/落日
    const sunX = W * 0.72, sunY = 44 * PX - 96;
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = pal.sun;
    ctx.fillRect(sunX - 8, sunY + 6, 50, 22);
    ctx.globalAlpha = 0.9;
    ctx.fillRect(sunX, sunY, 34, 34);
    ctx.globalAlpha = 1;

    // 星点
    for (let i = 0; i < 90; i++) {
      const x = noise2(i, 1, 5) * W;
      const y = noise2(i, 2, 7) * H * 0.38;
      const a = 0.15 + noise2(i, 3, 9) * 0.4;
      ctx.fillStyle = `rgba(200, 235, 255, ${a.toFixed(2)})`;
      ctx.fillRect(x | 0, y | 0, 1, 1);
    }

    // 远山剪影
    ctx.fillStyle = "#0a1a26";
    ctx.beginPath();
    ctx.moveTo(0, H * 0.52);
    for (let x = 0; x <= W; x += 40) {
      const y = H * 0.52 - noise2(x / 40, 11, 3) * 26;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fill();
  }

  function drawBackground(ctx) {
    if (!skyCanvas) buildSky();
    ctx.drawImage(skyCanvas, 0, 0);
  }

  /* ---------------- 地形 ---------------- */

  function drawTerrain(ctx, view) {
    const f = view.frame;
    const tl = view.timeline;
    if (!tl) return;
    // 只有地形版本变化（破坏/挖掘/换轮/回跳）才重建离屏画布
    if (terrainVersion !== f.gridVersion) {
      const snap = tl.getTerrainSnapshot(f.index);
      rebuildTerrain(snap);
      terrainVersion = f.gridVersion;
    }
    ctx.drawImage(terrainCanvas, 0, 0);
  }

  /* ---------------- 水 ---------------- */

  function drawWater(ctx, view) {
    const level = view.frame.water;
    const y = level * PX;
    const H = GRID_H * PX;
    if (y >= H) return;

    ctx.globalAlpha = 0.62;
    const g = ctx.createLinearGradient(0, y, 0, H);
    g.addColorStop(0, pal.water1);
    g.addColorStop(1, pal.water0);
    ctx.fillStyle = g;
    ctx.fillRect(0, y, GRID_W * PX, H - y);

    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.waterFoam;
    const t = view.frame.index;
    for (let x = 0; x < GRID_W * PX; x += 6) {
      const wave = Math.sin((x * 0.03) + t * 0.06) * 2;
      ctx.fillRect(x, y + Math.round(wave) - 1, 4, 1);
    }
  }

  /* ---------------- 虫 ---------------- */

  function drawWorms(ctx, view) {
    const f = view.frame;
    const actSeats = new Set((f.aim || []).map((a) => a.seat));
    for (const w of f.worms) {
      if (!w.alive) continue;
      const seat = P01.seats[w.seat] || { color: "#fff" };
      const x = Math.round(w.x * PX + PX / 2);
      const y = Math.round(w.y * PX + PX);
      const bob = actSeats.has(w.seat) ? (Math.sin(f.index * 0.25) > 0 ? 0 : -1) : 0;

      ctx.fillStyle = "#06101a";
      ctx.fillRect(x - 5, y - 13 + bob, 10, 13);
      ctx.fillStyle = seat.color;
      ctx.fillRect(x - 4, y - 12 + bob, 8, 10);
      ctx.fillStyle = "#eaf6ff";
      ctx.fillRect(x - 3, y - 10 + bob, 2, 2);
      ctx.fillRect(x + 1, y - 10 + bob, 2, 2);
      ctx.fillStyle = "#06101a";
      ctx.fillRect(x - 2, y - 9 + bob, 1, 1);
      ctx.fillRect(x + 2, y - 9 + bob, 1, 1);

      if (actSeats.has(w.seat)) {
        ctx.fillStyle = seat.color;
        ctx.fillRect(x - 1, y - 17 + bob, 2, 3);
        ctx.globalAlpha = 0.5;
        ctx.fillRect(x - 6, y - 1, 12, 1);
        ctx.globalAlpha = 1;
      }

      // HP 条（受伤或行动时）
      if (w.hp < 100 || actSeats.has(w.seat)) {
        const wpx = 10;
        ctx.fillStyle = "#0a1119";
        ctx.fillRect(x - wpx / 2, y - 19 + bob, wpx, 2);
        ctx.fillStyle = w.hp > 50 ? seat.color : pal.danger;
        ctx.fillRect(x - wpx / 2, y - 19 + bob, Math.max(0, (w.hp / 100) * wpx), 2);
      }
    }
  }

  /* ---------------- 瞄准 ---------------- */

  function drawAim(ctx, view) {
    const aims = view.frame.aim;
    if (!aims || !aims.length) return;
    for (const a of aims) {
      const seat = P01.seats[a.seat] || { color: "#fff" };
      if (!a.pts || a.pts.length < 2) continue;

      ctx.save();
      ctx.strokeStyle = seat.color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      a.pts.forEach((p, i) => {
        const x = p[0] * PX, y = p[1] * PX;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // 无风参考线
      if (a.noWind && a.noWind.length > 1) {
        ctx.globalAlpha = 0.22;
        ctx.strokeStyle = "#eaf6ff";
        ctx.beginPath();
        a.noWind.forEach((p, i) => {
          const x = p[0] * PX, y = p[1] * PX;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      // 落点圈
      if (a.land) {
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = seat.color;
        ctx.beginPath();
        ctx.arc(a.land[0] * PX, a.land[1] * PX, a.radius * PX * 0.8, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* ---------------- 投射物 ---------------- */

  function drawProjs(ctx, view) {
    const f = view.frame;
    if (!f.projs || !f.projs.length) return;
    for (const p of f.projs) {
      const seat = P01.seats[p.seat] || { color: pal.gold };
      const x = p.x * PX, y = p.y * PX;
      const trail = view.timeline.getProjTrail(f.index, p.slot, 5);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = seat.color;
      for (let i = 0; i < trail.length - 1; i++) {
        ctx.fillRect(trail[i][0] * PX - 1, trail[i][1] * PX - 1, 2, 2);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#06101a";
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.fillStyle = p.kind === 2 ? pal.gold : seat.color;
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
  }

  /* ---------------- 特效 ---------------- */

  function drawFx(ctx, view) {
    const f = view.frame;
    for (const fx of f.fxLive) {
      const age = f.index - fx.frame;
      const p = clamp(age / fx.life, 0, 1);
      if (fx.type === "explode") {
        const cx = fx.x * PX, cy = fx.y * PX;
        const base = fx.radius * PX;
        const grow = easeOutCubic(clamp(p * 2.8, 0, 1));
        const alpha = Math.max(0, 1 - p * 0.95);

        // 白闪
        if (p < 0.12) {
          ctx.globalAlpha = 0.85 * (1 - p / 0.12);
          ctx.fillStyle = "#fff7e6";
          ctx.beginPath();
          ctx.arc(cx, cy, base * 0.9, 0, Math.PI * 2);
          ctx.fill();
        }

        // 火球：外→内四层（暗红 / 橙 / 金 / 白芯）
        const layers = [[1, "#a63a2a", 0.85], [0.74, "#ff8a3d", 0.9], [0.5, "#ffd166", 0.95], [0.26, "#fff7e6", 1]];
        for (const [k, color, a] of layers) {
          ctx.globalAlpha = alpha * a;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(1.5, base * (0.42 + grow * 0.9) * k), 0, Math.PI * 2);
          ctx.fill();
        }

        // 冲击波环
        ctx.globalAlpha = alpha * 0.55;
        ctx.strokeStyle = "#fff7e6";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, base * (0.6 + p * 2.2), 0, Math.PI * 2);
        ctx.stroke();

        // 烟（火球外层散开，不压暗核心）
        if (p > 0.45) {
          const sp = (p - 0.45) / 0.55;
          ctx.globalAlpha = (1 - sp) * 0.35;
          ctx.fillStyle = "#2a2f38";
          for (let i = 0; i < 5; i++) {
            const a1 = noise2(i, fx.id, 3) * Math.PI * 2;
            const rr = base * (0.9 + sp * 1.5);
            ctx.fillRect(cx + Math.cos(a1) * rr - 2, cy + Math.sin(a1) * rr - sp * 12 - 2, 5, 5);
          }
        }
        ctx.globalAlpha = 1;
      } else if (fx.type === "bounce") {
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = pal.gold;
        ctx.fillRect(fx.x * PX - 2, fx.y * PX - 2, 4, 4);
        ctx.globalAlpha = 1;
      } else if (fx.type === "dig") {
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = "#b07a45";
        for (let i = 0; i < 5; i++) {
          const n1 = noise2(i, fx.id, 3) - 0.5;
          const n2 = noise2(i, fx.id, 5) - 0.5;
          ctx.fillRect(fx.x * PX + n1 * 18, fx.y * PX + n2 * 18 - p * 14, 3, 3);
        }
        ctx.globalAlpha = 1;
      } else if (fx.type === "death" || fx.type === "drown") {
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = fx.type === "drown" ? pal.waterFoam : "#ff8a8a";
        ctx.fillRect(fx.x * PX - 1, fx.y * PX - 10 - p * 16, 2, 8);
        ctx.fillRect(fx.x * PX - 4, fx.y * PX - 7 - p * 16, 8, 2);
        ctx.globalAlpha = 1;
      }
    }
  }

  return api;
}
