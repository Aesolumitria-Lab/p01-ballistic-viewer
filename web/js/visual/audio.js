// Procedural WebAudio. Never affects visuals; seek/idle never triggers sounds.
// Graph: voices -> panner -> bus -> (dry + reverb send) -> compressor -> master -> out
const P = window.P01;
const MASTER = .7;
export function createAudio() {
  const params = new URLSearchParams(location.search);
  let stored = false;
  try { stored = localStorage.getItem('p01.muted.v2') === '1'; } catch (error) { console.warn('P01: 静音偏好无法读取', error); }
  const forced = params.get('muted') === '1' || params.has('remotion') || !!window.__REMOTION__ || !!window.remotion;
  let muted = forced || stored, context = null, master = null, bus = null, noise = null, unlocked = false, warned = false;
  let ambient = null, ambientTimer = 0;

  function impulse(seconds, decay) {
    const rate = context.sampleRate, len = Math.floor(rate * seconds), buf = context.createBuffer(2, len, rate), rng = P.util.rng(4411);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (rng() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }
  function build() {
    context = new (window.AudioContext || window.webkitAudioContext)();
    master = context.createGain(); master.gain.value = muted ? 0 : MASTER;
    const comp = context.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = .003; comp.release.value = .25;
    bus = context.createGain();
    const verb = context.createConvolver(), send = context.createGain(), tone = context.createBiquadFilter();
    verb.buffer = impulse(1.8, 3.2); send.gain.value = .22; tone.type = 'lowpass'; tone.frequency.value = 3200;
    bus.connect(comp); bus.connect(send); send.connect(verb); verb.connect(tone); tone.connect(comp);
    comp.connect(master); master.connect(context.destination);
    noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = noise.getChannelData(0), rng = P.util.rng(98173);
    for (let i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
  }
  function start() {
    if (muted) return;
    if (!(window.AudioContext || window.webkitAudioContext)) { if (!warned) console.warn('P01: 此浏览器没有 WebAudio'); warned = true; return; }
    if (!context) build();
    context.resume().then(() => { unlocked = true; }, error => { console.warn('P01: 音频解锁失败', error); });
  }
  document.addEventListener('pointerdown', start, { passive: true });
  document.addEventListener('keydown', start);

  // pan: -1..1. Returns an input node that auto-disconnects after `life` seconds.
  function out(pan, life) {
    const node = context.createStereoPanner ? context.createStereoPanner() : context.createGain();
    if (node.pan) node.pan.value = Math.max(-1, Math.min(1, pan || 0));
    node.connect(bus);
    setTimeout(() => node.disconnect(), (life + .3) * 1000);
    return node;
  }
  function tone(freq, end, duration, gain, wave = 'sine', delay = 0, pan = 0, attack = .004) {
    const t = context.currentTime + delay, osc = context.createOscillator(), env = context.createGain();
    osc.type = wave; osc.frequency.setValueAtTime(freq, t); osc.frequency.exponentialRampToValueAtTime(Math.max(1, end), t + duration);
    env.gain.setValueAtTime(.0001, t); env.gain.exponentialRampToValueAtTime(gain, t + attack); env.gain.exponentialRampToValueAtTime(.0001, t + duration);
    osc.connect(env); env.connect(out(pan, delay + duration)); osc.start(t); osc.stop(t + duration + .02);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
  }
  // Filtered noise; `to` sweeps the filter frequency.
  function burst(duration, gain, cutoff, { type = 'lowpass', to = cutoff, q = .7, delay = 0, pan = 0, attack = .002 } = {}) {
    const t = context.currentTime + delay, src = context.createBufferSource(), env = context.createGain(), filter = context.createBiquadFilter();
    src.buffer = noise; filter.type = type; filter.Q.value = q;
    filter.frequency.setValueAtTime(cutoff, t); filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);
    env.gain.setValueAtTime(.0001, t); env.gain.exponentialRampToValueAtTime(gain, t + attack); env.gain.exponentialRampToValueAtTime(.0001, t + duration);
    src.connect(filter); filter.connect(env); env.connect(out(pan, delay + duration));
    src.start(t, (t * 7.31) % 1); src.stop(t + duration + .02);
    src.onended = () => { src.disconnect(); env.disconnect(); filter.disconnect(); };
  }

  // Low ocean/wind bed while playing; fades out when frames stop arriving.
  function ambientTick(wind) {
    if (!context || muted || forced) return;
    if (!ambient) {
      const src = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain(), lfo = context.createOscillator(), depth = context.createGain();
      src.buffer = noise; src.loop = true; filter.type = 'lowpass'; filter.frequency.value = 380; filter.Q.value = .4; gain.gain.value = 0;
      lfo.frequency.value = .11; depth.gain.value = 140; lfo.connect(depth); depth.connect(filter.frequency);
      src.connect(filter); filter.connect(gain); gain.connect(bus); src.start(); lfo.start();
      ambient = { filter, gain };
    }
    const t = context.currentTime, w = Math.min(10, Math.abs(wind || 0));
    ambient.gain.gain.setTargetAtTime(.05 + w * .007, t, .6);
    ambient.filter.frequency.setTargetAtTime(320 + w * 55, t, .8);
    clearTimeout(ambientTimer);
    ambientTimer = setTimeout(() => ambient && ambient.gain.gain.setTargetAtTime(0, context.currentTime, .35), 160);
  }

  let frameToken = null, played = new Set(), counts = new Map(), canPlay = true;
  function beginFrame(n, mode) { if (frameToken !== n) { frameToken = n; played.clear(); counts.clear(); } canPlay = mode === 'play'; }
  const LIMIT = { fire: 2, explode: 2, bounce: 2, dig: 1, ui: 1, fuse: 1, death: 2, splash: 2 };
  function play(raw) {
    if (muted || forced || !canPlay || !context || !unlocked || context.state !== 'running') return;
    if (played.has(raw)) return;
    played.add(raw);
    const cue = typeof raw === 'string' ? { type: raw } : raw;
    if (!cue) return;
    let type = ({ boom: 'explode', win: 'result', round: 'round', turn_end: 'tick', jump: 'jump' })[cue.cue || cue.type] || cue.type || cue.cue;
    if (type === 'death' && cue.cause === 'water') type = 'splash';
    const used = counts.get(type) || 0;
    if (used >= (LIMIT[type] ?? 3)) return;
    counts.set(type, used + 1);
    const pan = Number.isFinite(cue.x) ? (cue.x / 48 - 1) * .75 : 0;
    const v = Math.max(.15, 1 - (cue.distance || 0) / 120) / (used + 1);
    switch (type) {
      case 'fire':
        if (cue.kind === 2) { tone(180, 70, .12, .75 * v, 'triangle'); burst(.09, .5 * v, 900, { to: 300 }); }
        else if (cue.kind === 3) { tone(95, 140, .32, .4 * v, 'sawtooth'); burst(.3, .4 * v, 600, { type: 'bandpass', to: 2400, q: 3 }); }
        else { tone(130, 45, .2, .8 * v, 'triangle'); burst(.45, .6 * v, 700, { type: 'bandpass', to: 3800, q: 1.2, attack: .02 }); }
        break;
      case 'explode': {
        const big = (cue.radius || 2) >= 3 ? 1.25 : 1;
        tone(90 / big, 26, .8 * big, .95 * v, 'sine', 0, pan);
        tone(48, 22, .5, .5 * v, 'sine', .02, pan, .01);
        burst(.18, .9 * v, 6000, { to: 1200, pan });
        burst(.9 * big, .7 * v, 1800, { to: 120, pan, attack: .006 });
        burst(.6, .12 * v, 3000, { type: 'highpass', to: 5000, delay: .14, pan, attack: .05 }); // debris crackle
        break;
      }
      case 'bounce': {
        const s = Math.min(1, (cue.speed || 0) / 2);
        tone(420 + s * 700, 180, .06, .1 + s * .22, 'square', 0, pan);
        burst(.04, .15 + s * .2, 2600, { type: 'bandpass', q: 4, pan });
        break;
      }
      case 'dig': tone(120, 70, .14, .22, 'sawtooth'); burst(.12, .3, 900, { to: 250 }); break;
      case 'splash': burst(.7, .55, 2400, { to: 500 }); tone(70, 30, .4, .3); [0, .09, .2].forEach((d, i) => tone(500 + i * 220, 1100 + i * 300, .06, .09, 'sine', .12 + d)); break;
      case 'water': burst(1.6, .4, 220, { to: 90, attack: .3 }); tone(42, 34, 1.5, .35, 'sine', 0, 0, .25); burst(1.2, .14, 1600, { type: 'bandpass', to: 700, q: 2, delay: .3, attack: .2 }); break;
      case 'death': tone(660, 150, .4, .22, 'triangle'); tone(330, 80, .45, .14, 'square', .05); break;
      case 'ko': tone(220, 220, .09, .3, 'square'); tone(165, 165, .3, .28, 'square', .09); burst(.3, .2, 1500, { delay: .09, to: 300 }); break;
      case 'result': [262, 330, 392, 523, 659, 784].forEach((f, i) => tone(f, f, .26, .16, 'square', i * .11, (i % 2 ? .3 : -.3))); tone(1046, 1046, .7, .14, 'triangle', .66); tone(523, 523, .7, .1, 'triangle', .66); break;
      case 'fuse': tone(1250, 1100, .03, .09, 'square'); break;
      case 'round': tone(523, 523, .05, .14, 'square'); tone(784, 784, .07, .14, 'square', .06); break;
      case 'jump': tone(300, 620, .08, .07, 'square'); break;
      case 'tick': case 'ui': tone(560, 800, .04, .1, 'square'); break;
      default: break;
    }
  }
  function setMuted(value) {
    muted = forced || !!value;
    if (master) master.gain.setTargetAtTime(muted ? 0 : MASTER, context.currentTime, .03);
    try { localStorage.setItem('p01.muted.v2', muted ? '1' : '0'); } catch (error) { console.warn('P01: 静音偏好无法保存', error); }
    if (!muted) start();
  }
  return { play, setMuted, beginFrame, ambient: ambientTick, get muted() { return muted; }, get forced() { return forced; } };
}
