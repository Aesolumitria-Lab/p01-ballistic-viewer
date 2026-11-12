#!/usr/bin/env python3
"""P01 visualizer · 样例 trace 校验。

做两件事：
  1. 确定性：同 (map, seed, bots) 跑两次，逐轮 end.state_hash 与 result.state_hash 必须一致。
  2. 回放：--replay-dir 给定 judge4 --replay-dir 产物时，逐轮对比 state_hash。

用法：
  python scripts/verify_traces.py
  python scripts/verify_traces.py --replay-dir replays
  python scripts/verify_traces.py --samples traces/samples/index.json
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
import catalog  # noqa: E402
import runner  # noqa: E402

DEFAULT_SAMPLES = catalog.SAMPLES_INDEX


def _round_hashes(trace: dict) -> list[str]:
    return [r.get("end", {}).get("state_hash", "") for r in trace.get("rounds", [])]


def _run_once(map_name: str, seed: int, bots: list[str], out: Path) -> dict:
    return runner.run_match(map_name, seed, bots, out)


def _find_replay(replay_dir: Path, map_id: str, seed: int) -> Path | None:
    if not replay_dir.is_dir():
        return None
    for p in sorted(replay_dir.glob(f"{map_id}-seed{seed}-perm*.jsonl")):
        return p
    return None


def verify_sample(sample: dict, workdir: Path, replay_dir: Path | None,
                 keep: bool) -> dict:
    map_name = sample.get("map")
    seed = int(sample.get("seed", 1))
    bots = sample.get("bots") or []
    sid = sample.get("id", "?")
    res: dict = {"id": sid, "map": map_name, "seed": seed, "bots": bots,
                 "deterministic": False, "replay": None, "ok": False,
                 "error": ""}
    if not map_name or len(bots) != 4:
        res["error"] = "sample meta incomplete"
        return res
    try:
        out1 = workdir / f"{sid}.a.json"
        out2 = workdir / f"{sid}.b.json"
        t1 = _run_once(map_name, seed, bots, out1)
        t2 = _run_once(map_name, seed, bots, out2)
        h1, h2 = _round_hashes(t1), _round_hashes(t2)
        r1, r2 = t1["result"]["state_hash"], t2["result"]["state_hash"]
        res["deterministic"] = (h1 == h2 and r1 == r2)
        res["state_hash"] = r1
        res["rounds"] = len(h1)
        if not res["deterministic"]:
            res["error"] = "two runs differ"
        else:
            rp = _find_replay(replay_dir, map_name, seed) if replay_dir else None
            if rp is not None:
                t3 = runner.run_match(map_name, seed, bots,
                                      workdir / f"{sid}.v.json",
                                      verify_path=rp)
                v = t3.get("_verify", {})
                res["replay"] = v
                res["ok"] = bool(v.get("ok"))
                if not res["ok"]:
                    res["error"] = f"replay mismatch: {v.get('mismatches', [])[:3]}"
            else:
                res["ok"] = True
        if not keep:
            for p in (out1, out2, workdir / f"{sid}.v.json"):
                try:
                    p.unlink()
                except OSError:
                    pass
    except Exception as exc:
        res["error"] = f"{type(exc).__name__}: {exc}"
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description="P01 trace verifier")
    ap.add_argument("--game", default=None,
                    help="p01-ballistic 题目包目录（默认读环境变量 P01_GAME）")
    ap.add_argument("--samples", default=str(DEFAULT_SAMPLES))
    ap.add_argument("--replay-dir", default="")
    ap.add_argument("--keep", action="store_true", help="保留临时 trace")
    ap.add_argument("--json", default="", help="把报告写到该 JSON 文件")
    args = ap.parse_args()
    if args.game:
        catalog.configure(game=args.game)
    if not catalog.game_ready():
        print("P01 package not configured: " + catalog.game_status()["hint"])
        return 2

    samples_path = Path(args.samples)
    if samples_path.is_file():
        data = json.loads(samples_path.read_text(encoding="utf-8"))
        samples = data.get("samples", [])
    else:
        samples = catalog.list_sample_traces()
    if not samples:
        print("no samples found")
        return 1

    replay_dir = Path(args.replay_dir) if args.replay_dir else None
    workdir = ROOT / "traces" / ".verify"
    workdir.mkdir(parents=True, exist_ok=True)

    results = [verify_sample(s, workdir, replay_dir, args.keep) for s in samples]
    ok = all(r["ok"] for r in results)
    report = {
        "ok": ok,
        "samples": len(results),
        "replay_dir": str(replay_dir) if replay_dir else "",
        "results": results,
    }
    for r in results:
        status = "PASS" if r["ok"] else "FAIL"
        extra = ""
        if r.get("replay"):
            extra = f" replay={r['replay'].get('compared')}/{r['replay'].get('trace_rounds')}"
        print(f"[{status}] {r['id']:<18} {r['map']} s{r['seed']} "
              f"R{r.get('rounds', 0)} hash={r.get('state_hash', '')[:16]} "
              f"det={r['deterministic']}{extra} {r.get('error', '')}")
    print(f"\n{'ALL PASS' if ok else 'HAS FAILURES'} ({len(results)} samples)")
    if args.json:
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=1),
                                   encoding="utf-8")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
