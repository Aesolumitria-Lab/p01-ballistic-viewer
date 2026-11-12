# 引擎拷贝的来源与改动

`engine_trace.cpp` 和 `trig.hpp` 来自
[Aesolumitria-ai-arena](https://github.com/Aesolumitria-Lab/Aesolumitria-ai-arena)
的 `problems/p01-ballistic/public/engine/`（Apache-2.0，Copyright 2026 Aesolumitria-Lab）。

| 文件 | 上游文件 | 上游版本 | 上游 sha256 | 状态 |
|---|---|---|---|---|
| `engine_trace.cpp` | `engine.cpp` | p01-ballistic 2.4.3 | `d864692e4c9ab0b641d9518693c9dc301ff8c214c0c3d0c41fbb4b330e932671` | 有改动 |
| `trig.hpp` | `trig.hpp` | p01-ballistic 2.4.3 | 与上游逐字节相同（仅加了文件头） | 未改动 |

## 改了什么

只加了一条给观战器用的旁路事件日志：

- 新增命令 `TRACE <path>`（打开事件文件，追加写）和 `TRACECLOSE`；
- 在移动、落地、开火、弹道推进、反弹、挖地、爆炸、受伤、涨水等位置插入 `trace_emit(...)`，
  每行输出一个 JSON 事件；
- 为了在事件里带上回合/tick/阶段，加了几个只读的全局计数器。

模拟、状态哈希、判罚逻辑没有改动。没有发出 `TRACE` 命令时，引擎的输入输出与上游一致。

## 怎么核对

```bash
# 1) 看改动本身（去掉本仓库加的文件头后与上游 diff）
diff <P01_GAME>/public/engine/engine.cpp server/trace_engine/engine_trace.cpp

# 2) 行为对账：拿上游 judge4 的回放逐轮比 state_hash
python <P01_GAME>/public/judge/judge4.py --replay-dir replays ...
python scripts/verify_traces.py --replay-dir replays
```

## 上游升级时

题目包升级后，如果 `meta.json` 里的 `engine_hash` 不再是 `sha256:d864692e4c9ab0b6`，
这份拷贝就落后了：把上游新的 `engine.cpp` 合进来，更新上表、`engine_trace.cpp` 文件头
和 `server/runner.py` 里的 `ENGINE_UPSTREAM`，再跑一遍上面的对账。
