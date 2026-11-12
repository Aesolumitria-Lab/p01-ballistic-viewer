#!/usr/bin/env python3
"""P01 visualization match runner.

Runs the traced engine + 4 bot processes for one map/seed, then assembles a
single self-contained trace JSON consumed by the web viewer.

This is intentionally NOT a judge: it does not score CPU time or faults. It
only needs to reproduce the engine's exact state and capture per-tick visuals.

Usage:
  python server/runner.py --map public4-01 --seed 1 \
      --bots tide_hard,tide_normal,tide_easy,random4 \
      --out traces/samples/demo-4seat.json

  python server/runner.py --map public4-01 --seed 1 --bots ... \
      --verify replays/public4-01-seed1-perm0123.jsonl

  python server/runner.py --list-maps
  python server/runner.py --list-bots
"""
from __future__ import annotations

import argparse
import hashlib
import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog  # noqa: E402

ROOT = catalog.ROOT
SERVER = catalog.SERVER
ENGINE_SRC = SERVER / "trace_engine" / "engine_trace.cpp"
ENGINE_EXE = SERVER / "trace_engine" / ("engine_trace" + catalog.EXE_SUFFIX)
# engine_trace.cpp 所基于的上游引擎（见 server/trace_engine/UPSTREAM.md）
ENGINE_UPSTREAM = "p01-ballistic 2.4.3 engine.cpp sha256:d864692e4c9ab0b6"
CACHE = catalog.CACHE
BOT_CACHE = catalog.BOT_CACHE
TRACES_DIR = catalog.ROOT / "traces"
EVENTS_DIR = TRACES_DIR / ".events"
W, H = 96, 54
SEATS = 4
WORMS_PER_SEAT = 3
NW = SEATS * WORMS_PER_SEAT
ROUNDS_MAX = 40
DEFAULT_TIMEOUT = 0.75
ENGINE_TIMEOUT = 30.0


class RunnerError(RuntimeError):
    """可预期的运行错误（映射/协议/引擎）。"""


class BotUnavailableError(RunnerError):
    """bot 无法解析或编译。"""


class BadRequestError(RunnerError):
    """调用方参数错误（地图不存在、bot 数量不对）。"""


# ---------------------------------------------------------------- 进程读取

class _LineReader(threading.Thread):
    """把子进程 stdout 读进队列，支持带超时的 readline。"""

    def __init__(self, stream):
        super().__init__(daemon=True)
        self.q: queue.Queue = queue.Queue()
        self.eof = False
        self._stream = stream

    def run(self):
        try:
            for line in self._stream:
                self.q.put(line)
        except Exception:
            pass
        finally:
            self.q.put(None)

    def readline(self, timeout: float) -> str | None:
        """返回去掉换行的行；超时返回 None；EOF 返回空字符串。"""
        try:
            item = self.q.get(timeout=timeout)
        except queue.Empty:
            return None
        if item is None:
            self.eof = True
            return ""
        return item.rstrip("\r\n")

    def drain(self) -> list[str]:
        out = []
        while True:
            try:
                item = self.q.get_nowait()
            except queue.Empty:
                break
            if item is None:
                self.eof = True
                break
            out.append(item.rstrip("\r\n"))
        return out


class BotProcess:
    def __init__(self, exe: Path, name: str):
        self.name = name
        self.exe = exe
        self.dead = False
        self.faults = 0
        self.exit_code: int | None = None
        self._err = ""
        try:
            self.p = subprocess.Popen(
                [str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, bufsize=1, encoding="utf-8",
                errors="replace",
            )
        except OSError as exc:
            self.dead = True
            self.exit_code = -1
            self.reader = None
            self.stdin = None
            self.faults = 1
            self._err = str(exc)
            return
        self.reader = _LineReader(self.p.stdout)
        self.reader.start()
        self.stdin = self.p.stdin

    def ask(self, block: str, timeout: float) -> str | None:
        """发送 TURN 块并读一行答案。None = 超时/崩溃。"""
        if self.dead or self.reader is None or self.stdin is None:
            return None
        # 丢弃上一回合的迟到答案，避免错位
        self.reader.drain()
        try:
            self.stdin.write(block)
            self.stdin.flush()
        except Exception:
            self.dead = True
            self.faults += 1
            return None
        line = self.reader.readline(timeout)
        if line is None:
            self.faults += 1
            return None
        if line == "":
            self.dead = True
            return None
        return line

    def close(self):
        if self.reader is not None:
            self.reader.drain()
        try:
            if self.stdin:
                self.stdin.close()
        except Exception:
            pass
        try:
            if self.p.poll() is None:
                self.p.kill()
        except Exception:
            pass


class Engine:
    def __init__(self, exe: Path):
        self.exe = exe
        self.p = subprocess.Popen(
            [str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1, encoding="utf-8",
            errors="replace",
        )
        self.reader = _LineReader(self.p.stdout)
        self.reader.start()

    def cmd(self, line: str, timeout: float = ENGINE_TIMEOUT) -> str:
        if self.p.stdin is None:
            raise RunnerError("engine stdin closed")
        try:
            self.p.stdin.write(line + "\n")
            self.p.stdin.flush()
        except Exception as exc:
            raise RunnerError(f"engine write failed: {exc}")
        out = self.reader.readline(timeout)
        if out is None:
            raise RunnerError(f"engine timeout waiting for: {line[:60]}")
        if out == "":
            raise RunnerError("engine closed stdout")
        return out

    def grid_rows(self) -> list[str]:
        """发送 GRID 并读取 G 行直到 GEND。"""
        if self.p.stdin is None:
            raise RunnerError("engine stdin closed")
        self.p.stdin.write("GRID\n")
        self.p.stdin.flush()
        rows: list[str] = []
        while True:
            line = self.reader.readline(ENGINE_TIMEOUT)
            if line is None:
                raise RunnerError("engine timeout reading GRID")
            if line == "":
                raise RunnerError("engine closed stdout during GRID")
            if line == "GEND":
                return rows
            if line.startswith("G "):
                rows.append(line[2:])

    def close(self):
        try:
            self.cmd("QUIT", timeout=2.0)
        except Exception:
            pass
        try:
            if self.p.poll() is None:
                self.p.kill()
        except Exception:
            pass


# ---------------------------------------------------------------- 编译

def _rules_hash() -> str:
    rules = catalog.GAME / "RULES.md" if catalog.GAME else None
    if rules is None or not rules.is_file():
        return ""
    return "sha256:" + catalog.sha256_file(rules)[:16]


def build_engine(force: bool = False) -> Path:
    ENGINE_EXE.parent.mkdir(parents=True, exist_ok=True)
    if not force and ENGINE_EXE.exists() and ENGINE_EXE.stat().st_mtime >= ENGINE_SRC.stat().st_mtime:
        return ENGINE_EXE
    cmd = ["g++", "-O2", "-std=c++17", "-static", str(ENGINE_SRC), "-o", str(ENGINE_EXE)]
    try:
        res = subprocess.run(cmd, cwd=str(ENGINE_SRC.parent), capture_output=True, text=True)
    except FileNotFoundError:
        raise RunnerError("g++ not found (needed to build the trace engine)")
    if res.returncode != 0:
        raise RunnerError(f"trace engine build failed:\n{res.stderr[:4000]}")
    return ENGINE_EXE


# ---------------------------------------------------------------- 协议解析

def parse_state(line: str) -> dict:
    t = line.split()
    if not t or t[0] != "STATE" or len(t) < 20 + NW * 6:
        raise RunnerError(f"bad STATE ({len(t)} tokens): {line[:120]}")
    return {
        "round": int(t[1]),
        "wind": int(t[2]) - 32,
        "water": int(t[3]),
        "over": int(t[4]),
        "winner": int(t[5]),
        "hp": [int(x) for x in t[6:10]],
        "dealt": [int(x) for x in t[10:14]],
        "reason": t[14],
        "bad": [int(x) for x in t[15:19]],
        "hash": t[19],
        "worms": [[int(x) for x in t[20 + i * 6: 26 + i * 6]] for i in range(NW)],
    }


def parse_worms(state: dict) -> list[dict]:
    out = []
    for i, w in enumerate(state["worms"]):
        out.append({
            "id": i, "seat": i // WORMS_PER_SEAT, "x": w[0], "y": w[1], "hp": w[2],
            "grenades": w[3], "drills": w[4], "alive": bool(w[5]),
        })
    return out


def grid_block(grid: list[str]) -> str:
    return "".join(f"GRID {row}\n" for row in grid) + "END\n"


def sanitize_answer(answer: str | None, seat: int) -> str | None:
    """与 judge4._sanitize_answer 保持一致，保证回放逐轮一致。"""
    if answer is None:
        return None
    text = answer.strip()
    if not text or "|" in text:
        return None
    parts = text.split(maxsplit=1)
    try:
        act = int(parts[0])
    except ValueError:
        return None
    if act < seat * WORMS_PER_SEAT or act >= seat * WORMS_PER_SEAT + WORMS_PER_SEAT:
        return None
    body = parts[1].strip() if len(parts) > 1 else "WAIT"
    return f"{act} {body}"


def first_live(state: dict, seat: int) -> int:
    for i in range(seat * WORMS_PER_SEAT, seat * WORMS_PER_SEAT + WORMS_PER_SEAT):
        if state["worms"][i][5]:
            return i
    return seat * WORMS_PER_SEAT


def seat_has_live(state: dict, seat: int) -> bool:
    return any(state["worms"][i][5]
               for i in range(seat * WORMS_PER_SEAT, seat * WORMS_PER_SEAT + WORMS_PER_SEAT))


def shots_from_answer(answer: str, seat: int, state: dict) -> list[dict]:
    """从答案里提取开火信息（与 judge4 同口径：仅活着的虫、支持段内 act 前缀）。"""
    out: list[dict] = []
    cur_wid: int | None = None
    for part in answer.split(";"):
        toks = part.split()
        if not toks:
            continue
        if toks[0].isdigit() and len(toks) >= 2:
            cur_wid = int(toks[0])
            toks = toks[1:]
        if cur_wid is None or len(toks) < 4 or toks[0] != "F":
            continue
        try:
            angle, power = int(toks[2]), int(toks[3])
        except ValueError:
            continue
        wid = cur_wid
        if wid < 0 or wid >= NW or not state["worms"][wid][5]:
            continue
        kind = {"ROCKET": 1, "GRENADE": 2, "DRILL": 3}.get(toks[1].upper())
        if kind is None:
            continue
        w = state["worms"][wid]
        out.append({
            "seat": seat, "worm": wid, "kind": kind, "angle": angle, "power": power,
            "x": w[0], "y": w[1], "fault": state["bad"][seat],
        })
    return out


# ---------------------------------------------------------------- events

def read_events(path: Path) -> list[dict]:
    events: list[dict] = []
    if not path.is_file():
        return events
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return events


def _events_path(map_name: str, seed: int, bot_names: list[str]) -> Path:
    key = f"{map_name}-s{seed}-" + hashlib.sha256(
        ",".join(bot_names).encode("utf-8")).hexdigest()[:10]
    return EVENTS_DIR / f"{key}.events.jsonl"


# ---------------------------------------------------------------- 主流程

def run_match(map_name: str, seed: int, bot_names: list[str], out_path: Path,
              timeout: float = DEFAULT_TIMEOUT, verify_path: Path | None = None,
              keep_events: bool = False, bot_labels: list[str] | None = None,
              force_engine: bool = False, progress=None) -> dict:
    """跑一局并组装 trace.json。返回 trace dict。

    progress: 可选回调 progress(stage: str, **info)。
    """
    if len(bot_names) != SEATS:
        raise BadRequestError(f"need exactly {SEATS} bots, got {len(bot_names)}")
    map_spec = catalog.get_map(map_name)
    if map_spec is None:
        raise BadRequestError(f"unknown map: {map_name}")
    map_path = catalog.MAPS4 / map_spec.file

    def prog(stage: str, **info):
        if progress is not None:
            progress(stage, **info)

    prog("engine", state="building")
    engine_exe = build_engine(force=force_engine)

    prog("bots", state="resolving", names=list(bot_names))
    specs = []
    for n in bot_names:
        try:
            spec = catalog.get_bot(n)
        except FileNotFoundError as exc:
            raise BotUnavailableError(str(exc))
        if not spec.ready or spec.exe is None:
            raise BotUnavailableError(f"bot not ready: {n}: {spec.error}")
        specs.append(spec)

    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    events_path = _events_path(map_spec.id, seed, bot_names)
    if events_path.exists():
        events_path.unlink()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    prog("match", state="starting", map=map_spec.id, seed=seed)
    t0 = time.time()
    engine = Engine(engine_exe)
    bots = [BotProcess(s.exe, s.id) for s in specs]
    rounds: list[dict] = []
    initial: dict = {}
    raw_state = ""
    try:
        ok = engine.cmd(f"LOAD {map_path.as_posix()} {seed} 15")
        if not ok.startswith("OK"):
            raise RunnerError(f"LOAD failed: {ok}")
        raw_state = engine.cmd("STATE")
        state = parse_state(raw_state)
        grid = engine.grid_rows()
        tr = engine.cmd(f"TRACE {events_path.as_posix()}")
        if not tr.startswith("OK"):
            raise RunnerError(f"trace open failed: {tr}")

        initial = {
            "t": 0, "round": state["round"], "wind": state["wind"],
            "water": state["water"], "over": bool(state["over"]),
            "winner": state["winner"], "hp": state["hp"], "dealt": state["dealt"],
            "reason": state["reason"], "bad": state["bad"],
            "state_hash": state["hash"], "worms": parse_worms(state), "grid": grid,
            "orders": {}, "shots": [],
        }

        for _ in range(ROUNDS_MAX):
            if state["over"]:
                break
            answers: list[str] = []
            round_shots: list[dict] = []
            for seat in range(SEATS):
                if not seat_has_live(state, seat):
                    answers.append(f"{first_live(state, seat)} WAIT")
                    continue
                block = (f"TURN {seat} {len(grid)}\n{raw_state}\n"
                         + grid_block(grid))
                raw = bots[seat].ask(block, timeout)
                ans = sanitize_answer(raw, seat)
                if ans is None:
                    bots[seat].faults += 1
                    ans = f"{first_live(state, seat)} WAIT"
                answers.append(ans)
                round_shots.extend(shots_from_answer(ans, seat, state))
            step = engine.cmd("STEP " + " | ".join(answers))
            if step.startswith("ERR"):
                raise RunnerError(f"STEP failed: {step}")
            raw_state = step
            state = parse_state(raw_state)
            grid = engine.grid_rows()
            rounds.append({
                "round": len(rounds) + 1,
                "wind": state["wind"],
                "water": state["water"],
                "orders": {str(s): answers[s] for s in range(SEATS)},
                "shots": round_shots,
                "grid": grid,
                "end": {
                    "hp": state["hp"], "dealt": state["dealt"],
                    "worms": state["worms"], "state_hash": state["hash"],
                    "over": bool(state["over"]), "winner": state["winner"],
                    "reason": state["reason"],
                },
            })
            prog("round", round=len(rounds), winner=state["winner"],
                 over=bool(state["over"]), hash=state["hash"])
        try:
            engine.cmd("TRACECLOSE", timeout=5.0)
        except RunnerError:
            pass
        result = {
            "winner": state["winner"], "reason": state["reason"],
            "rounds": len(rounds), "hp": state["hp"], "dealt": state["dealt"],
            "state_hash": state["hash"],
            "faults": [b.faults for b in bots],
            "dead_bots": [b.name for b in bots if b.dead],
        }
    finally:
        for b in bots:
            b.close()
        engine.close()

    events = read_events(events_path)
    by_round: dict[int, list[dict]] = {}
    for e in events:
        r = e.get("round")
        if isinstance(r, int):
            by_round.setdefault(r, []).append(e)
    for rec in rounds:
        rec["events"] = by_round.get(rec["round"], [])
        r0 = next((e for e in rec["events"] if e.get("type") == "round"), None)
        if r0:
            rec["wind"] = r0.get("wind", rec["wind"])
            rec["water"] = r0.get("water", rec["water"])

    meta = {
        "game": "p01-ballistic",
        "map": map_spec.id,
        "map_file": map_spec.file,
        "map_type": map_spec.type,
        "seed": seed,
        "active_mask": 15,
        "seats": SEATS,
        "bots": list(bot_names),
        # 源码哈希（不是可执行文件）：不随编译器变化，可与仓库里的文件直接比对
        "engine_hash": "sha256:" + catalog.sha256_file(ENGINE_SRC)[:16],
        "engine_upstream": ENGINE_UPSTREAM,
        "rules_hash": _rules_hash(),
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "duration_ms": int((time.time() - t0) * 1000),
        "map_sha256": catalog.sha256_file(map_path),
    }
    if bot_labels:
        meta["bot_labels"] = list(bot_labels)

    trace = {
        "schema": "p01viz/1",
        "meta": meta,
        "map": {"grid": initial["grid"]},
        "initial": initial,
        "rounds": rounds,
        "result": result,
    }

    out_path.write_text(
        json.dumps(trace, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")

    if verify_path is not None:
        trace["_verify"] = verify_against_replay(trace, Path(verify_path))

    if not keep_events:
        try:
            events_path.unlink()
        except OSError:
            pass
    else:
        meta["events_file"] = str(events_path)

    prog("done", rounds=len(rounds), winner=result["winner"],
         hash=result["state_hash"])
    return trace


# ---------------------------------------------------------------- verify

def verify_against_replay(trace: dict, replay_path: Path) -> dict:
    """逐轮对比 trace 与 judge4 --replay-dir 生成的 JSONL。"""
    rows = []
    with Path(replay_path).open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    turns = [r for r in rows if r.get("type") == "turn"]
    result = next((r for r in rows if r.get("type") == "result"), None)
    rounds = trace.get("rounds", [])
    mismatches: list[dict] = []
    compared = 0
    for i, rec in enumerate(rounds):
        if i >= len(turns):
            mismatches.append({"round": rec.get("round"), "reason": "missing replay turn"})
            continue
        t = turns[i]
        compared += 1
        got = rec.get("end", {}).get("state_hash")
        want = t.get("state_hash")
        if got != want:
            mismatches.append({"round": rec.get("round"), "state_hash": [got, want]})
            continue
        for key in ("hp", "dealt", "worms"):
            if t.get(key) is not None and t.get(key) != rec["end"].get(key):
                mismatches.append({"round": rec.get("round"), "field": key,
                                   "trace": rec["end"].get(key), "replay": t.get(key)})
                break
    final_ok = True
    if result is not None:
        final_ok = result.get("state_hash") == trace.get("result", {}).get("state_hash")
        if not final_ok:
            mismatches.append({"round": "final",
                               "state_hash": [trace.get("result", {}).get("state_hash"),
                                              result.get("state_hash")]})
    return {
        "ok": not mismatches and final_ok and compared == len(rounds),
        "replay": str(replay_path),
        "replay_turns": len(turns),
        "trace_rounds": len(rounds),
        "compared": compared,
        "mismatches": mismatches,
    }


# ---------------------------------------------------------------- CLI

def _print(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=1))


def main() -> int:
    ap = argparse.ArgumentParser(description="P01 visualizer match runner")
    ap.add_argument("--game", default=None,
                    help="p01-ballistic 题目包目录（默认读环境变量 P01_GAME）")
    ap.add_argument("--map", default="public4-01")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--bots", default="tide_hard,tide_normal,tide_easy,random4")
    ap.add_argument("--bot-labels", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    ap.add_argument("--verify", default="", help="judge4 replay JSONL，逐轮对比 state_hash")
    ap.add_argument("--keep-events", action="store_true")
    ap.add_argument("--force-engine", action="store_true")
    ap.add_argument("--list-maps", action="store_true")
    ap.add_argument("--list-bots", action="store_true")
    args = ap.parse_args()
    if args.game:
        catalog.configure(game=args.game)

    if args.list_maps:
        _print([m.to_json() for m in catalog.list_maps()])
        return 0
    if args.list_bots:
        _print([b.to_json() for b in catalog.list_bots()])
        return 0

    bots = [x.strip() for x in args.bots.split(",") if x.strip()]
    labels = [x.strip() for x in args.bot_labels.split(",") if x.strip()]
    if not args.out:
        key = hashlib.sha256(
            f"{args.map}|{args.seed}|{','.join(bots)}".encode("utf-8")).hexdigest()[:10]
        out = SERVER / "traces" / f"{args.map}-s{args.seed}-{key}.json"
    else:
        out = Path(args.out)
    try:
        trace = run_match(
            args.map, args.seed, bots, out,
            timeout=args.timeout,
            verify_path=Path(args.verify) if args.verify else None,
            keep_events=args.keep_events,
            bot_labels=labels or None,
            force_engine=args.force_engine,
        )
    except RunnerError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2

    summary = {
        "ok": True,
        "out": str(out),
        "map": trace["meta"]["map"],
        "seed": args.seed,
        "bots": bots,
        "rounds": len(trace["rounds"]),
        "winner": trace["result"]["winner"],
        "reason": trace["result"]["reason"],
        "state_hash": trace["result"]["state_hash"],
        "faults": trace["result"]["faults"],
        "dead_bots": trace["result"]["dead_bots"],
        "duration_ms": trace["meta"]["duration_ms"],
    }
    if "_verify" in trace:
        summary["verify"] = trace["_verify"]
        if not trace["_verify"]["ok"]:
            print(json.dumps(summary, ensure_ascii=False))
            return 1
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
