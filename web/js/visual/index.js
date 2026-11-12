import { createScene } from './scene.js';
import { createEffects } from './effects.js';
import { createHUD } from './hud.js';
import { createAudio } from './audio.js';

const P = window.P01;
const audio = createAudio();
const effects = createEffects();
const scene = createScene(effects);
const hud = createHUD(audio);
let renderer = null, noWind = true, lastView = null, drawnView = null, lastAudioFrame = -1, lastTrace = null;
let lowFrames = 0;

function prepare(frame, view) {
  // Core invokes onFrame AFTER drawing. Prepare at the first layer as well.
  if (drawnView === view) return;
  drawnView = view; lastView = view; view.noWind = noWind;
  scene.update(frame, view); effects.update(frame, view);
  if (view.fps > 0 && view.fps < 50) lowFrames++; else lowFrames = Math.max(0, lowFrames - 1);
  if (lowFrames > 90) effects.setQuality(true);
}

const api = {
  name: 'deep-sea-pixel',
  init({ canvas, hudRoots = {}, palette = {} } = {}) {
    if (canvas) { canvas.getContext('2d').imageSmoothingEnabled = false; }
    scene.prepare(palette); hud.init(hudRoots);
    if (audio.forced) document.body.dataset.remotion = '1';
  },
  registerLayers(target) {
    if (renderer === target) return;
    renderer = target;
    const layers = [
      ['background', 0, scene.background], ['terrain', 10, scene.terrain], ['water', 15, scene.water],
      ['worms', 20, scene.worms], ['projectiles', 30, scene.projectiles], ['effects', 40, effects.draw], ['aim', 50, scene.aim]
    ];
    for (const [name, z, draw] of layers) target.register({ name: `pixel-${name}`, z, draw(ctx, view, frame) {
      prepare(frame, view); ctx.save();
      // Explosions already shake via core camera. Add only dig/water tremors.
      const shake = effects.shake();
      if (!view.camera?.shakeAmp) ctx.translate(shake.x, shake.y);
      draw(ctx, view, frame); ctx.restore();
    } });
    target.register({ name: 'pixel-flash', z: 60, screen: true, draw: ctx => effects.overlay(ctx) });
    target.onEnd?.(() => {
      // Core creates result buttons on end; restore visual statistics afterward.
      if (lastView?.trace) hud.showResult(lastView.trace.result, lastView.trace);
    });
  },
  onFrame(frame, prevFrame, view, mode = 'seek') {
    prepare(frame, view);
    const n = frame.index ?? frame.frame ?? 0;
    if (lastTrace !== view.trace) { lastTrace = view.trace; lastAudioFrame = -1; }
    audio.beginFrame(n, mode);
    // Seeking, idle redraws and repeat captures must never replay sounds.
    if (mode === 'play') audio.ambient?.(frame.wind);
    if (mode === 'play' && n > lastAudioFrame) {
      const from = prevFrame ? (prevFrame.index ?? prevFrame.frame) + 1 : n;
      const frames = view.timeline?.frames || view.frames;
      for (let i = Math.max(from, n - 12); i <= n; i++) {
        const f = frames?.[i] || (i === n ? frame : null);
        for (const cue of f?.audio || f?.audioCues || []) audio.play(cue);
      }
      for (const p of frame.projs || []) if (p.kind === 2 && p.life < 30 && Math.floor((prevFrame?.index ?? n - 1) / 8) !== Math.floor(n / 8)) audio.play('fuse');
    }
    lastAudioFrame = n;
  },
  renderHUD(frame, trace, uiState = {}) {
    hud.render(frame, trace, { ...uiState, feed: uiState.feed || lastView?.timeline?.getFeed(frame.index, 6) });
  },
  showBanner: hud.showBanner,
  showResult: hud.showResult,
  audio
};
document.addEventListener('p01:reference', e => { noWind = !!e.detail; renderer?.markDirty?.(); });
P.provideVisual(api);
export default api;
