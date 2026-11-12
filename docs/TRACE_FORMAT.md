# Trace 格式（`p01viz/1`）

trace 是单个 JSON 文件，由 `server/runner.py` 生成，前端 `web/js/core/trace.js` 载入。本文依据 `runner.py`、引擎旁路日志的输出和样例 `traces/samples/demo-4seat.json` 整理。

约定：地图 96 x 54 格，4 席，每席 3 条虫，虫编号 0 到 11，`seat = worm // 3`。

## 顶层

```jsonc
{
  "schema": "p01viz/1",
  "meta":    { ... },
  "map":     { "grid": ["...54 行，每行 96 字符..."] },
  "initial": { ... },
  "rounds":  [ { ... }, ... ],
  "result":  { ... }
}
```

## `meta`

| 字段 | 说明 |
|---|---|
| `game` | 固定 `"p01-ballistic"` |
| `map` | 地图 id（文件名去扩展名），如 `public4-01` |
| `map_file` | 地图文件名 |
| `map_type` | 来自题目包 `maps4/manifest.json` 的 `type_code`，查不到则为空串 |
| `seed` | 种子 |
| `active_mask` | 当前固定为 `15`（4 席都参战） |
| `seats` | 当前固定为 `4` |
| `bots` | 按席位 0 到 3 的 bot id |
| `bot_labels` | 可选，显示名；缺省时前端用 `bots` 的大写 |
| `engine_hash` | `engine_trace.cpp` **源码**的 sha256 前 16 位，带 `sha256:` 前缀；不随编译器变化，可和仓库文件直接比对 |
| `engine_upstream` | 所基于的上游引擎版本说明（见 `server/trace_engine/UPSTREAM.md`） |
| `rules_hash` | 题目包 `RULES.md` 的 sha256 前 16 位（带前缀）；题目包里没有该文件时为空串 |
| `created` | 生成时间（本地时间，无时区） |
| `duration_ms` | 生成耗时 |
| `map_sha256` | 地图文件完整 sha256 |
| `events_file` | 仅在 runner 用 `--keep-events` 时出现 |

## `map.grid` 与地形字符

`map.grid` 是引擎 `GRID` 命令返回的开局地形，54 个字符串，每个 96 字符。前端把空气和可破坏泥土之外的字符都当作固定固体；具体字符含义属于题目规则，见题目包文档。前端中可破坏泥土字符与空气字符定义在 `web/js/core/util.js`。

## `initial`

开局状态：

| 字段 | 说明 |
|---|---|
| `t` | 恒为 0 |
| `round` | 当前轮号（开局为 1） |
| `wind` | 风，已减去协议里的偏移（范围约 -10 到 10） |
| `water` | 水位行号 |
| `over`、`winner`、`reason` | 是否结束、胜者席位（未结束为 -1）、原因（如 `RUNNING`） |
| `hp` | 4 席总 HP |
| `dealt` | 4 席累计伤害 |
| `bad` | 4 席累计违规计数 |
| `state_hash` | 引擎状态哈希（16 位十六进制） |
| `worms` | 12 条：`{id, seat, x, y, hp, grenades, drills, alive}` |
| `grid` | 同 `map.grid` |
| `orders` | 空对象 |
| `shots` | 空数组 |

## `rounds[]`

每个元素对应一次 `STEP`：

| 字段 | 说明 |
|---|---|
| `round` | 轮号，从 1 起 |
| `wind`、`water` | 本轮开始时的风和水位（若有 `round` 事件则以事件为准） |
| `orders` | `{"0": "...", "1": "...", "2": "...", "3": "..."}`，经清洗后实际提交给引擎的指令字符串 |
| `shots` | 本轮开火记录，见下 |
| `grid` | 本轮结算后的地形（54 行） |
| `events` | 引擎旁路事件，见下 |
| `end` | 轮末状态 |

指令字符串由段落用 `;` 分隔，形如 `0 M R; M R; M R; F ROCKET 56 48`：首个整数是行动的虫编号，`M`/`J` 为移动/跳跃，`F <武器> <角度> <力度>` 为开火。指令语法属于题目协议。

`shots[]` 项：`{seat, worm, kind, angle, power, x, y, fault}`。`kind`：1 火箭、2 手雷、3 钻头。`x, y` 是开火时该虫所在格，`fault` 是该席到目前为止的违规计数。只包含 runner 能从答案里解析出来、且开火时该虫存活的开火。

`end`：`{hp, dealt, worms, state_hash, over, winner, reason}`，其中 `worms` 为 12 项数组 `[x, y, hp, grenades, drills, alive]`（注意与 `initial.worms` 的对象形式不同，`alive` 为 0/1）。

## `events[]`

事件按引擎实际发生顺序排列，每项都有 `type` 和 `round`。坐标 `[x, y]` 是格整数；`spawn`、`vel` 以及 `tick` 事件里的 `x, y, vx, vy` 是 Q16.16 定点数（除以 65536 得到格或格每 tick）。`tick` 字段是本轮内的 tick：移动阶段为 0，投射物阶段从 1 起。

| type | 主要字段 | 说明 |
|---|---|---|
| `round` | `wind, water` | 本轮开始 |
| `move` | `pass, tick, seat, worm, from, to, kind` | 一次移动，`kind` 为 `M` 或 `J`；同一 `pass` 内的移动同时发生 |
| `settle` | `tick, phase, worm, from, to, fall, damage, hp, death` | 落地结算。`phase` 为 `move`（移动后）、`boom`（爆炸后）或 `water`（涨水后）；`death` 为 `null`、`"fall"` 或 `"water"` |
| `fire` | `tick, seat, worm, kind, angle, power, spawn, vel, life, buried` | 开火并生成投射物 |
| `tick` | `tick, proj[]` | 该 tick 所有活跃投射物，每项 `{slot, kind, x, y, vx, vy, age, life, stuck, dug}` |
| `bounce` | `tick, slot, x, y, axis_x, axis_y, vx, vy` | 手雷反弹；`x, y` 为格整数，`vx, vy` 为反弹后速度（Q16.16） |
| `dig` | `tick, slot, cell, dug` | 钻头挖掘，`cell` 为 `[x, y]`，`dug` 为累计挖掘数 |
| `explode` | `tick, x, y, radius, kind, owner_worm, owner_seat, damage[], destroyed[]` | 爆炸；`damage` 项 `{worm, dmg, hp, killed}`，`destroyed` 为被毁格的 `[x, y]` 列表 |
| `water` | `from, level, drowned[]` | 涨水，`drowned` 为淹死的虫编号 |
| `turn_end` | `hp, dealt, worms, state_hash, over, winner, reason` | 轮末快照，`worms` 同 `end.worms` 的数组形式 |

说明：

- `rounds[].grid` 是轮末地形；轮内地形请按 `explode.destroyed` 和 `dig.cell` 增量应用。
- 样例 `demo-4seat.json` 中出现的事件类型有 `round, move, settle, fire, tick, bounce, explode, turn_end`；`dig` 和 `water` 在该样例中没有出现，它们的字段依据引擎源码中的输出格式整理，其中 `dig` 的字段未用样例核对。
- `fire.buried` 为引擎给出的标志，含义由引擎定义，前端仅透传。

## `result`

| 字段 | 说明 |
|---|---|
| `winner` | 胜者席位，平局或无为 -1 |
| `reason` | 终局原因，如 `ELIMINATION`（样例）、`HP` |
| `rounds` | 实际打了几轮 |
| `hp`、`dealt` | 终局各席 HP 和累计伤害 |
| `state_hash` | 终局状态哈希 |
| `faults` | 各席 fault 次数（无效答案、超时等） |
| `dead_bots` | 进程已退出或无法启动的 bot id |

## 校验与兼容

- 前端载入时只检查并补齐必需字段（缺失的 `bots`、`bot_labels`、`hp`、`dealt` 等会补默认值），不会改写服务端文件。
- 同样的 (地图, seed, bots) 在引擎和 bot 都确定的情况下应得到相同的逐轮 `state_hash`；`scripts/verify_traces.py` 检查这一点。使用 `random4` 之类带随机的 bot 时，是否可重复取决于该 bot 自身，这里未验证。
- 样例索引 `traces/samples/index.json` 的结构为 `{schema: "p01viz-samples/1", count, samples: [{id, file, label, description, map, seed, bots, rounds, winner, reason, state_hash, bytes}]}`。
