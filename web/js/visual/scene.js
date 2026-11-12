const P = window.P01;
const mod = (x, n) => ((x % n) + n) % n;
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const number = (frame, view) => frame.frame ?? frame.index ?? view.frame ?? 0;
const solid = c => c === '#' || c === 'X';

export function createScene(effects) {
  const terrain = canvas(960, 540), sky = canvas(960, 540), atlas = canvas(128, 80);
  const tc = terrain.getContext('2d'), sc = sky.getContext('2d'), ac = atlas.getContext('2d');
  let palette = P.palette, oldGrid = [], original = null, version = null, stars = [], clouds = [], streaks = [];
  let aimSource = null, aims = [], traceRef = null;
  function prepare(custom = {}) {
    palette = { ...P.palette, ...custom };
    const rng = P.util.rng(7101);
    stars = Array.from({ length: 75 }, () => ({ x: rng() * 960 | 0, y: rng() * 170 | 0, bright: rng() }));
    clouds = Array.from({ length: 18 }, (_, i) => ({ x: rng() * 1120, y: 40 + rng() * 185, w: 35 + rng() * 90, row: i % 3 }));
    streaks = Array.from({ length: 60 }, () => ({ x: rng() * 960, y: 20 + rng() * 410, len: 8 + rng() * 26 }));
    for (let y = 0; y < 540; y += 6) {
      const t = y / 540, a = y < 180 ? [7, 16, 28] : [13, 36, 51], b = y < 180 ? [13, 36, 51] : [27, 74, 88];
      sc.fillStyle = `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',')})`; sc.fillRect(0, y, 960, 6);
    }
    stars.forEach(s => { sc.fillStyle = s.bright > .8 ? '#8db4bd' : '#355867'; sc.fillRect(s.x, s.y, s.bright > .9 ? 2 : 1, 1); });
    // Blocky dusk sun: stepped pixel circle + soft halo + horizon reflection.
    const sx = 752, sy = 166;
    const sunRows = [[10, 6], [22, 6], [30, 6], [36, 6], [36, 6], [30, 6], [22, 6], [10, 6]];
    sc.globalAlpha = .09; sc.fillStyle = palette.sun;
    for (let i = 0; i < sunRows.length; i++) {
      const w = sunRows[i][0] + 20;
      sc.fillRect(sx - w / 2, sy - 28 + i * 7, w, 7);
    }
    sc.globalAlpha = 1;
    for (let i = 0; i < sunRows.length; i++) {
      const w = sunRows[i][0];
      sc.fillStyle = i < 3 ? '#ffe0a8' : i < 5 ? palette.sun : '#e08a5a';
      sc.fillRect(sx - w / 2, sy - 28 + i * 7, w, 7);
    }
    sc.fillStyle = '#ffcf8a';
    for (let i = 0; i < 3; i++) sc.fillRect(sx - 14 + i * 4, sy - 12 + i * 7, 22 - i * 4, 2);
    sc.fillStyle = palette.seaFar; sc.fillRect(0, 218, 960, 322);
    sc.fillStyle = '#1a4657'; for (let y = 224; y < 470; y += 12) for (let x = (y * 13) % 97; x < 960; x += 101) sc.fillRect(x, y, 18 + y % 23, 1);
    sc.fillStyle = '#0b2634'; sc.fillRect(110, 208, 50, 5); sc.fillRect(119, 201, 29, 8); sc.fillRect(139, 183, 2, 20);
    sc.fillRect(826, 213, 12, 4); sc.fillRect(831, 201, 2, 12);
    sc.globalAlpha = .16; sc.fillStyle = '#ffb56b';
    for (let i = 0; i < 14; i++) sc.fillRect(sx - 12 + (i % 3) * 3, 222 + i * 9, 24 - i, 1);
    sc.globalAlpha = 1;
    // Four distinct goggles/bandanna patterns, with idle and hurt atlas variants.
    ac.clearRect(0, 0, 128, 80); ac.imageSmoothingEnabled = false;
    P.seats.forEach((s, seat) => {
      for (let state = 0; state < 4; state++) {
        const x = state * 24, y = seat * 20, hurt = state === 2;
        ac.fillStyle = '#07101c'; ac.fillRect(x + 4, y + 2, 8, 12); ac.fillRect(x + 2, y + 5, 12, 8); ac.fillRect(x, y + 11, 15, 4);
        ac.fillStyle = hurt ? '#fff7e6' : '#b3c8b4'; ac.fillRect(x + 5, y + 3, 6, 10); ac.fillRect(x + 3, y + 7, 10, 6); ac.fillRect(x + 2, y + 12, 11, 2);
        ac.fillStyle = hurt ? '#fff7e6' : s.color; ac.fillRect(x + 3, y + 5, 11, 3); ac.fillRect(x + 1, y + 7, 3, 2);
        ac.fillStyle = s.dark; ac.fillRect(x + 4 + seat * 2, y + 5, 2, 3);
        ac.fillStyle = '#fff7e6'; ac.fillRect(x + 6, y + 4, 2, state === 1 ? 1 : 2); ac.fillRect(x + 10, y + 4, 2, state === 1 ? 1 : 2);
        ac.fillStyle = '#07101c'; ac.fillRect(x + 7, y + 4, 1, 1); ac.fillRect(x + 11, y + 4, 1, 1);
        if (state === 3) { ac.fillStyle = '#667d87'; ac.fillRect(x + 2, y + 7, 12, 5); ac.fillStyle = s.color; ac.fillRect(x + 13, y + 8, 3, 2); }
      }
    });
  }
  function cell(x, y, grid) {
    tc.clearRect(x * 10, y * 10, 10, 10);
    const c = grid[y]?.[x]; if (!solid(c)) return;
    const rng = P.util.rng(x * 107 + y * 65537), rock = c === 'X';
    tc.fillStyle = rock ? palette.rock0 : [palette.dirt0, palette.dirt1, palette.dirt2][Math.floor(rng() * 3)]; tc.fillRect(x * 10, y * 10, 10, 10);
    for (let i = 0; i < 4; i++) { tc.fillStyle = rock ? palette.rock1 : i % 2 ? palette.dirt2 : palette.dirtSpeck; tc.fillRect(x * 10 + (rng() * 9 | 0), y * 10 + (rng() * 9 | 0), 2, 1); }
    if (rock) { tc.fillStyle = palette.rockEdge; tc.fillRect(x * 10 + 1, y * 10 + 1, 7, 1); tc.fillRect(x * 10 + 7, y * 10 + 2, 1, 5); }
    else if (!solid(grid[y - 1]?.[x])) {
      const burnt = solid(original?.[y - 1]?.[x]);
      tc.fillStyle = burnt ? '#2a1a12' : palette.grass0; tc.fillRect(x * 10, y * 10, 10, 2);
      tc.fillStyle = burnt ? '#392316' : palette.grass1; tc.fillRect(x * 10 + 2, y * 10 + 2, 6, 1);
    }
    if (!rock) {
      tc.fillStyle = '#2a1a12';
      if (!solid(grid[y]?.[x - 1]) && solid(original?.[y]?.[x - 1])) tc.fillRect(x * 10, y * 10, 1, 10);
      if (!solid(grid[y]?.[x + 1]) && solid(original?.[y]?.[x + 1])) tc.fillRect(x * 10 + 9, y * 10, 1, 10);
    }
  }
  function update(frame, view) {
    const trace = view.trace;
    if (trace !== traceRef) { traceRef = trace; oldGrid = []; version = null; original = trace?.map?.grid || frame.grid; }
    const raw = frame.aim;
    if (raw !== aimSource) { aimSource = raw; aims = !raw ? [] : Array.isArray(raw) ? raw : raw.shots || [raw]; }
    if (version === frame.gridVersion && oldGrid.length && !frame.grid) { view.grid = oldGrid; return; }
    const grid = frame.grid || view.grid || view.timeline?.getTerrainSnapshot(frame.index)?.rows || trace?.map?.grid;
    if (!grid) return;
    if (oldGrid.length === 0) { tc.clearRect(0, 0, 960, 540); for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) cell(x, y, grid); }
    else {
      const dirty = new Set();
      for (let y = 0; y < 54; y++) if (grid[y] !== oldGrid[y]) for (let x = 0; x < 96; x++) if (grid[y]?.[x] !== oldGrid[y]?.[x]) {
        [[x, y], [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].forEach(([a, b]) => { if (a >= 0 && a < 96 && b >= 0 && b < 54) dirty.add(b * 96 + a); });
      }
      for (const n of dirty) cell(n % 96, Math.floor(n / 96), grid);
    }
    // Keep a snapshot: a core may edit the row array in place.
    oldGrid = grid.slice(); version = frame.gridVersion; view.grid = oldGrid;
  }
  function background(ctx, view, frame) {
    const n = number(frame, view), wind = frame.wind || 0;
    ctx.drawImage(sky, 0, 0);
    clouds.forEach(c => {
      const x = mod(c.x + n * (.012 + c.row * .008) * (wind || 1), 1120) - 160;
      ctx.fillStyle = ['#153040', '#1b3d4b', '#244b55'][c.row];
      ctx.fillRect(Math.round(x), Math.round(c.y), Math.round(c.w), 5); ctx.fillRect(Math.round(x + 12), Math.round(c.y - 4), Math.round(c.w * .65), 5);
    });
    const density = 20 + Math.abs(wind) * 4;
    for (let i = 0; i < density; i++) {
      const s = streaks[i]; if (!s) break;
      ctx.fillStyle = i % 3 ? '#537883' : '#82a7a9'; ctx.globalAlpha = .15 + Math.abs(wind) * .018;
      ctx.fillRect(Math.round(mod(s.x + n * wind * .35, 960)), s.y, Math.round(s.len * Math.max(.3, Math.abs(wind) / 8)), 1);
    }
    ctx.globalAlpha = 1;
    // Wind sock: readable direction, also at low wind.
    ctx.fillStyle = '#7e949c'; ctx.fillRect(474, 182, 2, 34);
    ctx.fillStyle = '#ffb56b'; const dir = wind < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) ctx.fillRect(475 + dir * i * 4, 184 + Math.round(Math.sin(n / 10 + i) * Math.abs(wind) / 6), dir * 4, 7 - i);
  }
  function drawTerrain(ctx) { ctx.drawImage(terrain, 0, 0); }
  function water(ctx, view, frame) {
    const n = number(frame, view), y = (frame.water ?? 50) * 10;
    ctx.fillStyle = '#125779'; ctx.globalAlpha = .8; ctx.fillRect(0, y + 2, 960, 540 - y); ctx.globalAlpha = 1;
    ctx.fillStyle = '#0c344c'; ctx.fillRect(0, y + 24, 960, Math.max(0, 540 - y - 24));
    for (let layer = 2; layer >= 0; layer--) {
      ctx.fillStyle = [palette.waterFoam, palette.water1, palette.water0][layer];
      for (let x = 0; x < 960; x += 4) {
        const dy = Math.round(Math.sin(x / 27 + n / 14 + layer) * 1.5 + Math.sin(x / 59 - n / 22));
        ctx.fillRect(x, y + dy + layer * 3, 4, layer === 0 ? 1 : 3);
      }
    }
    // Sun glitter column on the surface (sun at x≈752), twinkles deterministically by frame.
    ctx.fillStyle = '#ffd9a0';
    for (let i = 0; i < 14; i++) {
      const gx = 752 + Math.round(Math.sin(i * 12.9898 + Math.floor(n / 9) * .7) * (18 + i * 3));
      ctx.globalAlpha = ((i * 7 + Math.floor(n / 6)) % 5) / 8;
      ctx.fillRect(gx - (i % 3) * 2, y + 3 + i * 2, 4 + (i % 3) * 2, 1);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#3a8198'; ctx.globalAlpha = .4;
    for (let i = 0; i < 18; i++) ctx.fillRect(mod(i * 107 + n * .15, 960), y + 10 + (i * 13) % Math.max(12, 535 - y), 14, 1);
    ctx.globalAlpha = 1;
  }
  function worms(ctx, view, frame) {
    const n = number(frame, view), activeIds = new Set(aims.map(a => a.worm));
    (frame.worms || []).forEach(w => {
      const x = Math.round(w.x * 10 + 5), y = Math.round(w.y * 10 + 10), seat = P.seats[w.seat ?? Math.floor(w.id / 3)];
      if (!seat) return;
      if (!w.alive || w.hp <= 0) {
        if (w.y >= (frame.water ?? 50) || w.death === 'water') return;
        ctx.fillStyle = '#07101c'; ctx.fillRect(x - 5, y - 10, 10, 11); ctx.fillStyle = '#6d7c89'; ctx.fillRect(x - 3, y - 9, 6, 9);
        ctx.fillStyle = seat.color; ctx.fillRect(x - 2, y - 6, 4, 1); ctx.fillRect(x, y - 7, 1, 4); return;
      }
      const act = activeIds.has(w.id) || w.act || frame.activeWorm === w.id;
      ctx.globalAlpha = .35; ctx.fillStyle = '#02080e'; ctx.fillRect(x - 6, y, 12, 1); ctx.fillRect(x - 4, y + 1, 8, 1); ctx.globalAlpha = 1;
      const bob = Math.floor(n / 24 + w.id) % 2;
      if (act) { ctx.strokeStyle = seat.color; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(x, y, 9, 3, 0, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = seat.color; ctx.beginPath(); ctx.moveTo(x - 3, y - 24 - bob); ctx.lineTo(x + 3, y - 24 - bob); ctx.lineTo(x, y - 20 - bob); ctx.fill(); }
      const state = effects.hurt(w.id) ? 2 : act ? 3 : (n + w.id * 31) % 180 > 173 ? 1 : 0;
      ctx.drawImage(atlas, state * 24, seat.id * 20, 16, 16, x - 8, y - 15 - bob, 16, 16);
      if (w.hp < 100 || act) {
        ctx.fillStyle = '#07101c'; ctx.fillRect(x - 8, y - 20 - bob, 16, 4); ctx.fillStyle = w.hp < 30 ? palette.danger : seat.color; ctx.fillRect(x - 7, y - 19 - bob, Math.round(Math.max(0, w.hp) / 100 * 14), 2);
      }
      if (act || view.labels) {
        ctx.font = '8px "Courier New", monospace'; ctx.textAlign = 'center'; ctx.fillStyle = seat.light;
        const name = view.trace?.meta?.bot_labels?.[seat.id] || view.trace?.meta?.bots?.[seat.id] || `P${seat.id}`;
        ctx.fillText(`${['O', '<>', '^', '#'][seat.id]} ${String(name).slice(0, 12)}`, x, y + 11);
      }
    });
  }
  function projectiles(ctx, view, frame) {
    const n = number(frame, view);
    (frame.projs || frame.projectiles || []).forEach(p => {
      // Baked core coordinates are grid units. Raw trace Q16 must be normalized by its baker.
      const x = p.x * 10, y = p.y * 10, angle = Math.atan2(p.vy || 0, p.vx || 1), kind = +p.kind;
      if (kind === 1 && view.timeline?.getProjTrail) {
        const trail = view.timeline.getProjTrail(frame.index, p.slot, 24);
        for (let i = 0; i < trail.length; i++) { ctx.globalAlpha = i / trail.length * .6; ctx.fillStyle = i % 2 ? '#ffd166' : '#ff8a3d'; ctx.fillRect(Math.round(trail[i][0] * 10), Math.round(trail[i][1] * 10), 2, 2); }
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = 'lighter';
      const glow = kind === 1 ? '#ff8a3d' : kind === 2 ? ((p.life ?? 180) < 30 && n % 4 < 2 ? '#ff5d5d' : '#ffd166') : '#a8f3ff';
      ctx.fillStyle = glow;
      ctx.globalAlpha = .12; ctx.fillRect(Math.round(x) - 7, Math.round(y) - 5, 14, 10); ctx.fillRect(Math.round(x) - 5, Math.round(y) - 7, 10, 14);
      ctx.globalAlpha = .18; ctx.fillRect(Math.round(x) - 3, Math.round(y) - 3, 6, 6);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.save(); ctx.translate(Math.round(x), Math.round(y)); ctx.rotate(angle);
      if (kind === 1) {
        for (let j = 5; j >= 1; j--) { ctx.globalAlpha = (1 - j / 6) * .8; ctx.fillStyle = j % 2 ? '#ffd166' : '#ff8a3d'; ctx.fillRect(-j * 5 - 2, -1 + (j % 2), 3, 2); }
        ctx.globalAlpha = 1; ctx.fillStyle = '#ff8a3d'; ctx.fillRect(-7, -1, 5 + n % 3, 2); ctx.fillStyle = '#07101c'; ctx.fillRect(-3, -2, 7, 4); ctx.fillStyle = '#d6e2dc'; ctx.fillRect(-2, -1, 5, 2); ctx.fillStyle = '#ffb340'; ctx.fillRect(3, -1, 2, 2);
      } else if (kind === 2) {
        ctx.fillStyle = '#07101c'; ctx.fillRect(-3, -3, 6, 6); ctx.fillStyle = '#91b260'; ctx.fillRect(-2, -2, 4, 4); ctx.fillStyle = '#fff7e6'; ctx.fillRect(1, -4, 2, 2);
        if (n % ((p.life ?? 180) < 30 ? 4 : 12) < 2) { ctx.fillStyle = '#ffd166'; ctx.fillRect(3, -5, 2, 2); }
      } else {
        ctx.fillStyle = '#a8f3ff'; ctx.beginPath(); ctx.moveTo(5, 0); ctx.lineTo(-3, -3); ctx.lineTo(-3, 3); ctx.fill(); ctx.fillStyle = '#44566b';
        ctx.fillRect(-3, n % 4 < 2 ? -2 : 0, 5, 1); ctx.fillStyle = '#b07a45'; ctx.fillRect(-8, n % 3 - 1, 3, 2); ctx.fillRect(-12, -(n % 4), 2, 2);
      }
      ctx.restore();
    });
  }
  function aim(ctx, view, frame) {
    const n = number(frame, view);
    aims.forEach(a => {
      const seat = P.seats[a.seat ?? Math.floor((a.worm || 0) / 3)];
      function path(points, alpha) {
        if (!points?.length) return;
        ctx.globalAlpha = alpha; ctx.strokeStyle = seat.color; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.lineDashOffset = -(n % 14) / 2;
        ctx.beginPath(); points.forEach((p, i) => { const x = (p.x ?? p[0]) * 10, y = (p.y ?? p[1]) * 10; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
      }
      if (view.noWind !== false) path(a.noWindPoints || a.noWind, .2);
      const points = a.points || a.pts || a.path || []; path(points, .85);
      const last = a.land || points.at(-1); if (!last) return;
      const x = (last.x ?? last[0]) * 10, y = (last.y ?? last[1]) * 10;
      ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(x, y, [0, 20, 30, 10][a.kind || 1], 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
      // Label at the muzzle, above the worm name (which sits below the sprite), so the two never stack.
      const st = points[0];
      if (st) {
        const lx = (st.x ?? st[0]) * 10 + 9, ly = (st.y ?? st[1]) * 10 - 24;
        const label = `${P.weapons[a.kind || 1]?.short || 'RKT'} ${a.angle ?? ''}/${a.power ?? ''}`;
        ctx.globalAlpha = .85; ctx.fillStyle = '#07101c'; ctx.fillRect(lx - 2, ly - 8, label.length * 5.2 + 4, 11);
        ctx.globalAlpha = 1; ctx.fillStyle = seat.light || seat.color; ctx.font = '9px "Courier New", monospace'; ctx.textAlign = 'left';
        ctx.fillText(label, lx, ly);
      }
    });
    ctx.globalAlpha = 1;
  }
  prepare();
  return { prepare, update, background, terrain: drawTerrain, water, worms, projectiles, aim };
}
