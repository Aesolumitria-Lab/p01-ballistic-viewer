const P = window.P01;
const ink = ['#fff7e6', '#ffd166', '#ff8a3d', '#a63a2a'];
const lifespan = { explode: 64, fire: 16, bounce: 22, dig: 28, water: 60, settle: 50, death: 80, drown: 62, hurt: 50, win: 130, result: 90 };

// Stepped pixel disc (row-quantized), keeps the hard-edged look for glows.
function disc(ctx, x, y, r, step = 3) {
  for (let dy = -r; dy <= r; dy += step) {
    const half = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)) / step) * step;
    if (half > 0) ctx.fillRect(Math.round(x - half), Math.round(y + dy), half * 2, step);
  }
}

// Fixed pool. Positions are analytic functions of the supplied frame, never integrated.
export function createEffects() {
  const pool = Array.from({ length: 400 }, () => ({}));
  let count = 0, active = [], current = 0, seed = 1, source = null, indexed = [];
  let cap = typeof navigator !== 'undefined' && navigator.hardwareConcurrency <= 4 ? 200 : 400;
  let waterBirths = [];
  const seen = new Map();
  const typeOf = e => e.type || e.event?.type;
  function buildIndex(frames) {
    indexed = [];
    frames.forEach((f, i) => (f.effects || []).forEach((raw, j) => {
      const e = raw.event || raw;
      indexed.push({ e, at: raw.startFrame ?? raw.frame ?? i, key: i * 97 + j });
    }));
    indexed.sort((a, b) => a.at - b.at);
  }
  function update(frame, view) {
    current = frame.frame ?? frame.index ?? view.frame ?? 0;
    seed = view.trace?.meta?.seed ?? 1;
    const frames = view.frames || view.timeline?.frames;
    if (source !== (frames || view.trace)) {
      source = frames || view.trace;
      seen.clear();
      indexed = [];
      waterBirths = [];
      if (frames) {
        buildIndex(frames);
        frames.forEach((f, i) => {
          if (f.phase === 'water' && frames[i - 1]?.phase !== 'water') waterBirths.push({ at: i, key: i * 97 + 96, e: { type: 'water', y: f.water, round: f.round } });
        });
      }
    }
    if (Array.isArray(frame.fxLive) && !frames) {
      active = frame.fxLive.map(e => ({ e, at: e.frame, key: e.id ?? e.frame }));
    } else if (frames) {
      let lo = 0, hi = indexed.length;
      while (lo < hi) { const m = (lo + hi) >>> 1; if (indexed[m].at <= current - 90) lo = m + 1; else hi = m; }
      active = [];
      for (let i = lo; i < indexed.length && indexed[i].at <= current; i++) active.push(indexed[i]);
    } else {
      // Cores can also supply timestamped effectHistory for random access.
      active = (frame.effectHistory || frame.effects || []).map((raw, j) => ({
        e: raw.event || raw, at: raw.startFrame ?? raw.frame ?? current, key: (raw.startFrame ?? raw.frame ?? current) * 97 + j
      }));
      for (const a of active) seen.set(a.key, a);
      active = Array.from(seen.values()).filter(a => a.at <= current && current - a.at < 90);
      if (seen.size > 1600) for (const [k, a] of seen) if (a.at < current - 90 || a.at > current) seen.delete(k);
    }
    for (const a of waterBirths) if (a.at <= current && current - a.at < 60) active.push(a);
    count = 0;
    for (const a of active) {
      const e = a.e, age = current - a.at, type = typeOf(e);
      if (age < 0 || age > (lifespan[type] || 0)) continue;
      const rng = P.util.rng((seed ^ a.key ^ ((e.round || 0) * 65537)) >>> 0);
      const x = (e.cell?.[0] ?? e.x ?? e.to?.[0] ?? 48) * 10 + 5;
      const y = (e.cell?.[1] ?? e.y ?? e.to?.[1] ?? frame.water ?? 48) * 10 + 5;
      const water = type === 'water' || type === 'drown' || e.cause === 'water' || (type === 'explode' && e.y >= frame.water - 1);
      const celebration = type === 'result' || type === 'win';
      if (type === 'hurt') continue;
      const n = type === 'explode' ? 34 : water ? 32 : celebration ? 90 : 10;
      for (let i = 0; i < n && count < cap; i++) {
        const angle = rng() * Math.PI * 2, speed = .4 + rng() * (type === 'explode' ? 3.2 : 1.6);
        const smoke = type === 'explode' && i >= 24;
        const p = pool[count++];
        p.age = age; p.life = smoke ? 64 : celebration ? 90 : 20 + rng() * 25;
        p.x = x + Math.cos(angle) * speed * age;
        p.y = y + (smoke ? -.35 * age : Math.sin(angle) * speed * age + .035 * age * age);
        if (water) { p.x = type === 'water' ? rng() * 960 : x + Math.cos(angle) * speed * age; p.y = y - Math.abs(Math.sin(angle)) * speed * age + .04 * age * age; }
        if (celebration) {
          const burst = i % 3, t = (age + burst * 23) % 80;
          p.x = [210, 480, 750][burst] + Math.cos(angle) * speed * t * 1.1;
          p.y = [110, 75, 130][burst] + Math.sin(angle) * speed * t + .012 * t * t;
          p.age = t; p.life = 80; p.visible = true;
        }
        p.color = smoke ? '#2a2f38' : water ? '#a8f3ff' : type === 'dig' ? '#b07a45' : celebration ? P.seats[i % 4].color : ink[i % 3];
        p.smoke = smoke; p.size = smoke ? 4 + age * .17 : 1 + (i % 3);
        // Retain the RNG sequence even when particles have expired.
        p.visible = celebration || age < p.life;
      }
    }
  }
  let screenFlash = 0;
  function draw(ctx, view, frame) {
    let flash = 0;
    const damageTexts = [];
    // Smoke goes underneath the fireball so it never blots the core.
    for (let i = 0; i < count; i++) {
      const p = pool[i]; if (!p.visible || !p.smoke) continue;
      ctx.globalAlpha = .42 * Math.min(1, Math.max(0, (p.age - 3) / 10)) * Math.max(0, 1 - p.age / p.life);
      ctx.fillStyle = p.color; ctx.fillRect(Math.round(p.x - p.size / 2), Math.round(p.y - p.size / 2), Math.round(p.size), Math.round(p.size));
    }
    // Additive light pass: explosions, muzzle flashes, splashes.
    ctx.globalCompositeOperation = 'lighter';
    for (const a of active) {
      const e = a.e, age = current - a.at;
      const x = (e.x ?? e.cell?.[0] ?? 48) * 10 + 5, y = (e.y ?? e.cell?.[1] ?? frame.water ?? 48) * 10 + 5;
      if (e.type === 'explode' && age >= 0 && age < 26) {
        const r = (e.radius || 2) * 10, k = 1 - age / 26;
        ctx.globalAlpha = .07 * k; ctx.fillStyle = '#ff8a3d'; disc(ctx, x, y, r * 2.4 * (.75 + age / 40), 6);
        ctx.globalAlpha = .12 * k; ctx.fillStyle = '#ffd166'; disc(ctx, x, y, r * 1.8, 4);
      }
      if (e.type === 'fire' && age >= 0 && age < 8) {
        const fx = e.spawn ? e.spawn[0] / 65536 * 10 : e.x * 10, fy = e.spawn ? e.spawn[1] / 65536 * 10 : e.y * 10;
        ctx.globalAlpha = .22 * (1 - age / 8); ctx.fillStyle = '#ffd166'; disc(ctx, fx, fy, 16, 3);
      }
      if (e.type === 'dig' && age >= 0 && age < 6) { ctx.globalAlpha = .18 * (1 - age / 6); ctx.fillStyle = '#ffb340'; disc(ctx, x, y, 8, 2); }
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    for (const a of active) {
      const e = a.e, age = current - a.at;
      const x = (e.x ?? e.cell?.[0] ?? 48) * 10 + 5, y = (e.y ?? e.cell?.[1] ?? frame.water ?? 48) * 10 + 5;
      if (e.type === 'explode' && age >= 0 && age < 30) {
        const r = (e.radius || 2) * 10;
        flash = Math.max(flash, .16 * Math.max(0, 1 - age / 4)); // gentle, warm, never full-white
        ctx.globalAlpha = Math.max(0, 1 - age / 30);
        ctx.strokeStyle = '#fff7e6'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, r * (.4 + age / 11), 0, Math.PI * 2); ctx.stroke();
        if (age < 12) {
          for (let k = 2; k >= 0; k--) {
            ctx.fillStyle = ink[Math.min(3, Math.floor(age / 4) + 2 - k)];
            const radius = Math.max(2, (r * (1 - age / 14)) * (k + 1) / 3);
            for (let dy = -radius; dy <= radius; dy += 3) {
              const half = Math.floor(Math.sqrt(Math.max(0, radius * radius - dy * dy)) / 3) * 3;
              ctx.fillRect(x - half, y + dy, half * 2 + 3, 3);
            }
          }
        }
      }
      if (e.type === 'fire' && age >= 0 && age < 4) {
        const fx = e.spawn ? e.spawn[0] / 65536 * 10 : e.x * 10;
        const fy = e.spawn ? e.spawn[1] / 65536 * 10 : e.y * 10;
        ctx.fillStyle = ink[0]; ctx.fillRect(fx - 4, fy - 4, 8, 8);
        ctx.fillStyle = ink[1]; ctx.fillRect(fx - 9 + age, fy - 1, 18 - age * 2, 2); ctx.fillRect(fx - 1, fy - 9 + age, 2, 18 - age * 2);
      }
      if (e.type === 'fire' && age >= 2 && age < 16) {
        const fx = e.spawn ? e.spawn[0] / 65536 * 10 : e.x * 10, fy = e.spawn ? e.spawn[1] / 65536 * 10 : e.y * 10;
        ctx.globalAlpha = .55 * (1 - age / 16); ctx.strokeStyle = '#93aec2'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(fx, fy - age * .4, 3 + age * .8, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
      }
      if ((e.type === 'water' || e.type === 'drown' || e.cause === 'water' || e.death === 'water') && age >= 0 && age < 45) {
        ctx.globalAlpha = 1 - age / 45; ctx.strokeStyle = '#a8f3ff';
        ctx.beginPath(); ctx.ellipse(x, y, 5 + age * 1.5, 2 + age * .2, 0, 0, Math.PI * 2); ctx.stroke();
      }
      const damage = e.type === 'hurt' ? [{ worm: e.worm, dmg: e.dmg }] : e.damage instanceof Array ? e.damage.filter(d => !frame.fxLive?.some(f => f.type === 'hurt' && f.worm === d.worm && f.frame === a.at)) : e.damage > 0 ? [{ worm: e.worm, dmg: e.damage }] : [];
      if (age >= 0 && age < 50) damage.forEach(d => {
        const w = frame.worms?.find(w => w.id === d.worm);
        if (w) damageTexts.push({ d, w, age });
      });
      if ((e.death || e.type === 'death') && age >= 0 && age < 50) {
        const w = frame.worms?.find(w => w.id === e.worm);
        if (w) { ctx.globalAlpha = 1 - age / 50; ctx.fillStyle = '#c8f7ff'; ctx.fillRect(w.x * 10 + 2, w.y * 10 - age * .7, 6, 7); }
      }
    }
    for (let i = 0; i < count; i++) {
      const p = pool[i]; if (!p.visible || p.smoke) continue;
      if ( (frame.grid || view.grid)?.[Math.floor(p.y / 10)]?.[Math.floor(p.x / 10)] === '#' && p.age > 5) continue;
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
      ctx.fillStyle = p.color; ctx.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.size), Math.round(p.size));
    }
    // Damage numbers last: never hide them under smoke/fire.
    // Stack labels that would collide (adjacent worms hit by one blast).
    ctx.textAlign = 'center';
    damageTexts.sort((p, q) => (p.w.x - q.w.x) || (p.w.id - q.w.id));
    const placed = [];
    for (const t of damageTexts) {
      const { d, w, age } = t, label = d.killed ? 'KO' : `-${d.dmg}`;
      const pop = age < 6 ? 1 + (6 - age) * .08 : 1;
      let tx = w.x * 10 + 5, ty = w.y * 10 - 9 - age * .45;
      for (const q of placed) if (Math.abs(q.x - tx) < 26 && Math.abs(q.y - ty) < 14) ty = q.y - 14;
      placed.push({ x: tx, y: ty });
      ctx.font = `bold ${Math.round((d.killed ? 15 : 12) * pop)}px "Courier New", monospace`;
      ctx.globalAlpha = Math.min(1, (50 - age) / 12);
      ctx.fillStyle = '#07101c'; ctx.fillText(label, tx + 1, ty + 1); ctx.fillText(label, tx - 1, ty + 1);
      ctx.fillStyle = d.killed ? '#ffd166' : '#ff7770'; ctx.fillText(label, tx, ty);
    }
    ctx.globalAlpha = 1;
    screenFlash = flash;
  }
  let vignette = null;
  function overlay(ctx) {
    if (!vignette) {
      // Pre-rendered vignette, quantized to 6px blocks and 6 alpha steps (pixel look).
      vignette = document.createElement('canvas'); vignette.width = 960; vignette.height = 540;
      const v = vignette.getContext('2d');
      for (let y = 0; y < 540; y += 6) for (let x = 0; x < 960; x += 6) {
        const dx = (x + 3 - 480) / 480, dy = (y + 3 - 270) / 270, d = Math.sqrt(dx * dx * .8 + dy * dy * .8);
        const step = Math.floor(Math.max(0, d - .62) / .09);
        if (step > 0) { v.fillStyle = `rgba(2,6,12,${Math.min(6, step) * .055})`; v.fillRect(x, y, 6, 6); }
      }
    }
    ctx.drawImage(vignette, 0, 0);
    if (screenFlash > .01) { ctx.fillStyle = `rgba(255,190,120,${screenFlash})`; ctx.fillRect(0, 0, 960, 540); }
  }
  function shake() {
    let power = 0;
    for (const a of active) {
      const age = current - a.at;
      if (age >= 0 && age < 14) power = Math.max(power, (a.e.type === 'explode' ? 5 : a.e.type === 'dig' ? 2 : a.e.type === 'water' ? 1 : 0) * (1 - age / 14));
    }
    const rng = P.util.rng(seed ^ (current * 1337));
    return { x: Math.round((rng() * 2 - 1) * power), y: Math.round((rng() * 2 - 1) * power) };
  }
  return { update, draw, overlay, shake, hurt: id => active.some(a => current - a.at < 4 && current >= a.at && ((a.e.type === 'hurt' && a.e.worm === id) || a.e.damage?.some?.(d => d.worm === id))),
    setQuality: low => { cap = low ? 200 : 400; }, stats: () => ({ particles: count, cap, events: active.length }) };
}
