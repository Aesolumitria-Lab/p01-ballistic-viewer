const P = window.P01;
const glyphs = ['O', '<>', '^', '#'];
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
function text(n, value) { if (!n) return; const s = String(value ?? ''); if (n.textContent !== s) n.textContent = s; }
const id = name => document.getElementById(name);

export function createHUD(audio) {
  let roots = {}, cards = [], readout = null, feedNode = null, bannerNode = null, resultRef = null, traceRef = null;
  let current = 0, bannerUntil = -1, lastFeed = '', stats = null, resultTable = null;
  const feedHistory = new Map();
  function init(input = {}) {
    roots = {
      top: id('hud-top-info') || input.top || input['hud-top'], seats: input.seats || input['hud-seats'] || id('hud-seats'),
      feed: input.feed || input['hud-feed'] || id('hud-feed'), banner: input.banner || input['hud-banner'] || id('hud-banner'),
      result: input.result || input['hud-result'] || id('hud-result')
    };
    if (roots.top) {
      readout = node('div', 'visual-readout');
      readout.append(node('span', 'visual-map'), node('strong', 'visual-round'), node('span', 'visual-wind'), node('span', 'visual-water'));
      const meter = node('span', 'wind-meter'); meter.setAttribute('aria-hidden', 'true');
      for (let i = -10; i <= 10; i++) { const tick = node('i'); tick.dataset.wind = i; meter.append(tick); }
      readout.append(meter);
      const ref = node('button', 'visual-reference', 'NO WIND'); ref.type = 'button'; ref.setAttribute('aria-pressed', 'true'); ref.title = '切换无风参考弹道';
      ref.addEventListener('click', () => { const on = ref.getAttribute('aria-pressed') !== 'true'; ref.setAttribute('aria-pressed', String(on)); document.dispatchEvent(new CustomEvent('p01:reference', { detail: on })); });
      readout.append(ref); roots.top.append(readout);
    }
    cards = [];
    if (roots.seats) {
      roots.seats.replaceChildren();
      P.seats.forEach(s => {
        const card = node('section', 'seat-card'); card.dataset.seat = s.id; card.style.setProperty('--seat-color', s.color);
        const head = node('div', 'seat-head'), chip = node('b', `seat-chip glyph-${s.glyph}`, glyphs[s.id]), name = node('strong', 'seat-name'), act = node('span', 'seat-act', 'ACT');
        head.append(chip, name, act); const worms = node('div', 'seat-worms');
        const rows = Array.from({ length: 3 }, (_, i) => {
          const row = node('div', 'seat-worm'), label = node('span', 'wno', `${s.id * 3 + i}`), bar = node('span', 'bar'), fill = node('i'), ammo = node('span', 'ammo');
          bar.append(fill); row.append(label, bar, ammo); worms.append(row); return { row, bar, fill, ammo, label };
        });
        const foot = node('div', 'seat-foot'), hp = node('span'), dealt = node('span'), alive = node('span'); foot.append(hp, dealt, alive);
        const arsenal = node('div', 'visual-arsenal');
        for (const kind of [1, 2, 3]) { const icon = node('span', `weapon-icon weapon-${kind}`); icon.title = P.weapons[kind].label; icon.setAttribute('aria-label', P.weapons[kind].label); arsenal.append(icon, node('small', '', P.weapons[kind].short)); }
        card.append(head, worms, arsenal, foot); roots.seats.append(card); cards.push({ card, name, act, rows, hp, dealt, alive });
      });
    }
    if (roots.feed) { feedNode = node('div', 'visual-feed'); roots.feed.replaceChildren(feedNode); roots.feed.setAttribute('aria-label', '对局事件流'); }
    if (roots.banner) { bannerNode = node('div', 'banner-box'); bannerNode.append(node('div', 'banner-main'), node('div', 'banner-sub')); roots.banner.replaceChildren(bannerNode); bannerNode.hidden = true; roots.banner.setAttribute('aria-live', 'polite'); }
  }
  function describe(e) {
    const seat = e.seat ?? e.owner_seat, who = seat === undefined ? '' : `P${seat} `;
    switch (e.type) {
      case 'fire': return `${who}${P.weapons[e.kind]?.short || 'FIRE'} ${e.angle}/${e.power}`;
      case 'explode': return `${who}命中 -${(e.damage || []).reduce((n, d) => n + d.dmg, 0)}${e.damage?.some(d => d.killed) ? ' KO' : ''}`;
      case 'bounce': return `GRN 弹射 · ${e.slot}`;
      case 'dig': return `DRL 挖掘 ${e.dug} 格`;
      case 'water': return `涨水 ${e.from} > ${e.level}`;
      case 'settle': return e.death ? `W${e.worm} ${e.death === 'water' ? '落水' : '阵亡'}` : e.damage ? `W${e.worm} 摔落 -${e.damage}` : '';
      case 'death': return `W${e.worm} 阵亡`;
      default: return e.label || '';
    }
  }
  function renderFeed(frame, uiState) {
    if (!feedNode) return;
    let entries = uiState.feed || frame.feed;
    if (entries) entries = entries.filter(e => (e.frame ?? 0) <= current).slice(-6);
    else {
      (frame.effects || []).forEach((raw, i) => { const e = raw.event || raw; if (describe(e)) feedHistory.set(`${current}:${i}`, { ...e, frame: current }); });
      entries = Array.from(feedHistory.values()).filter(e => e.frame <= current).sort((a, b) => a.frame - b.frame).slice(-6);
    }
    const key = entries.map(e => `${e.frame}:${e.text || describe(e.event || e)}`).join('|');
    if (key === lastFeed) return; lastFeed = key;
    feedNode.replaceChildren();
    entries.forEach(raw => {
      const e = raw.event || raw, row = node('div', 'feed-row'), seat = e.seat ?? e.owner_seat ?? raw.seat;
      row.style.setProperty('--feed-color', P.seats[seat]?.color || '#a8f3ff');
      row.append(node('b', 'fi', ({ fire: '>', explode: '*', bounce: '+', dig: '/', water: '~', death: 'x' })[e.type] || ':'), node('span', '', raw.text || describe(e)));
      feedNode.append(row);
    });
  }
  function computeStats(trace) {
    const out = P.seats.map(() => ({ damage: 0, kills: 0, shots: 0, hits: new Set(), bounce: 0, dug: 0, max: 0 }));
    for (const r of trace.rounds || []) for (const e of r.events || []) {
      const seat = e.owner_seat ?? e.seat ?? e.slot;
      const s = out[seat]; if (!s) continue;
      if (e.type === 'fire') s.shots++;
      if (e.type === 'explode') { const dmg = (e.damage || []).reduce((n, d) => n + d.dmg, 0); s.damage += dmg; s.kills += (e.damage || []).filter(d => d.killed).length; s.max = Math.max(s.max, dmg); if (dmg) s.hits.add(`${r.round}:${e.owner_worm}`); }
      if (e.type === 'bounce') s.bounce++;
      if (e.type === 'dig') s.dug++;
    }
    return out;
  }
  function showBanner(value, sub = '', durationMs = 1000) {
    if (!bannerNode || !value) return;
    text(bannerNode.children[0], value); text(bannerNode.children[1], sub);
    bannerUntil = current + Math.max(1, Math.ceil(durationMs * 60 / 1000)); bannerNode.hidden = false;
  }
  function showResult(result, trace) {
    if (!roots.result || !result || !trace) return;
    roots.result.hidden = false;
    if (resultRef === result && traceRef === trace && Array.from(roots.result.children).includes(resultTable)) return; resultRef = result;
    const winner = result.winner, seat = P.seats[winner];
    roots.result.style.setProperty('--winner-color', seat?.color || P.palette.gold);
    const title = node('div', 'result-title', seat ? `WINNER · P${winner}` : 'DRAW');
    const sub = node('div', 'result-sub', `${seat ? trace.meta.bot_labels?.[winner] || trace.meta.bots?.[winner] || '' : 'ALL SEATS'} / ${result.reason} / ${result.rounds} ROUNDS`);
    const table = node('table', 'visual-result-table');
    const header = node('tr'); ['SEAT', 'HP', 'DMG', 'KO', 'HIT', 'BNC', 'DIG', 'MAX'].forEach(t => header.append(node('th', '', t))); table.append(header);
    const computed = stats || computeStats(trace);
    computed.forEach((s, i) => { const row = node('tr'); row.style.color = P.seats[i].color; [glyphs[i] + ' P' + i, result.hp?.[i] ?? 0, result.dealt?.[i] ?? s.damage, s.kills, s.shots ? Math.round(s.hits.size / s.shots * 100) + '%' : '--', s.bounce, s.dug, s.max].forEach(t => row.append(node('td', '', t))); table.append(row); });
    resultTable = table;
    roots.result.replaceChildren(title, sub, table, node('div', 'result-sub', 'THE SEA KEEPS THE SCORE.'));
    // Core owns REMATCH / NEXT MAP / WATCH AGAIN in #core-result-bar.
  }
  function render(frame, trace, uiState = {}) {
    current = frame.frame ?? frame.index ?? uiState.frame ?? 0;
    if (traceRef !== trace) { traceRef = trace; stats = computeStats(trace); resultRef = null; feedHistory.clear(); lastFeed = ''; bannerUntil = -1; }
    if (readout) {
      text(readout.children[0], `${trace.meta.map || 'MAP'} / S${trace.meta.seed}`);
      text(readout.children[1], `ROUND ${String(frame.round || 1).padStart(2, '0')}/40`);
      text(readout.children[2], `WIND ${(frame.wind || 0) < 0 ? '<' : '>'} ${P.util.fmt(frame.wind || 0)}`);
      text(readout.children[3], `~ ${frame.water ?? 50} / ${frame.round < 30 ? 30 - frame.round : frame.round < 40 ? 2 - ((frame.round - 30) % 2) : 0}R`);
      const meter = readout.children[4]; for (const tick of meter.children) tick.classList.toggle('is-current', +tick.dataset.wind === Math.round(frame.wind || 0));
      meter.setAttribute('title', `风 ${P.util.fmt(frame.wind || 0)}`);
    }
    const aim = Array.isArray(frame.aim) ? frame.aim : frame.aim?.shots || (frame.aim ? [frame.aim] : []);
    cards.forEach((c, i) => {
      const worms = (frame.worms || []).filter(w => (w.seat ?? Math.floor(w.id / 3)) === i), alive = worms.filter(w => w.alive && w.hp > 0).length;
      const active = aim.some(a => (a.seat ?? Math.floor(a.worm / 3)) === i) || frame.activeSeat === i;
      c.card.classList.toggle('is-act', active); c.card.classList.toggle('is-dead', alive === 0); c.act.hidden = !active;
      text(c.name, trace.meta.bot_labels?.[i] || trace.meta.bots?.[i] || `SEAT ${i}`); c.name.title = c.name.textContent;
      c.rows.forEach((r, j) => {
        const w = worms[j]; if (!w) return;
        r.row.classList.toggle('is-dead', !w.alive || w.hp <= 0); r.fill.style.width = `${P.util.clamp(w.hp, 0, 100)}%`;
        r.bar.title = `W${w.id}: ${w.hp} HP`; r.bar.setAttribute('role', 'meter'); r.bar.setAttribute('aria-valuenow', w.hp); r.bar.setAttribute('aria-valuemin', '0'); r.bar.setAttribute('aria-valuemax', '100'); r.bar.setAttribute('aria-label', `虫 ${w.id} HP`);
        text(r.ammo, `G:${w.grenades ?? 0} D:${w.drills ?? 0}`);
      });
      text(c.hp, `HP ${frame.hp?.[i] ?? worms.reduce((n, w) => n + Math.max(0, w.hp), 0)}`); text(c.dealt, `DMG ${frame.dealt?.[i] ?? 0}`); text(c.alive, `${alive}/3`);
    });
    renderFeed(frame, uiState);
    const banner = typeof frame.banner === 'string' ? { text: frame.banner } : frame.banner;
    if (banner) {
      text(bannerNode?.children[0], banner.text || banner.main || '');
      text(bannerNode?.children[1], banner.sub || '');
      if (bannerNode) { bannerNode.hidden = false; bannerNode.style.setProperty('--banner-color', banner.tone === 'wind' ? '#a8f3ff' : '#ffd166'); }
    } else if (bannerNode) bannerNode.hidden = Object.hasOwn(frame, 'banner') || current >= bannerUntil;
    if (frame.phase === 'final' || frame.phase === 'result') showResult(trace.result, trace);
    else if (roots.result) { roots.result.hidden = true; resultRef = null; }
  }
  return { init, render, showBanner, showResult };
}
