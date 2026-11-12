#!/usr/bin/env python3
"""P01 visualizer · 地图 / bot / 样例 trace 目录.

只读 P01 题目包 + 可选的 bot 源码目录，产出前端 /api/catalog 需要的数据。
bot 编译失败不阻塞：标记 ready:false 并记录 error。

本仓库不附带地图与 bot。题目包的位置由环境变量或命令行给出：

  P01_GAME         p01-ballistic 题目目录（解压后的选手包，或题库里的
                   problems/p01-ballistic），其下应有 public/maps4 等。
                   未设置时只能回放已有 trace，不能跑新对局。
  P01_SUBMISSIONS  可选。一个或多个 bot 源码根目录（用系统路径分隔符隔开）。
                   每个子目录里的 submission.cpp（或下一层的 submission.cpp）
                   会被编译成一个可选 bot，id 为子目录名。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
EXE_SUFFIX = ".exe" if os.name == "nt" else ""
# 题目包里 Windows 二进制在 bin/，Linux 二进制在 bin/linux/
_BIN_SUBDIR = "" if os.name == "nt" else "linux"

# 以下由 configure() 填充；GAME 为 None 表示「仅回放」模式。
GAME: Path | None = None
PUBLIC: Path | None = None
MAPS4: Path | None = None
MANIFEST: Path | None = None
BASELINES_BIN: Path | None = None
CHALLENGES_BIN: Path | None = None
SOURCE_ROOTS: list[Path] = []
DEMO_BOTS = SERVER / "demo_bots"
CACHE = SERVER / "cache"
BOT_CACHE = CACHE / "bots"
TRACES_DIR = ROOT / "traces"
SAMPLES_DIR = TRACES_DIR / "samples"
GEN_TRACES_DIR = SERVER / "traces"
SAMPLES_INDEX = SAMPLES_DIR / "index.json"



def configure(game: str | os.PathLike | None = None,
              submissions: list[str] | None = None) -> None:
    """设置题目包与 bot 源码目录。参数为 None 时读环境变量。"""
    global GAME, PUBLIC, MAPS4, MANIFEST, BASELINES_BIN, CHALLENGES_BIN
    global SOURCE_ROOTS, _manifest_cache, _manifest_mtime
    if game is None:
        game = os.environ.get("P01_GAME") or None
    if game:
        g = Path(game).expanduser()
        # 允许直接指到 public/ 这一层
        if not (g / "public").is_dir() and (g / "maps4").is_dir():
            g = g.parent
        GAME = g
        PUBLIC = g / "public"
        MAPS4 = PUBLIC / "maps4"
        MANIFEST = MAPS4 / "manifest.json"
        BASELINES_BIN = PUBLIC / "baselines" / "bin" / _BIN_SUBDIR
        CHALLENGES_BIN = PUBLIC / "challenges" / "bin" / _BIN_SUBDIR
    else:
        GAME = PUBLIC = MAPS4 = MANIFEST = None
        BASELINES_BIN = CHALLENGES_BIN = None
    if submissions is None:
        raw = os.environ.get("P01_SUBMISSIONS", "")
        submissions = [x for x in raw.split(os.pathsep) if x.strip()]
    SOURCE_ROOTS = [Path(x).expanduser() for x in submissions]
    _manifest_cache = None
    _manifest_mtime = 0.0


def game_ready() -> bool:
    """题目包已配置且公开地图目录存在。"""
    return MAPS4 is not None and MAPS4.is_dir()


def game_status() -> dict:
    if GAME is None:
        return {"configured": False, "ready": False, "path": "",
                "hint": "set P01_GAME (or pass --game) to a p01-ballistic package to run new matches"}
    return {"configured": True, "ready": game_ready(), "path": str(GAME),
            "hint": "" if game_ready() else f"public/maps4 not found under {GAME}"}


# 内置 bot 显示名（ baselines / challenges 里的名字即 id ）
BUILTIN_LABELS = {
    "random4": "RANDOM4",
    "tide_easy": "TIDE-EASY",
    "tide_normal": "TIDE-NORMAL",
    "tide_hard": "TIDE-HARD",
    "chimera": "CHIMERA",
    "pseudo": "PSEUDO",
    "typhon": "TYPHON",
    "spammer": "SPAMMER (DEMO)",
    "crasher": "CRASHER (DEMO)",
}

# 预设组合（4 席）
PRESETS = [
    {
        "id": "standard",
        "label": "标准 4 席",
        "map": "public4-01",
        "seed": 1,
        "bots": ["tide_hard", "tide_normal", "tide_easy", "chimera"],
        "description": "TIDE 三档 + CHIMERA，适合第一次观看",
    },
    {
        "id": "elite",
        "label": "精英对局",
        "map": "public4-02",
        "seed": 7,
        "bots": ["typhon", "pseudo", "chimera", "tide_hard"],
        "description": "挑战 bot 满编，节奏快、伤害高",
    },
    {
        "id": "showcase",
        "label": "全武器展示",
        "map": "public4-04",
        "seed": 9,
        "bots": ["spammer", "tide_normal", "spammer", "tide_easy"],
        "description": "SPAMMER 循环火箭/手雷/钻头，覆盖弹射与挖地",
    },
    {
        "id": "water",
        "label": "涨水局",
        "map": "public4-12",
        "seed": 11,
        "bots": ["tide_easy", "tide_normal", "tide_hard", "pseudo"],
        "description": "后期涨水，容易看到落水与终局",
    },
]


@dataclass
class BotSpec:
    id: str
    label: str
    kind: str            # builtin | demo | submission | file
    exe: Path | None = None
    source: Path | None = None
    ready: bool = True
    error: str = ""
    cached: bool = False

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "ready": self.ready,
            "error": self.error,
            "cached": self.cached,
        }


@dataclass
class MapSpec:
    id: str
    file: str
    type: str
    label: str
    air_percent: float = 0.0

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "file": self.file,
            "type": self.type,
            "label": self.label,
            "air_percent": self.air_percent,
        }


_manifest_cache: dict | None = None
_manifest_mtime: float = 0.0


def load_manifest() -> dict:
    """读取 maps4/manifest.json（带 mtime 缓存）。缺失时返回空 dict。"""
    global _manifest_cache, _manifest_mtime
    if MANIFEST is None:
        return {}
    try:
        mtime = MANIFEST.stat().st_mtime
    except OSError:
        return {}
    if _manifest_cache is not None and mtime == _manifest_mtime:
        return _manifest_cache
    try:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    _manifest_cache = data
    _manifest_mtime = mtime
    return data


def list_maps() -> list[MapSpec]:
    """108 张 public4 图 + manifest 的 type_code。"""
    man = load_manifest()
    by_file = {m.get("file"): m for m in man.get("maps", [])}
    out: list[MapSpec] = []
    if game_ready():
        for p in sorted(MAPS4.glob("*.txt")):
            m = by_file.get(p.name, {})
            type_code = m.get("type_code", "") or ""
            air = m.get("air_percent", 0.0)
            label = f"{p.stem} · {type_code}" if type_code else p.stem
            out.append(MapSpec(id=p.stem, file=p.name, type=type_code,
                               label=label, air_percent=air))
    return out


def get_map(name: str) -> MapSpec | None:
    """按 id / 文件名 / 路径解析地图。"""
    if Path(name).is_file():
        p = Path(name).resolve()
        return MapSpec(id=p.stem, file=p.name, type=map_type_of(p.name),
                       label=p.stem)
    for m in list_maps():
        if m.id == name or m.file == name:
            return m
    return None


def map_type_of(filename: str) -> str:
    man = load_manifest()
    for m in man.get("maps", []):
        if m.get("file") == filename:
            return m.get("type_code", "") or ""
    return ""


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _safe_cache_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)


def compile_bot(src: Path, bot_id: str, force: bool = False,
                kind: str = "submission") -> BotSpec:
    """编译一个 bot 源文件到缓存目录；失败不抛异常，标记 ready:false。"""
    BOT_CACHE.mkdir(parents=True, exist_ok=True)
    digest = sha256_file(src)[:12]
    exe = BOT_CACHE / f"{_safe_cache_name(bot_id)}-{digest}{EXE_SUFFIX}"
    spec = BotSpec(id=bot_id, label=BUILTIN_LABELS.get(bot_id, bot_id.upper()),
                   kind=kind, exe=exe, source=src)
    if exe.exists() and not force and exe.stat().st_mtime >= src.stat().st_mtime:
        spec.ready = True
        spec.cached = True
        return spec
    cmd = ["g++", "-O2", "-std=c++17", "-static"]
    if PUBLIC is not None:
        cmd += ["-I", str(PUBLIC)]      # arena4.hpp 来自题目包
    cmd += [str(src), "-o", str(exe)]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        spec.ready = False
        spec.error = "g++ not found"
        return spec
    except subprocess.TimeoutExpired:
        spec.ready = False
        spec.error = "compile timeout"
        return spec
    if res.returncode != 0:
        spec.ready = False
        spec.error = (res.stderr or res.stdout or "compile failed")[:800]
        return spec
    spec.ready = True
    spec.cached = exe.exists()
    return spec


def _scan_exe_dir(d: Path | None, kind: str) -> list[BotSpec]:
    out: list[BotSpec] = []
    if d is None or not d.is_dir():
        return out
    for p in sorted(d.iterdir()):
        if not p.is_file() or p.suffix.lower() != EXE_SUFFIX:
            continue
        bid = p.stem
        out.append(BotSpec(id=bid, label=BUILTIN_LABELS.get(bid, bid.upper()),
                           kind=kind, exe=p, ready=True))
    return out


def list_builtin_bots() -> list[BotSpec]:
    """题目包的 public/baselines/bin + public/challenges/bin，外加本仓库的 demo bot。

    demo bot 只带源码，首次用到时编译进 server/cache/bots/（需要题目包里的 arena4.hpp）。
    """
    out = _scan_exe_dir(BASELINES_BIN, "builtin")
    out += _scan_exe_dir(CHALLENGES_BIN, "challenge")
    if game_ready() and DEMO_BOTS.is_dir():
        for src in sorted(DEMO_BOTS.glob("*.cpp")):
            out.append(compile_bot(src, src.stem, kind="demo"))
    # 去重（demo 可能覆盖同名内置）
    seen: set[str] = set()
    uniq: list[BotSpec] = []
    for b in out:
        if b.id in seen:
            continue
        seen.add(b.id)
        uniq.append(b)
    return uniq


def _submission_source(d: Path) -> Path | None:
    """<d>/submission.cpp，否则 <d>/*/submission.cpp 里按名字排序的第一个。"""
    direct = d / "submission.cpp"
    if direct.is_file():
        return direct
    for sub_dir in sorted(x for x in d.iterdir() if x.is_dir()):
        cand = sub_dir / "submission.cpp"
        if cand.is_file():
            return cand
    return None


def _iter_submission_sources():
    seen: set[str] = set()
    for root in SOURCE_ROOTS:
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            if not d.is_dir() or d.name.lower() in seen:
                continue
            src = _submission_source(d)
            if src is None:
                continue
            seen.add(d.name.lower())
            yield d.name, src


def list_submission_bots(force: bool = False) -> list[BotSpec]:
    """扫描 P01_SUBMISSIONS 指定的目录并编译（带缓存）。"""
    if not game_ready():
        return []
    return [compile_bot(src, bid, force=force) for bid, src in _iter_submission_sources()]


def count_submission_sources() -> int:
    """只数目录不编译，给 /api/health 用。"""
    return sum(1 for _ in _iter_submission_sources())


def list_bots(include_submissions: bool = True, force: bool = False) -> list[BotSpec]:
    out = list_builtin_bots()
    if include_submissions:
        out += list_submission_bots(force=force)
    return out


def get_bot(name: str, include_submissions: bool = True) -> BotSpec:
    """解析 bot id / 路径。找不到抛 FileNotFoundError。"""
    if Path(name).is_file():
        p = Path(name).resolve()
        return BotSpec(id=p.stem, label=p.stem.upper(), kind="file", exe=p, ready=True)
    for b in list_builtin_bots():
        if b.id == name:
            return b
    if include_submissions:
        for b in list_submission_bots():
            if b.id == name:
                return b
    raise FileNotFoundError(f"unknown bot: {name}")


def list_sample_traces() -> list[dict]:
    """读 samples/index.json；缺失时按目录扫描兜底。"""
    if SAMPLES_INDEX.is_file():
        try:
            data = json.loads(SAMPLES_INDEX.read_text(encoding="utf-8"))
            if isinstance(data.get("samples"), list):
                return data["samples"]
        except Exception:
            pass
    out = []
    if SAMPLES_DIR.is_dir():
        for p in sorted(SAMPLES_DIR.glob("*.json")):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            m = d.get("meta", {})
            out.append({
                "id": p.stem,
                "file": f"/traces/samples/{p.name}",
                "label": p.stem,
                "map": m.get("map", ""),
                "seed": m.get("seed", 0),
                "bots": m.get("bots", []),
            })
    return out


def build_catalog(include_submissions: bool = True, force: bool = False) -> dict:
    maps = [m.to_json() for m in list_maps()]
    bots = [b.to_json() for b in list_bots(include_submissions, force)]
    samples = list_sample_traces()
    return {
        "maps": maps,
        "bots": bots,
        "traces": samples,
        "presets": PRESETS,
        "game": game_status(),
        "counts": {"maps": len(maps), "bots": len(bots), "traces": len(samples)},
    }


configure()


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="P01 visualizer catalog")
    ap.add_argument("--game", default=None, help="p01-ballistic 题目包目录（默认读 P01_GAME）")
    ap.add_argument("--no-submissions", action="store_true")
    ap.add_argument("--force", action="store_true", help="强制重编译 submission bot")
    args = ap.parse_args()
    if args.game:
        configure(game=args.game)
    print(json.dumps(build_catalog(not args.no_submissions, args.force),
                     ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
