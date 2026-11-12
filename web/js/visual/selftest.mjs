// Run: node --experimental-default-type=module web/js/visual/selftest.mjs
// Instrumented Canvas checks finite draw arguments and deterministic commands;
// it is deliberately NOT a browser screenshot or GPU/FPS benchmark.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.hidden = false; this._text = '';
    this.style = { setProperty: (k, v) => { this.attributes[k] = v; } };
    this.classes = new Set(); this.classList = { toggle: (key, on) => on ? this.classes.add(key) : this.classes.delete(key) };
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener() {}
  set textContent(t) { this._text = String(t); this.children = []; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
}
let surfaceId = 0;
class Surface extends Element {
  constructor() { super('canvas'); this.width = 960; this.height = 540; this.id = surfaceId++; this.ctx = new Context(this); }
  getContext() { return this.ctx; }
}
class Context {
  constructor(surface) {
    this.surface = surface; this.operations = []; this.pixels = new Map(); this.stack = [];
    this.fillStyle = '#000'; this.globalAlpha = 1; this.strokeStyle = '#000'; this.font = ''; this.lineWidth = 1;
    for (const name of ['translate','scale','rotate','setTransform','beginPath','moveTo','lineTo','arc','ellipse','stroke','fill','setLineDash','fillText']) this[name] = (...args) => this.record(name, args);
  }
  record(name, args) {
    for (const v of args) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${name} has nonfinite argument ${v}`);
    this.operations.push([name, args, this.fillStyle, this.strokeStyle, this.globalAlpha, this.font]);
  }
  fillRect(x,y,w,h) { this.record('fillRect', [x,y,w,h]); this.raster(x,y,w,h,this.fillStyle); }
  clearRect(x,y,w,h) { this.record('clearRect',[x,y,w,h]); this.raster(x,y,w,h,null); }
  raster(x,y,w,h,color) {
    // Offscreen dirty-cell fingerprints; subpixel smoke remains in the command log.
    if (this.surface === mainCanvas) return;
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(this.surface.height, Math.ceil(y+h)); j++)
      for (let i = Math.max(0, Math.floor(x)); i < Math.min(this.surface.width, Math.ceil(x+w)); i++) {
        const k = j * this.surface.width + i; if (color) this.pixels.set(k, color); else this.pixels.delete(k);
      }
    this.fingerprint = null;
  }
  digest() { return this.fingerprint ||= createHash('sha256').update(JSON.stringify([...this.pixels].sort((a,b)=>a[0]-b[0]))).digest('hex'); }
  drawImage(image,...args) { this.record('drawImage', [image.ctx.digest(), ...args]); }
  save() { this.stack.push([this.fillStyle,this.strokeStyle,this.globalAlpha,this.font,this.lineWidth]); }
  restore() { const s = this.stack.pop(); assert.ok(s, 'unbalanced restore'); [this.fillStyle,this.strokeStyle,this.globalAlpha,this.font,this.lineWidth] = s; }
}
const roots = new Map(['hud-top-info','hud-seats','hud-feed','hud-banner','hud-result'].map(k=>[k,new Element('div')]));
const mainCanvas = new Surface();
globalThis.window = globalThis;
globalThis.location = { search: '?muted=1' };
globalThis.localStorage = { getItem:()=>null, setItem(){} };
globalThis.document = {
  body: new Element('body'), getElementById: id=>roots.get(id),
  createElement: tag=>tag === 'canvas' ? new Surface() : new Element(tag), addEventListener(){}
};
await import('../shared/contracts.js');
const { default: visual } = await import('./index.js');
const { createTimeline } = await import('../core/timeline.js');
const { Renderer } = await import('../core/render.js');
const { createEffects } = await import('./effects.js');
visual.init({ canvas: mainCanvas });
assert.equal(await P01.visualReady, visual);
assert.equal(visual.audio.forced, true);
visual.audio.setMuted(false); assert.equal(visual.audio.muted, true);
const renderer = new Renderer(mainCanvas);
visual.registerLayers(renderer); visual.registerLayers(renderer);
assert.equal(renderer.layers.length, 8);
renderer.onFrame((f,p,v,m)=> { visual.onFrame(f,p,v,m); visual.renderHUD(f,v.trace,{frame:f.index}); });
const errors = [], originalError = console.error;
console.error = (...args)=>errors.push(args.map(String).join(' '));
const render = i => {
  mainCanvas.ctx.operations = [];
  renderer.drawAt(i, 'seek');
  assert.equal(mainCanvas.ctx.stack.length, 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  return createHash('sha256').update(JSON.stringify(mainCanvas.ctx.operations)).digest('hex');
};
for (const sample of ['demo-4seat']) {
  const path = fileURLToPath(new URL(`../../../traces/samples/${sample}.json`, import.meta.url));
  const trace = JSON.parse(readFileSync(path,'utf8')), timeline = createTimeline(trace);
  renderer.setTimeline(timeline);
  const types = new Set(timeline.frames.flatMap(f=>f.effects.map(e=>e.type)));
  const probes = [0, ...[...types].map(type=>timeline.frames.find(f=>f.effects.some(e=>e.type===type)).index), ...timeline.frames.filter((f,i)=>f.phase==='water' && timeline.frames[i-1]?.phase!=='water').map(f=>f.index), timeline.totalFrames-1];
  for (const index of probes) {
    const n = Math.min(index+4,timeline.totalFrames-1), first = render(n), hud = roots.get('hud-seats').textContent;
    render(0); render(timeline.totalFrames-1); assert.equal(render(n),first,`${sample}: random seek F${n}`);
    assert.equal(roots.get('hud-seats').textContent,hud);
    for (let i=Math.max(0,n-70);i<=n;i++) render(i);
    assert.equal(render(n),first,`${sample}: sequential vs seek F${n}`);
  }
  const fx = createEffects(); let maxParticles=0;
  for (const frame of timeline.frames) { fx.update(frame,{trace,timeline}); maxParticles=Math.max(maxParticles,fx.stats().particles); }
  assert.ok(maxParticles<=400); fx.setQuality(true);
  const boom = timeline.frames.find(f=>f.fxLive.filter(e=>e.type==='explode').length>1) || timeline.frames.find(f=>f.fxLive.length>2);
  fx.update(boom,{trace,timeline}); assert.ok(fx.stats().particles<=200);
  console.log(`PASS ${sample}: ${timeline.totalFrames} frames, ${probes.length} deterministic probes, peak pool ${maxParticles}/400, effects ${[...types].join(',')}`);
}
console.error = originalError;
console.log('PASS visual API, layer registration, finite drawing, HUD, random/sequential seek, pool caps, forced mute. Browser pixels/FPS/audio output not tested.');
