#!/usr/bin/env python3
"""P01 visualizer · 本地 HTTP 服务（Python 3 stdlib，无第三方依赖）。

  python server/app.py [--game <p01-ballistic 题目包>] [--port 8765] [--no-open] [--host 127.0.0.1]

不给 --game（也没设 P01_GAME）时以「仅回放」模式启动：能看 traces/ 里已有的对局，
不能跑新对局。/api/run 会在本机编译并执行 bot 程序，所以默认只监听 127.0.0.1，
不要把它暴露到不受信任的网络。

路由：
  GET  /api/health       {ok, version, engine_ready, counts}
  GET  /api/catalog      {maps, bots, traces, presets}
  POST /api/run          {map, seed, bots[4]} -> {trace_url, meta, result}
  GET  /api/traces       样例 + 已生成 trace 列表
  GET  /api/trace?id=    trace JSON
  GET  /api/keymoments?id= 关键事件（开火/爆炸/击杀/涨水/终局）
  GET  /                 web/ 静态文件
  GET  /traces/...       traces/ 静态文件（样例）
  GET  /gen/...          server/traces/ 静态文件（生成产物）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog  # noqa: E402
import runner  # noqa: E402

ROOT = catalog.ROOT
WEB = ROOT / "web"
TRACES = catalog.ROOT / "traces"
GEN_TRACES = catalog.SERVER / "traces"
VERSION = "0.1.0"

# POST /api/run 串行锁：同一时刻只跑一局
RUN_LOCK = threading.Lock()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",
}


def json_bytes(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def safe_resolve(base: Path, rel: str) -> Path | None:
    """把 URL 相对路径解析到 base 内，防止路径穿越。"""
    rel = rel.lstrip("/")
    if "\x00" in rel:
        return None
    target = (base / rel).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        return None
    return target


def key_moments(trace: dict) -> list[dict]:
    """从 trace 提取关键事件（前端帧烘焙时再映射 frame）。"""
    out: list[dict] = []
    weapon = {1: "ROCKET", 2: "GRENADE", 3: "DRILL"}
    for rec in trace.get("rounds", []):
        r = rec.get("round", 0)
        shots = rec.get("shots", [])
        if shots:
            s = shots[0]
            out.append({
                "round": r, "tick": 0, "type": "fire", "seat": s.get("seat"),
                "label": f"R{r} P{s.get('seat')} {weapon.get(s.get('kind'), 'FIRE')}",
            })
        seen_explode = False
        for e in rec.get("events", []):
            t = e.get("type")
            if t == "explode" and not seen_explode:
                seen_explode = True
                out.append({
                    "round": r, "tick": e.get("tick", 0), "type": "explode",
                    "seat": e.get("owner_seat"),
                    "label": f"R{r} BOOM @({e.get('x')},{e.get('y')})",
                })
                for d in e.get("damage", []):
                    if d.get("killed"):
                        out.append({
                            "round": r, "tick": e.get("tick", 0), "type": "kill",
                            "seat": e.get("owner_seat"), "worm": d.get("worm"),
                            "label": f"R{r} KO worm {d.get('worm')}",
                        })
            elif t == "water":
                out.append({
                    "round": r, "tick": e.get("tick", 0), "type": "water",
                    "label": f"R{r} WATER -> {e.get('level')}",
                })
    res = trace.get("result", {})
    out.append({
        "round": res.get("rounds", 0), "tick": 0, "type": "final",
        "seat": res.get("winner"),
        "label": f"FINAL winner={res.get('winner')} {res.get('reason')}",
    })
    return out


def find_trace(stem: str) -> Path | None:
    """按 stem 在样例目录与生成目录里找 trace。"""
    for base in (catalog.SAMPLES_DIR, GEN_TRACES):
        if not base.is_dir():
            continue
        p = base / f"{stem}.json"
        if p.is_file():
            return p
    return None


def list_traces() -> list[dict]:
    out: list[dict] = []
    for s in catalog.list_sample_traces():
        out.append({
            "id": s.get("id"),
            "file": s.get("file"),
            "url": f"/api/trace?id={urllib.parse.quote(s.get('id', ''))}",
            "label": s.get("label") or s.get("id"),
            "map": s.get("map"),
            "seed": s.get("seed"),
            "bots": s.get("bots"),
            "source": "sample",
        })
    if GEN_TRACES.is_dir():
        for p in sorted(GEN_TRACES.glob("*.json")):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            m = d.get("meta", {})
            r = d.get("result", {})
            out.append({
                "id": p.stem,
                "file": f"/gen/{p.name}",
                "url": f"/api/trace?id={urllib.parse.quote(p.stem)}",
                "label": f"{m.get('map')} · s{m.get('seed')} · R{r.get('rounds', 0)}",
                "map": m.get("map"),
                "seed": m.get("seed"),
                "bots": m.get("bots"),
                "source": "generated",
            })
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "P01V/0.1"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------ 工具
    def log_message(self, fmt, *args):  # 静默默认日志，只保留错误
        pass

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code: int, obj):
        self._send(code, json_bytes(obj), "application/json; charset=utf-8")

    def _text(self, code: int, text: str, ctype="text/plain; charset=utf-8"):
        self._send(code, text.encode("utf-8"), ctype)

    def _static(self, base: Path, rel: str):
        target = safe_resolve(base, urllib.parse.unquote(rel))
        if target is None or not target.is_file():
            self._text(404, "not found")
            return
        ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        try:
            body = target.read_bytes()
        except OSError:
            self._text(404, "not found")
            return
        self._send(200, body, ctype)

    # ------------------------------------------------------------ GET
    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/health":
                return self._health()
            if path == "/api/catalog":
                return self._json(200, catalog.build_catalog())
            if path == "/api/traces":
                return self._json(200, {"traces": list_traces()})
            if path == "/api/trace":
                return self._api_trace(qs)
            if path == "/api/keymoments":
                return self._api_keymoments(qs)
            if path.startswith("/traces/"):
                return self._static(TRACES, path[len("/traces/"):])
            if path.startswith("/gen/"):
                return self._static(GEN_TRACES, path[len("/gen/"):])
            if path == "/" or path == "":
                return self._static(WEB, "index.html")
            return self._static(WEB, path)
        except Exception as exc:
            traceback.print_exc()
            return self._json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    def _health(self):
        engine_ready = runner.ENGINE_EXE.is_file()
        cat = catalog.build_catalog(include_submissions=False)
        self._json(200, {
            "ok": True,
            "version": VERSION,
            "engine_ready": engine_ready,
            "game": catalog.game_status(),
            "counts": {
                "maps": cat["counts"]["maps"],
                "bots": cat["counts"]["bots"],
                "submissions": catalog.count_submission_sources(),
                "traces": cat["counts"]["traces"],
            },
        })

    def _api_trace(self, qs):
        stem = (qs.get("id") or [""])[0]
        if not stem:
            return self._json(400, {"ok": False, "error": "missing id"})
        p = find_trace(stem)
        if p is None:
            return self._json(404, {"ok": False, "error": f"trace not found: {stem}"})
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:
            return self._json(500, {"ok": False, "error": str(exc)})
        self._json(200, data)

    def _api_keymoments(self, qs):
        stem = (qs.get("id") or [""])[0]
        if not stem:
            return self._json(400, {"ok": False, "error": "missing id"})
        p = find_trace(stem)
        if p is None:
            return self._json(404, {"ok": False, "error": f"trace not found: {stem}"})
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:
            return self._json(500, {"ok": False, "error": str(exc)})
        self._json(200, {"id": stem, "keyMoments": key_moments(data)})

    # ------------------------------------------------------------ POST
    def do_POST(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/run":
            return self._json(404, {"ok": False, "error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 1 << 20:
            return self._json(400, {"ok": False, "error": "bad body"})
        try:
            req = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as exc:
            return self._json(400, {"ok": False, "error": f"bad json: {exc}"})
        map_name = str(req.get("map") or "public4-01")
        try:
            seed = int(req.get("seed", 1))
        except (TypeError, ValueError):
            seed = 1
        bots = req.get("bots") or []
        if isinstance(bots, str):
            bots = [b.strip() for b in bots.split(",") if b.strip()]
        if len(bots) != 4:
            return self._json(400, {"ok": False, "error": "bots must be a list of 4"})
        labels = req.get("bot_labels")
        if not isinstance(labels, list) or len(labels) != 4:
            labels = None

        if not catalog.game_ready():
            return self._json(400, {"ok": False, "error":
                                    "replay-only mode: " + catalog.game_status()["hint"]})

        # 串行化：避免并发跑局互相抢 bot/引擎资源
        if not RUN_LOCK.acquire(timeout=120):
            return self._json(503, {"ok": False, "error": "server busy, try later"})
        try:
            key = hashlib.sha256(
                f"{map_name}|{seed}|{','.join(str(b) for b in bots)}".encode("utf-8")
            ).hexdigest()[:10]
            out = GEN_TRACES / f"{map_name}-s{seed}-{key}.json"
            try:
                trace = runner.run_match(
                    map_name, seed, [str(b) for b in bots], out,
                    bot_labels=[str(x) for x in labels] if labels else None,
                )
            except (runner.BotUnavailableError, runner.BadRequestError) as exc:
                return self._json(400, {"ok": False, "error": str(exc)})
            except runner.RunnerError as exc:
                return self._json(500, {"ok": False, "error": str(exc)})
        finally:
            RUN_LOCK.release()

        self._json(200, {
            "ok": True,
            "id": out.stem,
            "trace_url": f"/api/trace?id={urllib.parse.quote(out.stem)}",
            "file": f"/gen/{out.name}",
            "meta": trace["meta"],
            "result": trace["result"],
        })


def main() -> int:
    ap = argparse.ArgumentParser(description="P01 visualizer server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--game", default=None,
                    help="p01-ballistic 题目包目录（默认读环境变量 P01_GAME）")
    ap.add_argument("--submissions", action="append", default=None, metavar="DIR",
                    help="bot 源码根目录，可重复（默认读 P01_SUBMISSIONS）")
    args = ap.parse_args()
    if args.game or args.submissions:
        catalog.configure(game=args.game, submissions=args.submissions)

    # 首次启动确保引擎就绪（失败不阻塞，health 会报告）
    try:
        runner.build_engine()
    except Exception as exc:
        print(f"[warn] engine build: {exc}", file=sys.stderr)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"P01 visualizer serving at {url}")
    print(f"  web:  {WEB}")
    print(f"  api:  {url}api/health")
    gs = catalog.game_status()
    print(f"  game: {gs['path']}" if gs["ready"] else f"  game: (replay-only) {gs['hint']}")
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
