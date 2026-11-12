# 架构

本文说明观战器的组成、数据流和 HTTP API。trace 文件本身的字段见 [TRACE_FORMAT.md](TRACE_FORMAT.md)，前端帧结构见 [FRAME_CONTRACT.md](FRAME_CONTRACT.md)，画面与音效见 [VISUAL.md](VISUAL.md)。

## 设计原则

- 权威状态只来自 C++ trace 引擎（`server/trace_engine/engine_trace.cpp`，题目公开引擎的拷贝，只增加旁路事件日志）。前端只消费 trace，不自行判定胜负，也不重新实现物理作为权威来源。
- 本程序不是裁判：runner 不统计 CPU 时间，也不做判罚，只复现引擎状态并记录每个 tick 的画面所需信息。
- 前端无依赖、无外链、无构建步骤；画面、精灵、音效全部程序化生成。
- 同一个 trace、同一个帧号，画面应当是确定性的（视觉随机一律来自带种子的伪随机，不用 `Math.random`）。Node 自测检查了这一点，浏览器端像素级一致性未做系统验证。

## 组成

```text
浏览器（vanilla JS + Canvas2D）
  index.html / main.js           页面、设置页、URL 参数、window.__P01V__
  js/core/trace.js               载入并规整 trace
  js/core/timeline.js            把 trace 烘焙成 60 fps 的确定性帧序列
  js/core/render.js, camera.js   图层注册与渲染循环、相机
  js/core/input.js, hud.js       键鼠输入、HUD 骨架与控件
  js/visual/*                    图层、特效、HUD 皮肤、音效
        |
        |  HTTP（默认 127.0.0.1:8765）
        v
Python 3 标准库服务
  app.py       静态文件 + /api
  catalog.py   题目包、地图、bot、样例目录
  runner.py    启动引擎与 4 个 bot 进程，拼装 trace
  trace_engine/engine_trace.cpp   引擎拷贝（g++ 编译，静态链接）
```

## 数据流

1. 前端 `POST /api/run`，带地图、seed 和 4 个 bot。
2. `runner.run_match` 先确保引擎已编译，再解析 bot（题目包里的二进制、演示 bot、`--submissions` 编译出的 bot，或直接给可执行文件路径）。
3. runner 启动引擎进程，发送 `LOAD <地图> <seed> 15`，读 `STATE` 与 `GRID`，再发送 `TRACE <事件文件>` 让引擎把旁路事件逐行写成 JSONL。
4. 每一轮：对每个仍有活虫的席位把 `TURN <seat> <行数>`、状态行和地形块写给对应 bot 进程，读回一行答案；答案经过清洗（和裁判口径一致），无效或超时则该席本轮改为 `<第一条活虫> WAIT` 并记一次 fault。四个答案用 `|` 拼起来发给引擎 `STEP`，读回新状态和地形。最多 40 轮，或引擎报告结束。
5. 结束后 runner 读事件文件，按 `round` 把事件挂到对应轮，连同每轮的指令、开火信息、轮末地形和状态一起写成单个 trace JSON（schema `p01viz/1`），并删除临时事件文件（命令行加 `--keep-events` 可保留）。
6. 前端取到 trace 后，`timeline.js` 烘焙成帧序列：每帧包含虫、投射物、地形版本、一次性特效、音频提示、瞄准弧、横幅等。渲染循环按播放头取帧，依次调用已注册图层。
7. 回放模式下（样例或之前生成的 trace）跳过 1 到 5 步，前端直接 `GET /api/trace` 或静态地址取得 trace。

bot 进程的协议、地图格式和规则属于 P01 题目本身，见题目包的文档，这里不重复。

## 前端要点

- 逻辑画布 960 x 540（96 x 54 格，每格 10 像素），CSS 放大并保持像素风。
- 帧率常量为 60；播放速度只改变每秒推进的帧数，不改变帧内容。可选速度 0.25、0.5、1、2、4。
- 地形：`map.grid` 是开局地形，轮内变化按 `explode.destroyed` 和 `dig.cell` 增量应用；`getTerrainSnapshot(frame)` 可得到任意帧的地形。
- 相机模式：`full`、`auto`、`follow:<seat>`、`manual`。
- 对外入口 `window.__P01V__`，见 [remotion/README.md](../remotion/README.md)。

## HTTP API

服务由 `server/app.py` 提供，所有 JSON 响应的 `Content-Type` 为 `application/json; charset=utf-8`，响应带 `Cache-Control: no-store`。

| 方法与路径 | 说明 |
|---|---|
| `GET /api/health` | `{ok, version, engine_ready, game, counts}`；`game` 为题目包状态 `{configured, ready, path, hint}`，`counts` 含 `maps`、`bots`、`submissions`、`traces` |
| `GET /api/catalog` | `{maps, bots, traces, presets, game, counts}`；会编译演示 bot 和 `--submissions` 里的 bot（有缓存），所以首次可能较慢 |
| `POST /api/run` | 请求体 JSON：`map`（默认 `public4-01`）、`seed`（默认 1）、`bots`（4 个 bot id 的数组，或逗号分隔字符串）、可选 `bot_labels`（4 个显示名）。成功返回 `{ok, id, trace_url, file, meta, result}`，trace 写到 `server/traces/<map>-s<seed>-<10 位哈希>.json` |
| `GET /api/traces` | `{traces: [...]}`，样例（`source: "sample"`）加已生成的 trace（`source: "generated"`） |
| `GET /api/trace?id=<id>` | 返回 trace JSON，id 为文件名去掉 `.json`，先找样例目录再找生成目录 |
| `GET /api/keymoments?id=<id>` | `{id, keyMoments}`，服务端从 trace 提取的关键事件，类型为 `fire`、`explode`、`kill`、`water`、`final`（无帧号） |
| `GET /traces/...` | 静态提供仓库 `traces/` 目录 |
| `GET /gen/...` | 静态提供 `server/traces/`（生成产物） |
| `GET /`、其他路径 | 静态提供 `web/` |

`/api/run` 的约束和行为：

- 请求体必须非空且不超过 1 MiB，`bots` 必须正好 4 个，否则 400。
- 未配置题目包（仅回放模式）时返回 400，错误信息以 `replay-only mode:` 开头。
- bot 或地图无法解析返回 400，runner 内部错误返回 500。
- 同一时刻只跑一局（互斥锁），等待超过 120 秒返回 503。
- 同一地图、seed、bot 组合会得到同名文件并覆盖之前的结果。
- 静态文件路径做了穿越保护。

注意：`/api/keymoments` 是服务端的简化版本；前端使用的关键事件由 `timeline.js` 烘焙时生成，带帧号，类型集合不同（见 [FRAME_CONTRACT.md](FRAME_CONTRACT.md)），通过 `__P01V__.getKeyMoments()` 取得。

## runner 命令行

runner 也可以单独使用，不经过服务：

```bat
python server\runner.py --game C:\path\to\p01-ballistic --map public4-01 --seed 1 --bots tide_hard,tide_normal,tide_easy,random4 --out my-trace.json
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--game` | 读 `P01_GAME` | 题目包目录 |
| `--map` | `public4-01` | 地图 id 或地图文件路径 |
| `--seed` | `1` | 种子 |
| `--bots` | `tide_hard,tide_normal,tide_easy,random4` | 4 个 bot，逗号分隔，可以是 id 或可执行文件路径 |
| `--bot-labels` | 空 | 写入 `meta.bot_labels` 的显示名 |
| `--out` | `server/traces/<map>-s<seed>-<哈希>.json` | 输出文件 |
| `--timeout` | `0.75` | 每席每轮等待 bot 回答的秒数 |
| `--verify` | 空 | 题目包裁判导出的回放 JSONL，逐轮比较 `state_hash`，不一致时进程返回 1 |
| `--keep-events` | 关 | 保留旁路事件 JSONL（在 `traces/.events/`） |
| `--force-engine` | 关 | 强制重新编译引擎 |
| `--list-maps`、`--list-bots` | | 列出可用地图 / bot 后退出 |

`python server\catalog.py` 会打印完整目录 JSON，可用 `--game`、`--no-submissions`、`--force`。

## 构建与缓存

- 引擎：`server/trace_engine/engine_trace(.exe)`，用 `g++ -O2 -std=c++17 -static` 编译；源码比可执行文件新时自动重编。
- bot：编译到 `server/cache/bots/<id>-<源码 sha256 前 12 位>(.exe)`，编译参数为 `g++ -O2 -std=c++17 -static`，如果有题目包则加 `-I <题目包>/public`。
- 以上构建产物、生成的 trace 和缓存都在 `.gitignore` 中。

## 平台

在 Windows 11 + MinGW-w64 g++ + Python 3.12 上验证过。代码里对 Linux 做了适配（可执行文件无 `.exe` 后缀，题目包 bot 目录用 `bin/linux`），没有在 Linux 上测试过。
