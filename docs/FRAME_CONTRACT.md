# 帧契约（核心与视觉层）

本文说明前端把 trace 烘焙成“帧”的结构，以及核心（`web/js/core/`）与视觉层（`web/js/visual/`）之间的分工。内容依据 `web/js/core/timeline.js`、`render.js` 和 `web/js/visual/index.js` 整理；若与代码不一致，以代码为准。

## 原则

- 一帧是可确定性重绘的最小状态。`seekFrame(n)` 后重绘应与顺序播放到第 n 帧一致。
- 核心负责：载入 trace、烘焙 `frames[]`、推进播放头、相机、输入、HUD 骨架、`window.__P01V__`。
- 视觉层负责：根据帧的状态和一次性事件绘制、播放音效、填充 HUD；不自己推进时间，不使用 `Math.random`（随机一律用 `P01.util.rng(seed)`）。
- 帧内容不依赖真实时间。速度只改变每秒推进的帧数。

## 烘焙入口

`bakeFrames(trace)` 返回：

| 字段 | 说明 |
|---|---|
| `frames` | 帧数组 |
| `totalFrames` | 总帧数 |
| `keyMoments` | 关键事件列表（带帧号） |
| `roundRanges` | 每轮的 `{round, start, end}` 帧范围 |
| `feed` | 事件流条目（带帧号） |
| `gridOps` | 地形增量操作，用于重建任意帧的地形 |
| `stats` | 汇总：帧数、轮数、开火、爆炸、击杀、弹射、挖掘格数、最大单发伤害、各席伤害、秒数 |
| `getTerrainSnapshot(i)` | 返回第 i 帧的地形（`{frame, version, rows}`） |

`Timeline` 类封装播放头与查询：`frameAt`、`seek`、`step`、`getFeed`、`roundAt`、`frameOfRound`、`nextMoment`、`getProjTrail`。

## `Frame` 对象

| 字段 | 说明 |
|---|---|
| `index` | 全局帧号，从 0 起 |
| `t` | 时间（秒），`index / 60` |
| `phase` | 阶段，取值见下表 |
| `round`、`roundIndex` | 当前轮号和轮下标 |
| `tick` | 本轮内的引擎 tick（移动阶段为 0，飞行阶段从 1 起） |
| `wind`、`water` | 风和水位 |
| `gridVersion` | 地形版本号，变化时视觉层需要重取地形 |
| `worms` | 12 条虫 `{id, seat, x, y, hp, grenades, drills, alive}`；移动动画期间 `x, y` 可能为插值后的小数 |
| `projs` | 当前活跃投射物 `{slot, kind, x, y, vx, vy, age, life, stuck, dug, seat}`，坐标和速度已从 Q16.16 转成格单位 |
| `effects` | 本帧新触发的一次性特效（出生事件） |
| `fxLive` | 仍在存活期内的特效列表，每项带 `id`、`type`、`frame`（出生帧）、`life`；视觉层据此在 seek 后重建特效 |
| `audio` | 本帧的音频提示，每项 `{cue, frame, ...}` |
| `banner` | 当前横幅 `{text, sub, tone}` 或 `null` |
| `aim` | 瞄准阶段每次开火的预测信息数组，或 `null` |
| `cameraHint` | 给相机的提示，如 `{mode: "action"}`、`{mode: "follow", seat}` 或 `null` |
| `hp`、`dealt` | 4 席总 HP 与累计伤害 |
| `stateHash`、`over`、`winner`、`reason` | 对应引擎状态 |
| `stats` | 到该帧为止的 `{shots, booms, kills, bounces}` |

### 阶段（`phase`）与默认时长

默认时长来自 `timeline.js` 的 `TIMING`，单位为帧：

| `phase` | 默认帧数 | 说明 |
|---|---|---|
| `intro` | 42 | 开场标题横幅 |
| `round` | 34（无移动无开火的空轮为 12） | 轮首横幅，风/水位 |
| `move` | 每个移动 pass 8 | 同一 pass 内的移动同时插值 |
| `settle` | 6 | 移动后的摔落/落地补充动画 |
| `aim` | 45 | 显示瞄准虚线与落点 |
| `fire` | 2 | 枪口火光 |
| `flight` | 每个引擎 tick 1 帧 | 按 `tick` 事件推进 |
| `impact` | 爆炸后停顿 5；有击杀时再加 20 | 爆炸与击杀特效 |
| `water` | 40 | 涨水 |
| `end` | 16（空轮 6） | 轮末结算 |
| `final` | 90 | 终局横幅 |

总帧数是各阶段之和，随对局而定，样例的帧数以实际烘焙为准。

### 瞄准信息（`aim[]` 项）

`seat, worm, kind, kindLabel, angle, power, from, spawn, vel, gravity, pts, withWind, noWind, land, radius, slot, fault, buried`。其中 `pts` 是引擎实际弹道（降采样），`withWind` 与 `noWind` 是前端用恒定重力和风加速度推算的参考弧线，`land` 是落点，`radius` 是武器爆炸半径（火箭 2、手雷 3、钻头 1）。视觉层只消费这些数据，不另算权威物理。

### 特效类型（`fxLive` / `effects` 的 `type`）

烘焙器产生的类型包括：`fire`、`explode`、`bounce`、`dig`、`hurt`、`death`、`drown`、`water`、`win`、`ko`、`settle`、`fault`（各自的默认存活帧数见 `FX_LIFE`）。具体字段以 `timeline.js` 中的 `addFx` 调用为准。

### 音频提示（`audio[].cue`）

`boom`、`bounce`、`death`、`dig`、`fire`、`jump`、`ko`、`round`、`water`、`win`、`turn_end`。

### 关键事件

`keyMoments` 每项含 `frame, round, tick, type, label, seat`，`type` 取值：`fire`、`explode`、`hurt`、`kill`、`water`、`end`。`__P01V__.getKeyMoments()` 返回这些字段。这与服务端 `/api/keymoments` 的简化版本不同（后者没有帧号，类型为 `fire/explode/kill/water/final`）。

## 渲染接口

- 图层注册：`P01.render.register({name, z, draw(ctx, view, frame), screen?})`。`screen: true` 的图层画在 960 x 540 屏幕坐标系，其余画在世界像素坐标系（1 格 = 10 像素，原点在地图左上）。
- `view` 包含：`camera`、`px`、`frame`、`trace`、`debug`、`fps`、`width`、`height`、`timeline`、`mode`、`renderer`。
- 视觉层入口（`P01.provideVisual(api)` 注册）：`init({canvas, hudRoots, palette})`、`registerLayers(renderer)`、`onFrame(frame, prevFrame, view, mode)`、`renderHUD(frame, trace, uiState)`、`showBanner(text, sub, durationMs)`、`showResult(result, trace)`、`audio`。
- 核心在每帧先绘制图层，再调用 `onFrame`。视觉层的第一个图层在绘制时就会按当前帧准备状态，因此 `onFrame` 只负责帧差事件（主要是音频），不会造成一帧延迟。
- `mode` 为 `play` 时才发声；seek、空闲重绘和重复截图不会重放音效。

### 绘制顺序（视觉层默认图层）

| z | 图层 |
|---|---|
| 0 | background |
| 10 | terrain |
| 15 | water |
| 20 | worms |
| 30 | projectiles |
| 40 | effects |
| 50 | aim |
| 60 | flash（屏幕层） |

另有核心的调试图层。若视觉层加载失败，核心使用 `fallback-visual.js` 的简化图层。

## 确定性要求

- 视觉层禁止 `Math.random`、用 `Date.now` 影响画面、未播种的粒子初速度、用真实时间积分的粒子。
- 粒子位置由出生帧和当前帧解析计算，不做逐帧积分；粒子池上限 400，低核设备或持续低帧率时降到 200。
- `web/js/visual/selftest.mjs` 用插桩 Canvas 检查乱序 seek 与顺序绘制的绘制指令一致。这不是浏览器像素比较；浏览器端截图一致性、真实音频输出和帧率均未做系统验证。
