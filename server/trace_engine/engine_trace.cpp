// SPDX-License-Identifier: Apache-2.0
//
// engine_trace.cpp — MODIFIED COPY of the P01 BALLISTIC reference engine.
//
//   Upstream : Aesolumitria-ai-arena, problems/p01-ballistic/public/engine/engine.cpp
//              p01-ballistic v2.4.3, sha256 d864692e4c9ab0b641d9518693c9dc301ff8c214c0c3d0c41fbb4b330e932671
//   Copyright 2026 Aesolumitria-Lab. Licensed under the Apache License, Version 2.0
//   (see LICENSE and NOTICE at the repository root).
//
// Changes made for p01-ballistic-viewer (2026-11):
//   * added a side-channel event log for the viewer: the TRACE <path> / TRACECLOSE
//     commands and the trace_emit() calls placed along the simulation;
//   * no change to simulation, state hashing or fault rules. With TRACE off the
//     engine answers exactly like upstream; scripts/verify_traces.py --replay-dir
//     compares per-round state hashes against upstream judge4 replays.
// The exact diff is described in UPSTREAM.md next to this file.
//
// ---- original header follows ----
// P01 BALLISTIC · deterministic engine
//
// 这道题的难点只有一个：**确定性**。
//   - 全程定点 Q16.16，不用 float / double / sin / cos；
//   - 三角表是编译期常量（trig.hpp）；
//   - 弹道推进用"起点→终点线性插值 + 动态子步"，纯整数，无累积误差；
//   - 同时移动先声明意图再统一解碰；爆炸按轮次奇偶确定优先序。
//
// 协议：
//   LOAD <map_path> <seed>            -> OK <hash> <first_seat>
//   STEP <act0> <act1> <cmds0> <cmds1>-> STATE ...
//   INFO                              -> 地图要素
//   QUIT
//
// 指令是一条字符串，动作用 ';' 分隔，例如 "M R; M R; F ROCKET 135 72"。
// 引擎不校验字符串格式（那是裁判的事），只按语义执行并回报 bad 标志。

#include <algorithm>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "trig.hpp"

using namespace std;

// ---------------------------------------------------------------- 可视化 trace
// 只写给观战器用的旁路日志；不参与任何模拟/哈希。文件由 TRACE <path> 打开（append），
// 每行一个 JSON 对象。runner 负责把 meta/map/initial/turn_end/result 拼成最终 trace.json。
static FILE *g_trace = nullptr;
static int g_ev_round = 0;
static int g_ev_tick = 0;
static int g_ev_pass = 0;
static const char *g_settle_phase = "move";

static void trace_emit(const char *fmt, ...) {
    if (!g_trace) return;
    va_list ap;
    va_start(ap, fmt);
    vfprintf(g_trace, fmt, ap);
    va_end(ap);
    fputc('\n', g_trace);
    fflush(g_trace);
}

static void trace_open(const string &path) {
    if (g_trace) { fclose(g_trace); g_trace = nullptr; }
    g_trace = fopen(path.c_str(), "ab");
}

static void trace_close() {
    if (g_trace) { fclose(g_trace); g_trace = nullptr; }
}

static const int W = 96;
static const int H = 54;
static const int ROUNDS = 40;
static const int SEATS = 4;
static const int WORMS_PER_SEAT = 3;
static const int NW = SEATS * WORMS_PER_SEAT;   // 12 worms
static const int WORM_HP = 100;
static const int AP_MAX = 3;
static const int START_WATER = 50;
static const int Q = 65536;         // Q16.16 的 1.0
static const int GRAVITY = 655;     // 0.01 格/tick^2
static const int WIND_UNIT = 8;
static const int FALL_SAFE = 3;
static const int FALL_DAMAGE = 10;
static const int MAX_TICKS = 600;

// Q16.16 -> 整数格坐标。显式 floor，不用 `>> 16`。
//
// 有符号数右移在 C++17 是实现定义（C++20 才定为算术右移）。GCC/Clang/MSVC
// 的行为恰好一致，但"恰好一致"和"保证一致"是两回事——跨平台确定性是这道题
// 存在的理由，不能建立在实现巧合上。
static inline int64_t floor16(int64_t v) {
    return v >= 0 ? (int64_t)((uint64_t)v >> 16) : -(((-v) + 65535) >> 16);
}

static inline int64_t qmul(int64_t a, int64_t b) { return floor16(a * b); }
static inline int64_t abs64(int64_t v) { return v < 0 ? -v : v; }

struct Worm {
    int x = 0, y = 0;
    int hp = WORM_HP;
    int grenades = 2;
    int drills = 2;
    bool alive = true;
};

enum Kind { K_ROCKET = 1, K_GRENADE = 2, K_DRILL = 3 };

struct Proj {
    bool active = false;
    int kind = 0;
    int owner = -1;
    int64_t x = 0, y = 0;
    int64_t vx = 0, vy = 0;
    int life = 0;
    int age = 0;
    int dug = 0;
    bool stuck = false;
};

struct BoomEvent {
    bool pending = false;
    int x = 0, y = 0;
    int kind = 0;
    int owner = -1;
};

struct Game {
    vector<string> grid;          // '#' 泥土 / 'X' 基岩 / '.' 空气（水由 water 决定）
    Worm worm[NW];
    Proj proj[SEATS];   // 每席一个
    BoomEvent immediate[SEATS];
    int water = START_WATER;
    int wind = 0;
    int round = 1;
    int seed = 0;
    uint8_t debug_mode = 0;   // LOADX 置 1；只有它能用 SETWORM 等测试命令
    bool over = false;
    int winner = -1;
    string reason = "RUNNING";
    int active_mask = 0b0011;     // v2: default is the legacy 2-seat mode
    int dealt[SEATS] = {};        // 造成的总伤害
    bool bad[SEATS] = {};         // 本步该方是否非法（由 STEP 重置）
    uint64_t hash = 0;
};

static bool seat_active(const Game &G, int seat) {
    return seat >= 0 && seat < SEATS && ((G.active_mask >> seat) & 1);
}

static int active_seat_count(const Game &G) {
    int n = 0;
    for (int s = 0; s < SEATS; s++) if (seat_active(G, s)) n++;
    return n;
}

// ---------------------------------------------------------------- 基础查询

static bool in_map(int x, int y) { return x >= 0 && x < W && y >= 0 && y < H; }

static bool valid_worm_id(int wid) { return wid >= 0 && wid < NW; }

static bool live_worm(const Game &G, int wid) {
    return valid_worm_id(wid) && G.worm[wid].alive;
}

static bool is_solid(const Game &G, int x, int y) {
    if (!in_map(x, y)) return true;
    const char c = G.grid[y][x];
    return c == '#' || c == 'X';
}

static bool is_bedrock(const Game &G, int x, int y) {
    if (!in_map(x, y)) return true;
    return G.grid[y][x] == 'X';
}

static bool is_water(const Game &G, int, int y) { return y >= G.water; }

static bool is_air(const Game &G, int x, int y) {
    return in_map(x, y) && !is_solid(G, x, y) && !is_water(G, x, y);
}

// 虫所在格；没有返回 -1
static int worm_at(const Game &G, int x, int y) {
    for (int i = 0; i < NW; i++) {
        if (G.worm[i].alive && G.worm[i].x == x && G.worm[i].y == y) return i;
    }
    return -1;
}

static int alive_count(const Game &G, int seat) {
    int n = 0;
    for (int i = seat * 3; i < seat * 3 + 3; i++)
        if (G.worm[i].alive) n++;
    return n;
}

// ---------------------------------------------------------------- 哈希

static void recompute_hash(Game &G) {
    uint64_t h = 1469598103934665603ULL;
    auto mix = [&h](uint64_t v) {
        h ^= v;
        h *= 1099511628211ULL;
    };
    mix((uint64_t)G.round);
    mix((uint64_t)G.water);
    mix((uint64_t)(G.wind + 32));
    mix((uint64_t)G.over);
    mix((uint64_t)(G.winner + 2));
    if (G.active_mask == 0b0011) {
        // Legacy 2-seat hash: keep old replays/hashes stable.
        for (int i = 0; i < 6; i++) {
            mix((uint64_t)G.worm[i].x);
            mix((uint64_t)G.worm[i].y);
            mix((uint64_t)G.worm[i].hp);
            mix((uint64_t)G.worm[i].grenades);
            mix((uint64_t)G.worm[i].drills);
            mix(G.worm[i].alive ? 1u : 0u);
        }
        mix((uint64_t)G.dealt[0]);
        mix((uint64_t)G.dealt[1]);
    } else {
        mix((uint64_t)G.active_mask);
        for (int i = 0; i < NW; i++) {
            mix((uint64_t)G.worm[i].x);
            mix((uint64_t)G.worm[i].y);
            mix((uint64_t)G.worm[i].hp);
            mix((uint64_t)G.worm[i].grenades);
            mix((uint64_t)G.worm[i].drills);
            mix(G.worm[i].alive ? 1u : 0u);
        }
        for (int s = 0; s < SEATS; s++) mix((uint64_t)G.dealt[s]);
    }
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++) mix((uint64_t)(unsigned char)G.grid[y][x]);
    G.hash = h;
}

// ---------------------------------------------------------------- 风

static uint64_t splitmix64(uint64_t x) {
    x += 0x9E3779B97F4A7C15ULL;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
    return x ^ (x >> 31);
}

static int wind_for_round(int seed, int round) {
    if (round == 1) return (seed % 21) - 10;
    const uint64_t mixed = splitmix64((uint64_t)seed ^ ((uint64_t)round * 0x9E3779B97F4A7C15ULL));
    return (int)(mixed % 21) - 10;
}

static bool is_wind_round(int round) {
    return round == 6 || round == 11 || round == 16 || round == 21 || round == 26 || round == 31 ||
           round == 36;
}

// ---------------------------------------------------------------- 伤害与死亡

static void damage_worm(Game &G, int wid, int dmg, int by_seat) {
    Worm &w = G.worm[wid];
    if (!w.alive) return;
    w.hp -= dmg;
    if (by_seat >= 0 && by_seat != wid / 3) G.dealt[by_seat] += dmg;
    if (w.hp <= 0) {
        w.hp = 0;
        w.alive = false;
    }
}

static void kill_worm(Game &G, int wid) {
    Worm &w = G.worm[wid];
    w.alive = false;
    w.hp = 0;
}

// 下落结算：按虫 id 升序，逐个处理
static void settle_all(Game &G) {
    for (int i = 0; i < NW; i++) {
        Worm &w = G.worm[i];
        if (!w.alive) continue;
        const int ox = w.x, oy = w.y, hp0 = w.hp;
        const char *cause = "null";
        int fall = 0;
        while (true) {
            const int ny = w.y + 1;
            if (ny >= H) {
                kill_worm(G, i);
                cause = "\"water\"";
                break;
            }
            if (is_water(G, w.x, ny)) {
                kill_worm(G, i);
                cause = "\"water\"";
                break;
            }
            if (is_solid(G, w.x, ny)) break;
            if (worm_at(G, w.x, ny) >= 0) break;
            w.y = ny;
            fall++;
        }
        if (w.alive && fall > FALL_SAFE) {
            damage_worm(G, i, FALL_DAMAGE, -1);
            if (!w.alive) cause = "\"fall\"";
        }
        if (w.x != ox || w.y != oy || !w.alive) {
            trace_emit("{\"type\":\"settle\",\"round\":%d,\"tick\":%d,\"phase\":\"%s\","
                       "\"worm\":%d,\"from\":[%d,%d],\"to\":[%d,%d],\"fall\":%d,"
                       "\"damage\":%d,\"hp\":%d,\"death\":%s}",
                       g_ev_round, g_ev_tick, g_settle_phase, i, ox, oy, w.x, w.y,
                       fall, hp0 - w.hp, w.hp, cause);
        }
    }
}

// ---------------------------------------------------------------- 爆炸

struct BoomSpec {
    int radius;
    int base;
};

static BoomSpec boom_of(int kind) {
    if (kind == K_ROCKET) return BoomSpec{2, 25};
    if (kind == K_GRENADE) return BoomSpec{3, 35};
    return BoomSpec{1, 20};
}

static void explode(Game &G, int cx, int cy, int kind, int owner_wid) {
    const BoomSpec spec = boom_of(kind);
    const int denom = spec.radius + 1;
    const int owner_seat = (owner_wid >= 0) ? owner_wid / 3 : -1;

    int hit_hp0[NW], hit_dmg[NW], hit_killed[NW];
    for (int i = 0; i < NW; i++) { hit_hp0[i] = -1; hit_dmg[i] = 0; hit_killed[i] = 0; }

    // 先算伤害（按爆炸瞬间的虫位置），再破坏地形，最后 settle
    for (int dy = -spec.radius; dy <= spec.radius; dy++) {
        for (int dx = -spec.radius; dx <= spec.radius; dx++) {
            const int tx = cx + dx;
            const int ty = cy + dy;
            if (!in_map(tx, ty)) continue;
            const int d = std::max(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy);
            if (d > spec.radius) continue;
            const int wid = worm_at(G, tx, ty);
            if (wid >= 0) {
                const int dmg = spec.base * (denom - d) / denom;
                if (dmg > 0) {
                    if (hit_hp0[wid] < 0) hit_hp0[wid] = G.worm[wid].hp;
                    damage_worm(G, wid, dmg, owner_seat);
                    hit_dmg[wid] += dmg;
                    if (!G.worm[wid].alive) hit_killed[wid] = 1;
                }
            }
        }
    }

    int destroyed[64][2];
    int ndestroyed = 0;
    for (int dy = -spec.radius; dy <= spec.radius; dy++) {
        for (int dx = -spec.radius; dx <= spec.radius; dx++) {
            const int tx = cx + dx;
            const int ty = cy + dy;
            if (!in_map(tx, ty)) continue;
            const int d = std::max(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy);
            if (d > spec.radius) continue;
            if (is_bedrock(G, tx, ty)) continue;
            if (G.grid[ty][tx] == '#') {
                G.grid[ty][tx] = '.';
                if (ndestroyed < 64) { destroyed[ndestroyed][0] = tx; destroyed[ndestroyed][1] = ty; ndestroyed++; }
            }
        }
    }

    if (g_trace) {
        fprintf(g_trace, "{\"type\":\"explode\",\"round\":%d,\"tick\":%d,\"x\":%d,\"y\":%d,"
                         "\"radius\":%d,\"kind\":%d,\"owner_worm\":%d,\"owner_seat\":%d,\"damage\":[",
                g_ev_round, g_ev_tick, cx, cy, spec.radius, kind, owner_wid, owner_seat);
        bool first = true;
        for (int i = 0; i < NW; i++) {
            if (hit_hp0[i] < 0) continue;
            fprintf(g_trace, "%s{\"worm\":%d,\"dmg\":%d,\"hp\":%d,\"killed\":%d}",
                    first ? "" : ",", i, hit_dmg[i], G.worm[i].hp, hit_killed[i]);
            first = false;
        }
        fprintf(g_trace, "],\"destroyed\":[");
        for (int i = 0; i < ndestroyed; i++)
            fprintf(g_trace, "%s[%d,%d]", i ? "," : "", destroyed[i][0], destroyed[i][1]);
        fprintf(g_trace, "]}\n");
        fflush(g_trace);
    }

    const char *prev_phase = g_settle_phase;
    g_settle_phase = "boom";
    settle_all(G);
    g_settle_phase = prev_phase;
}

// ---------------------------------------------------------------- 投射物

static void spawn_projectile(Game &G, int wid, int kind, int angle, int power) {
    const Worm &w = G.worm[wid];
    Proj &p = G.proj[wid / 3];
    p = Proj();
    p.active = true;
    p.kind = kind;
    p.owner = wid;

    if (kind == K_DRILL) {
        // 固定 0.25 格/tick，无重力无风
        const int64_t speed = Q / 4;
        p.vx = qmul(speed, p01::cos_q16(angle));
        p.vy = -qmul(speed, p01::sin_q16(angle));
        p.life = 48;
    } else {
        const int64_t speed = (int64_t)power * Q / 100;
        p.vx = qmul(speed, p01::cos_q16(angle));
        p.vy = -qmul(speed, p01::sin_q16(angle));
        p.life = (kind == K_ROCKET) ? 300 : 180;
    }

    // 发射点：虫格中心 + 沿方向偏移 0.5 格
    const int64_t cx = ((int64_t)w.x * Q) + Q / 2;
    const int64_t cy = ((int64_t)w.y * Q) + Q / 2;
    p.x = cx + qmul(Q / 2, p01::cos_q16(angle));
    p.y = cy - qmul(Q / 2, p01::sin_q16(angle));

    const int sx = (int)floor16(p.x);
    const int sy = (int)floor16(p.y);
    bool buried = false;
    if (is_solid(G, sx, sy)) {
        // 发射点埋在实体里：双方生成完毕后，再按本轮优先序爆炸。
        p.active = false;
        buried = true;
        BoomEvent &b = G.immediate[wid / 3];
        b.pending = true;
        b.x = w.x;
        b.y = w.y;
        b.kind = kind;
        b.owner = wid;
    }
    trace_emit("{\"type\":\"fire\",\"round\":%d,\"tick\":%d,\"seat\":%d,\"worm\":%d,"
               "\"kind\":%d,\"angle\":%d,\"power\":%d,\"spawn\":[%lld,%lld],"
               "\"vel\":[%lld,%lld],\"life\":%d,\"buried\":%d}",
               g_ev_round, g_ev_tick, wid / 3, wid, kind, angle, power,
               (long long)p.x, (long long)p.y, (long long)p.vx, (long long)p.vy,
               p.life, buried ? 1 : 0);
}

// 返回 true 表示投射物本 tick 结束（命中/爆炸/消失）
static bool proj_collide(Game &G, Proj &p, int64_t px, int64_t py) {
    const int gx = (int)floor16(px);
    const int gy = (int)floor16(py);
    if (!in_map(gx, gy)) {
        explode(G, gx < 0 ? 0 : (gx >= W ? W - 1 : gx), gy < 0 ? 0 : (gy >= H ? H - 1 : gy),
                p.kind, p.owner);
        p.active = false;
        return true;
    }
    if (is_water(G, gx, gy)) {
        p.active = false;   // 入水移除，不爆炸
        return true;
    }
    const int wid = worm_at(G, gx, gy);
    if (wid >= 0) {
        // 前 6 tick 不打自己
        if (wid == p.owner && p.age < 6) return false;
        explode(G, gx, gy, p.kind, p.owner);
        p.active = false;
        return true;
    }
    if (is_solid(G, gx, gy)) {
        if (p.kind == K_GRENADE && !is_bedrock(G, gx, gy)) {
            return false;   // 手雷的反弹在调用方处理
        }
        explode(G, gx, gy, p.kind, p.owner);
        p.active = false;
        return true;
    }
    return false;
}

static void proj_tick(Game &G, int slot) {
    Proj &p = G.proj[slot];
    if (!p.active) return;

    p.age += 1;

    if (p.kind == K_DRILL) {
        // 直线：逐格推进，遇泥土就挖
        const int64_t x0 = p.x, y0 = p.y;
        p.x += p.vx;
        p.y += p.vy;
        const int64_t dxs = p.x - x0, dys = p.y - y0;
        const int sub = 1 + (int)(std::max(abs64(dxs), abs64(dys)) / (Q / 4));
        for (int s = 1; s <= sub; s++) {
            const int64_t cx = x0 + dxs * s / sub;
            const int64_t cy = y0 + dys * s / sub;
            const int gx = (int)floor16(cx);
            const int gy = (int)floor16(cy);
            if (!in_map(gx, gy) || is_water(G, gx, gy)) {
                p.active = false;
                return;
            }
            const int wid = worm_at(G, gx, gy);
            if (wid >= 0 && !(wid == p.owner && p.age < 6)) {
                explode(G, gx, gy, K_DRILL, p.owner);
                p.active = false;
                return;
            }
            if (is_solid(G, gx, gy)) {
                if (G.grid[gy][gx] == '#' && p.dug < 3) {
                    G.grid[gy][gx] = '.';
                    p.dug++;
                    trace_emit("{\"type\":\"dig\",\"round\":%d,\"tick\":%d,\"slot\":%d,"
                               "\"cell\":[%d,%d],\"dug\":%d}",
                               g_ev_round, g_ev_tick, slot, gx, gy, p.dug);
                    continue;
                }
                explode(G, gx, gy, K_DRILL, p.owner);
                p.active = false;
                return;
            }
        }
        p.life -= 1;
        if (p.life <= 0) {
            explode(G, (int)floor16(p.x), (int)floor16(p.y), K_DRILL, p.owner);
            p.active = false;
        }
        return;
    }

    // 火箭 / 手雷：受重力与风
    p.vx += (int64_t)G.wind * WIND_UNIT;
    p.vy += GRAVITY;

    if (p.stuck) {
        // 停住的手雷：下方没支撑就继续掉
        const int gx = (int)floor16(p.x);
        const int gy = (int)floor16(p.y);
        if (is_solid(G, gx, gy + 1) || worm_at(G, gx, gy + 1) >= 0) {
            p.vx = 0;
            p.vy = 0;
        } else {
            p.stuck = false;
        }
    }

    if (!p.stuck) {
        if (p.kind == K_GRENADE) {
            // 反弹：分别检查水平/垂直
            const int64_t nx = p.x + p.vx;
            const int64_t ny = p.y + p.vy;
            const int ogx = (int)floor16(p.x), ogy = (int)floor16(p.y);
            const int ngx = (int)floor16(nx), ngy = (int)floor16(ny);
            bool bounced = false;
            bool bounce_x = false, bounce_y = false;
            if (is_solid(G, ngx, ogy) && !is_water(G, ngx, ogy)) {
                p.vx = -p.vx / 2;
                bounced = true;
                bounce_x = true;
            }
            if (is_solid(G, ogx, ngy) && !is_water(G, ogx, ngy)) {
                p.vy = -p.vy / 2;
                bounced = true;
                bounce_y = true;
            }
            if (bounced) {
                trace_emit("{\"type\":\"bounce\",\"round\":%d,\"tick\":%d,\"slot\":%d,"
                           "\"x\":%d,\"y\":%d,\"axis_x\":%d,\"axis_y\":%d,"
                           "\"vx\":%lld,\"vy\":%lld}",
                           g_ev_round, g_ev_tick, slot, ogx, ogy,
                           bounce_x ? 1 : 0, bounce_y ? 1 : 0,
                           (long long)p.vx, (long long)p.vy);
                const bool slow = abs64(p.vx) < 1311 && abs64(p.vy) < 1311;
                if (slow && (is_solid(G, ogx, ogy + 1) || worm_at(G, ogx, ogy + 1) >= 0)) {
                    p.vx = 0;
                    p.vy = 0;
                    p.stuck = true;
                }
            } else {
                const int64_t x0 = p.x, y0 = p.y;
                p.x = nx;
                p.y = ny;
                const int64_t dxs = p.x - x0, dys = p.y - y0;
                const int sub = 1 + (int)(std::max(abs64(dxs), abs64(dys)) / (Q / 4));
                for (int s = 1; s <= sub; s++) {
                    const int64_t cx = x0 + dxs * s / sub;
                    const int64_t cy = y0 + dys * s / sub;
                    if (proj_collide(G, p, cx, cy)) return;
                }
            }
        } else {
            const int64_t x0 = p.x, y0 = p.y;
            p.x += p.vx;
            p.y += p.vy;
            const int64_t dxs = p.x - x0, dys = p.y - y0;
            const int sub = 1 + (int)(std::max(abs64(dxs), abs64(dys)) / (Q / 4));
            for (int s = 1; s <= sub; s++) {
                const int64_t cx = x0 + dxs * s / sub;
                const int64_t cy = y0 + dys * s / sub;
                if (proj_collide(G, p, cx, cy)) return;
            }
        }
    }

    p.life -= 1;
    if (p.life <= 0) {
        explode(G, (int)floor16(p.x), (int)floor16(p.y), p.kind, p.owner);
        p.active = false;
    }
}

// ---------------------------------------------------------------- 移动

static bool do_move(Game &G, int wid, char dir) {
    Worm &w = G.worm[wid];
    const int dx = (dir == 'R') ? 1 : (dir == 'L' ? -1 : 0);
    if (dx == 0) return false;
    const int tx = w.x + dx;
    if (is_air(G, tx, w.y) && worm_at(G, tx, w.y) < 0) {
        w.x = tx;
        return true;
    }
    // 上一格台阶
    if (is_air(G, tx, w.y - 1) && worm_at(G, tx, w.y - 1) < 0) {
        w.x = tx;
        w.y -= 1;
        return true;
    }
    return false;
}

static bool do_jump(Game &G, int wid, char dir) {
    Worm &w = G.worm[wid];
    const int dx = (dir == 'R') ? 2 : (dir == 'L' ? -2 : 0);
    if (dx == 0) return false;
    if (!is_air(G, w.x, w.y - 1)) return false;
    const int tx = w.x + dx;
    const int ty = w.y - 1;
    if (!is_air(G, tx, ty) || worm_at(G, tx, ty) >= 0) return false;
    w.x = tx;
    w.y = ty;
    return true;
}

// ---------------------------------------------------------------- 地图

static char legacy_mirror(char c) {
    if (c == '0') return '1';
    if (c == '1') return '0';
    return c;
}

static string load_map(Game &G, const string &path, bool strict) {
    ifstream f(path.c_str(), ios::binary);
    if (!f) return "cannot open " + path;
    vector<string> rows;
    string line;
    while (getline(f, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
        if (line.empty()) continue;
        rows.push_back(line);
    }
    if ((int)rows.size() != H) return "map must have 54 rows";
    for (size_t i = 0; i < rows.size(); i++)
        if ((int)rows[i].size() != W) return "row " + to_string(i) + " must be 96 chars";

    int cnt[SEATS] = {};
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            const char c = rows[y][x];
            if (c != '.' && c != '#' && c != 'X' && c != '~' && !(c >= '0' && c <= '3'))
                return string("bad map char '") + c + "'";
            if (c >= '0' && c <= '3') cnt[c - '0']++;
        }
    }
    const int seats = active_seat_count(G);
    if (seats < 2 || seats > SEATS) return "active mask must select 2-4 seats";
    for (int s = 0; s < SEATS; s++) {
        if (!seat_active(G, s)) continue;
        if (cnt[s] != WORMS_PER_SEAT)
            return "need exactly three '" + string(1, char('0' + s)) + "' spawns";
    }
    // Legacy 2-seat maps keep the old mirror rule; 4-seat maps may be asymmetric.
    if (strict && G.active_mask == 0b0011) {
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
                if (rows[y][x] != legacy_mirror(rows[y][W - 1 - x]))
                    return "map is not mirror symmetric";
    }
    if (strict) {
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
                if (x < 2 || x >= W - 2 || y < 2 || y >= H - 2)
                    if (rows[y][x] != 'X') return "border must be bedrock";
    }

    G.grid.assign(H, string(W, '.'));
    for (int i = 0; i < NW; i++) {
        G.worm[i] = Worm();
        G.worm[i].alive = false;
    }
    int idx[SEATS] = {};
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            const char c = rows[y][x];
            if (c == '#') G.grid[y][x] = '#';
            else if (c == 'X') G.grid[y][x] = 'X';
            else G.grid[y][x] = '.';
            if (c >= '0' && c <= '3' && seat_active(G, c - '0')) {
                const int seat = c - '0';
                const int wid = seat * WORMS_PER_SEAT + idx[seat]++;
                G.worm[wid] = Worm();
                G.worm[wid].x = x;
                G.worm[wid].y = y;
            }
        }
    }

    for (int s = 0; s < SEATS; s++) {
        if (!seat_active(G, s)) continue;
        for (int i = s * WORMS_PER_SEAT; i < (s + 1) * WORMS_PER_SEAT; i++) {
            Worm &w = G.worm[i];
            if (!is_air(G, w.x, w.y)) return "spawn not in air";
            if (!strict) continue;
            if (!is_solid(G, w.x, w.y + 1)) return "spawn has no ground";
            if (!is_air(G, w.x - 1, w.y) && !is_air(G, w.x + 1, w.y))
                return "spawn has no side exit";
            bool seen[H][W] = {};
            vector<pair<int, int>> cells{{w.x, w.y}};
            seen[w.y][w.x] = true;
            for (size_t at = 0; at < cells.size() && cells.size() < 20; at++) {
                const int dx[4] = {1, -1, 0, 0}, dy[4] = {0, 0, 1, -1};
                for (int d = 0; d < 4; d++) {
                    const int x = cells[at].first + dx[d], y = cells[at].second + dy[d];
                    if (!is_air(G, x, y) || seen[y][x]) continue;
                    seen[y][x] = true;
                    cells.emplace_back(x, y);
                }
            }
            if (cells.size() < 20) return "spawn air region smaller than 20";
            bool escape = false;
            for (char dir : {'L', 'R'}) {
                for (bool jump : {false, true}) {
                    Game trial = G;
                    bool moved = jump ? do_jump(trial, i, dir) : do_move(trial, i, dir);
                    if (!moved) continue;
                    settle_all(trial);
                    const Worm &next = trial.worm[i];
                    if (next.hp > 0 && (next.x != w.x || next.y != w.y)) escape = true;
                }
            }
            if (!escape) return "spawn has no surviving move or jump";
        }
    }

    if (strict) {
        int air = 0;
        for (const auto &row : rows)
            for (char c : row) if (c == '.' || (c >= '0' && c <= '3')) air++;
        if (air * 100 < W * H * 25 || air * 100 > W * H * 60)
            return "air ratio outside 25-60 percent";
    }

    G.water = START_WATER;
    G.round = 1;
    G.over = false;
    G.winner = -1;
    G.reason = "RUNNING";
    for (int s = 0; s < SEATS; s++) G.dealt[s] = 0;
    for (int s = 0; s < SEATS; s++) G.proj[s] = Proj();
    G.wind = wind_for_round(G.seed, 1);
    recompute_hash(G);
    return "";
}

// ---------------------------------------------------------------- 指令

struct Order {
    int act = -1;
    vector<string> ops;
    bool ok = true;
};

struct FireIntent {
    bool pending = false;
    int kind = 0;
    int angle = 0;
    int power = 0;
};

struct OrderState {
    int act = -1;
    vector<string> ops;
    size_t next = 0;
    int ap = AP_MAX;
    bool done = false;
    FireIntent fire;
};

struct MoveIntent {
    bool attempted = false;
    bool ok = false;
    int x = 0, y = 0;
    int cost = 0;
};

static Order parse_order_line(const string &s) {
    Order o;
    istringstream ss(s);
    string tok;
    ss >> tok;
    if (tok.empty()) {
        o.ok = false;
        return o;
    }
    o.act = atoi(tok.c_str());
    string rest;
    getline(ss, rest);
    size_t pos = 0;
    while (pos <= rest.size()) {
        const size_t semi = rest.find(';', pos);
        string piece = rest.substr(pos, (semi == string::npos) ? string::npos : semi - pos);
        size_t a = piece.find_first_not_of(" \t");
        size_t b = piece.find_last_not_of(" \t");
        if (a != string::npos) o.ops.push_back(piece.substr(a, b - a + 1));
        if (semi == string::npos) break;
        pos = semi + 1;
    }
    return o;
}

static OrderState init_order_state(Game &G, int seat, const Order &o, bool *active) {
    OrderState st;
    st.act = o.act;
    st.ops = o.ops;
    if (!o.ok || o.act < seat * WORMS_PER_SEAT
        || o.act >= seat * WORMS_PER_SEAT + WORMS_PER_SEAT || !live_worm(G, o.act)) {
        G.bad[seat] = true;
        st.done = true;
    } else {
        active[o.act] = true;
    }
    return st;
}

static bool blocked_by_stationary(const Game &G, int x, int y, int self, const bool *active) {
    const int wid = worm_at(G, x, y);
    return wid >= 0 && wid != self && !active[wid];
}

static MoveIntent parse_move_intent(Game &G, OrderState &st, const string &op,
                                    const bool *active) {
    MoveIntent m;
    m.attempted = true;
    istringstream ss(op);
    string cmd, d;
    ss >> cmd >> d;
    const bool jump = (cmd == "J");
    m.cost = jump ? 2 : 1;
    if (st.ap < m.cost || d.size() != 1) return m;
    if (!live_worm(G, st.act)) return m;
    const int dx = (d[0] == 'R') ? 1 : (d[0] == 'L' ? -1 : 0);
    if (dx == 0) return m;
    const Worm &w = G.worm[st.act];
    if (jump) {
        m.x = w.x + 2 * dx;
        m.y = w.y - 1;
        m.ok = is_air(G, w.x, w.y - 1) && is_air(G, m.x, m.y)
               && !blocked_by_stationary(G, m.x, m.y, st.act, active);
        return m;
    }
    m.x = w.x + dx;
    m.y = w.y;
    if (is_air(G, m.x, m.y)) {
        m.ok = !blocked_by_stationary(G, m.x, m.y, st.act, active);
    } else if (is_solid(G, m.x, m.y) && is_air(G, m.x, m.y - 1)) {
        m.y -= 1;
        m.ok = !blocked_by_stationary(G, m.x, m.y, st.act, active);
    }
    return m;
}

// Active seats simultaneously declare M/J. Same target, swap, or entering a
// worm that failed to leave its cell makes the move fail.
static void apply_orders(Game &G, const Order orders[SEATS]) {
    bool active[NW] = {};
    OrderState st[SEATS];
    for (int s = 0; s < SEATS; s++) {
        if (!seat_active(G, s)) {
            st[s].done = true;
            continue;
        }
        st[s] = init_order_state(G, s, orders[s], active);
    }
    bool any_movement = false;

    while (true) {
        g_ev_pass++;
        MoveIntent mv[SEATS];
        bool attempted[SEATS] = {};
        bool present[SEATS] = {};
        bool success[SEATS] = {};
        bool declared_ok[SEATS] = {};   // 声明时是否合法（与解碰结果无关）
        int sx[SEATS] = {}, sy[SEATS] = {};
        bool moved_this_pass = false;

        for (int s = 0; s < SEATS; s++) {
            if (!seat_active(G, s) || st[s].done) continue;
            OrderState &cur = st[s];
            if (!live_worm(G, cur.act) || cur.next >= cur.ops.size()) {
                cur.done = true;
                continue;
            }
            const string op = cur.ops[cur.next];
            istringstream ss(op);
            string cmd;
            ss >> cmd;
            if (cmd == "M" || cmd == "J") {
                cur.next++;
                mv[s] = parse_move_intent(G, cur, op, active);
                attempted[s] = true;
                moved_this_pass = true;
                present[s] = live_worm(G, cur.act);
                success[s] = mv[s].ok && present[s];
                declared_ok[s] = mv[s].ok;
                if (present[s]) {
                    sx[s] = G.worm[cur.act].x;
                    sy[s] = G.worm[cur.act].y;
                }
                if (!mv[s].ok) {
                    G.bad[s] = true;
                    cur.done = true;
                }
                continue;
            }
            cur.next++;
            if (cmd == "F") {
                string wpn;
                int angle = 0, power = 0;
                ss >> wpn >> angle >> power;
                const Worm &w = G.worm[cur.act];
                int kind = 0;
                bool ok = angle >= 0 && angle <= 180 && power >= 0 && power <= 100;
                if (wpn == "ROCKET") kind = K_ROCKET;
                else if (wpn == "GRENADE" && w.grenades > 0) kind = K_GRENADE;
                else if (wpn == "DRILL" && w.drills > 0) kind = K_DRILL;
                else ok = false;
                if (!ok) G.bad[s] = true;
                else cur.fire = FireIntent{true, kind, angle, power};
                if (cur.next < cur.ops.size()) G.bad[s] = true;
                cur.done = true;
            } else if (cmd == "WAIT") {
                cur.done = true;
            } else {
                G.bad[s] = true;
                cur.done = true;
            }
        }

        if (!moved_this_pass) {
            bool pending = false;
            for (int s = 0; s < SEATS; s++)
                if (seat_active(G, s) && !st[s].done) pending = true;
            if (!pending) break;
            continue;
        }
        any_movement = true;

        // 解碰：同一格/互换/进入没让位的虫，双方本组移动都不生效。
        // ★ 这不记 fault：双方的动作各自都是合法声明，失败是【同时下令的
        //   结构性后果】，不是违规。旧版把双方都记非法，导致密集移动的
        //   一局里两边各攒 3 次 fault 判负（public4-12/24 实测 24/24 全 FORFEIT）。
        bool changed = true;
        while (changed) {
            changed = false;
            for (int i = 0; i < SEATS; i++) {
                if (!success[i]) continue;
                for (int j = i + 1; j < SEATS; j++) {
                    if (!success[j]) continue;
                    const bool same = mv[i].x == mv[j].x && mv[i].y == mv[j].y;
                    const bool swap = present[i] && present[j]
                        && mv[i].x == sx[j] && mv[i].y == sy[j]
                        && mv[j].x == sx[i] && mv[j].y == sy[i];
                    if (same || swap) {
                        success[i] = success[j] = false;
                        changed = true;
                    }
                }
            }
            for (int i = 0; i < SEATS; i++) {
                if (!success[i]) continue;
                for (int j = 0; j < SEATS; j++) {
                    if (i == j || !present[j] || success[j]) continue;
                    if (mv[i].x == sx[j] && mv[i].y == sy[j]) {
                        success[i] = false;
                        changed = true;
                        break;
                    }
                }
            }
        }

        for (int s = 0; s < SEATS; s++) {
            if (!attempted[s]) continue;
            if (!success[s]) {
                // 声明本身非法 -> fault；只是被别人抢了格子 -> 静默失败，不记 fault。
                if (!declared_ok[s]) G.bad[s] = true;
                st[s].done = true;
                continue;
            }
            G.worm[st[s].act].x = mv[s].x;
            G.worm[st[s].act].y = mv[s].y;
            trace_emit("{\"type\":\"move\",\"round\":%d,\"pass\":%d,\"tick\":%d,"
                       "\"seat\":%d,\"worm\":%d,\"from\":[%d,%d],\"to\":[%d,%d],"
                       "\"kind\":\"%s\"}",
                       g_ev_round, g_ev_pass, g_ev_tick, s, st[s].act,
                       sx[s], sy[s], mv[s].x, mv[s].y,
                       mv[s].cost == 2 ? "J" : "M");
            st[s].ap -= mv[s].cost;
        }
        const char *prev_phase = g_settle_phase;
        g_settle_phase = "move";
        settle_all(G);
        g_settle_phase = prev_phase;
        for (int s = 0; s < SEATS; s++)
            if (valid_worm_id(st[s].act) && !G.worm[st[s].act].alive) st[s].done = true;
    }

    if (!any_movement) {
        const char *prev_phase = g_settle_phase;
        g_settle_phase = "move";
        settle_all(G);
        g_settle_phase = prev_phase;
    }

    for (int s = 0; s < SEATS; s++) {
        if (!seat_active(G, s)) continue;
        OrderState &cur = st[s];
        if (!cur.fire.pending || !live_worm(G, cur.act)) continue;
        Worm &w = G.worm[cur.act];
        if (cur.fire.kind == K_GRENADE) w.grenades--;
        if (cur.fire.kind == K_DRILL) w.drills--;
        spawn_projectile(G, cur.act, cur.fire.kind, cur.fire.angle, cur.fire.power);
    }

    int active_slots[SEATS], na = 0;
    for (int s = 0; s < SEATS; s++) if (seat_active(G, s)) active_slots[na++] = s;
    if (na > 0) {
        const int first = (G.round - 1) % na;
        for (int k = 0; k < na; k++) {
            const int slot = active_slots[(first + k) % na];
            BoomEvent &b = G.immediate[slot];
            if (!b.pending) continue;
            explode(G, b.x, b.y, b.kind, b.owner);
            b.pending = false;
        }
    }
}

static void do_round(Game &G, const Order orders[SEATS]) {
    for (int s = 0; s < SEATS; s++) {
        if (!seat_active(G, s)) continue;
        G.bad[s] = false;
    }
    g_ev_round = G.round;
    g_ev_tick = 0;
    g_ev_pass = 0;
    g_settle_phase = "move";
    trace_emit("{\"type\":\"round\",\"round\":%d,\"wind\":%d,\"water\":%d}",
               G.round, G.wind, G.water);
    apply_orders(G, orders);

    int active_slots[SEATS], na = 0;
    for (int s = 0; s < SEATS; s++) if (seat_active(G, s)) active_slots[na++] = s;
    int ticks = 0;
    while (ticks < MAX_TICKS) {
        bool any = false;
        for (int k = 0; k < na; k++) any = any || G.proj[active_slots[k]].active;
        if (!any) break;
        g_ev_tick = ticks + 1;
        const int first = (G.round - 1) % na;
        for (int k = 0; k < na; k++) {
            const int slot = active_slots[(first + k) % na];
            if (G.proj[slot].active) proj_tick(G, slot);
        }
        if (g_trace) {
            fprintf(g_trace, "{\"type\":\"tick\",\"round\":%d,\"tick\":%d,\"proj\":[",
                    G.round, g_ev_tick);
            bool firstp = true;
            for (int k = 0; k < na; k++) {
                const int slot = active_slots[(first + k) % na];
                const Proj &p = G.proj[slot];
                if (!p.active) continue;
                fprintf(g_trace, "%s{\"slot\":%d,\"kind\":%d,\"x\":%lld,\"y\":%lld,"
                                 "\"vx\":%lld,\"vy\":%lld,\"age\":%d,\"life\":%d,"
                                 "\"stuck\":%d,\"dug\":%d}",
                        firstp ? "" : ",", slot, p.kind, (long long)p.x, (long long)p.y,
                        (long long)p.vx, (long long)p.vy, p.age, p.life,
                        p.stuck ? 1 : 0, p.dug);
                firstp = false;
            }
            fprintf(g_trace, "]}\n");
            fflush(g_trace);
        }
        ticks++;
    }
    for (int s = 0; s < SEATS; s++) G.proj[s].active = false;

    if (G.round >= 30 && G.round % 2 == 0) {
        const int old_water = G.water;
        if (G.water > 44) G.water -= 1;
        int drowned[NW], ndrowned = 0;
        for (int i = 0; i < NW; i++) {
            if (G.worm[i].alive && is_water(G, G.worm[i].x, G.worm[i].y)) {
                kill_worm(G, i);
                drowned[ndrowned++] = i;
            }
        }
        const char *prev_phase = g_settle_phase;
        g_settle_phase = "water";
        settle_all(G);
        g_settle_phase = prev_phase;
        if (g_trace) {
            fprintf(g_trace, "{\"type\":\"water\",\"round\":%d,\"from\":%d,\"level\":%d,\"drowned\":[",
                    G.round, old_water, G.water);
            for (int i = 0; i < ndrowned; i++)
                fprintf(g_trace, "%s%d", i ? "," : "", drowned[i]);
            fprintf(g_trace, "]}\n");
            fflush(g_trace);
        }
    }
    G.round += 1;
    if (is_wind_round(G.round)) G.wind = wind_for_round(G.seed, G.round);

    int alive_seats = 0, last = -1;
    int hp[SEATS] = {}, alive[SEATS] = {};
    for (int s = 0; s < SEATS; s++) {
        if (!seat_active(G, s)) continue;
        for (int i = s * WORMS_PER_SEAT; i < (s + 1) * WORMS_PER_SEAT; i++) {
            hp[s] += G.worm[i].alive ? G.worm[i].hp : 0;
            alive[s] += G.worm[i].alive ? 1 : 0;
        }
        if (alive[s] > 0) {
            alive_seats++;
            last = s;
        }
    }

    if (alive_seats <= 1) {
        G.over = true;
        if (alive_seats == 0) {
            int best = -1, best_seat = -1, count = 0;
            for (int s = 0; s < SEATS; s++) {
                if (!seat_active(G, s)) continue;
                if (G.dealt[s] > best) {
                    best = G.dealt[s];
                    best_seat = s;
                    count = 1;
                } else if (G.dealt[s] == best) {
                    count++;
                }
            }
            if (count == 1) {
                G.winner = best_seat;
                G.reason = "DAMAGE";
            } else {
                G.winner = -1;
                G.reason = "DRAW";
            }
        } else {
            G.winner = last;
            G.reason = "ELIMINATION";
        }
    } else if (G.round > ROUNDS) {
        G.over = true;
        int best_hp = -1, hp_count = 0;
        for (int s = 0; s < SEATS; s++) {
            if (!seat_active(G, s)) continue;
            if (hp[s] > best_hp) { best_hp = hp[s]; hp_count = 1; }
            else if (hp[s] == best_hp) hp_count++;
        }
        if (hp_count == 1) {
            for (int s = 0; s < SEATS; s++)
                if (seat_active(G, s) && hp[s] == best_hp) G.winner = s;
            G.reason = "HP";
        } else {
            int best_dmg = -1, dmg_count = 0;
            for (int s = 0; s < SEATS; s++) {
                if (!seat_active(G, s) || hp[s] != best_hp) continue;
                if (G.dealt[s] > best_dmg) { best_dmg = G.dealt[s]; dmg_count = 1; }
                else if (G.dealt[s] == best_dmg) dmg_count++;
            }
            if (dmg_count == 1) {
                for (int s = 0; s < SEATS; s++)
                    if (seat_active(G, s) && hp[s] == best_hp && G.dealt[s] == best_dmg)
                        G.winner = s;
                G.reason = "DAMAGE";
            } else {
                int best_alive = -1, alive_count_best = 0;
                for (int s = 0; s < SEATS; s++) {
                    if (!seat_active(G, s) || hp[s] != best_hp) continue;
                    if (alive[s] > best_alive) { best_alive = alive[s]; alive_count_best = 1; }
                    else if (alive[s] == best_alive) alive_count_best++;
                }
                if (alive_count_best == 1) {
                    for (int s = 0; s < SEATS; s++)
                        if (seat_active(G, s) && hp[s] == best_hp && alive[s] == best_alive)
                            G.winner = s;
                    G.reason = "WORMS";
                } else {
                    G.winner = -1;
                    G.reason = "DRAW";
                }
            }
        }
    }
    recompute_hash(G);
    if (g_trace) {
        int thp[SEATS] = {};
        for (int s = 0; s < SEATS; s++)
            for (int i = s * WORMS_PER_SEAT; i < (s + 1) * WORMS_PER_SEAT; i++)
                if (G.worm[i].alive) thp[s] += G.worm[i].hp;
        fprintf(g_trace, "{\"type\":\"turn_end\",\"round\":%d,\"hp\":[%d,%d,%d,%d],"
                         "\"dealt\":[%d,%d,%d,%d],\"worms\":[",
                G.round - 1, thp[0], thp[1], thp[2], thp[3],
                G.dealt[0], G.dealt[1], G.dealt[2], G.dealt[3]);
        for (int i = 0; i < NW; i++)
            fprintf(g_trace, "%s[%d,%d,%d,%d,%d,%d]", i ? "," : "",
                    G.worm[i].x, G.worm[i].y, G.worm[i].hp,
                    G.worm[i].grenades, G.worm[i].drills, G.worm[i].alive ? 1 : 0);
        fprintf(g_trace, "],\"state_hash\":\"%016llx\",\"over\":%d,\"winner\":%d,"
                         "\"reason\":\"%s\"}\n",
                (unsigned long long)G.hash, G.over ? 1 : 0, G.winner, G.reason.c_str());
        fflush(g_trace);
    }
}

// ---------------------------------------------------------------- 输出

static void print_state(Game &G) {
    int hp[SEATS] = {}, alive[SEATS] = {};
    for (int s = 0; s < SEATS; s++) {
        if (!seat_active(G, s)) continue;
        for (int i = s * WORMS_PER_SEAT; i < (s + 1) * WORMS_PER_SEAT; i++) {
            hp[s] += G.worm[i].alive ? G.worm[i].hp : 0;
            alive[s] += G.worm[i].alive ? 1 : 0;
        }
    }
    printf("STATE %d %d %d %d %d", G.round, G.wind + 32, G.water, G.over ? 1 : 0, G.winner);
    if (G.active_mask == 0b0011) {
        // Legacy 2-seat layout: old judge / bots / replays can keep parsing it.
        printf(" %d %d %d %d %s %d %d %016llx", hp[0], hp[1], G.dealt[0], G.dealt[1],
               G.reason.c_str(), G.bad[0] ? 1 : 0, G.bad[1] ? 1 : 0,
               (unsigned long long)G.hash);
        for (int i = 0; i < 6; i++)
            printf(" %d %d %d %d %d %d", G.worm[i].x, G.worm[i].y, G.worm[i].hp,
                   G.worm[i].grenades, G.worm[i].drills, G.worm[i].alive ? 1 : 0);
    } else {
        for (int s = 0; s < SEATS; s++) printf(" %d", hp[s]);
        for (int s = 0; s < SEATS; s++) printf(" %d", G.dealt[s]);
        printf(" %s", G.reason.c_str());
        for (int s = 0; s < SEATS; s++) printf(" %d", G.bad[s] ? 1 : 0);
        printf(" %016llx", (unsigned long long)G.hash);
        for (int i = 0; i < NW; i++)
            printf(" %d %d %d %d %d %d", G.worm[i].x, G.worm[i].y, G.worm[i].hp,
                   G.worm[i].grenades, G.worm[i].drills, G.worm[i].alive ? 1 : 0);
    }
    printf("\n");
    fflush(stdout);
}

static int parse_mask(int mask) {
    if (mask <= 0 || mask >= (1 << SEATS)) return 0b0011;
    int n = 0;
    for (int s = 0; s < SEATS; s++) if ((mask >> s) & 1) n++;
    return (n >= 2 && n <= SEATS) ? mask : 0b0011;
}

// 想让本文件当【库】用（被别的 .cpp #include，不链接 main）：
//     #define P01_ENGINE_NO_MAIN
//     #include "engine/engine.cpp"
// 之后 Game / load_map / do_round / explode 都能直接调。
// ★ 注意 load_map 只吃【文件路径】。想用裁判下发的 GRID，得自己把字符灌进 G.grid ——
//   公开接口没有这条路，这是有意的（见 public/oracle/README.md）。

#ifndef P01_ENGINE_NO_MAIN
int main() {
    string line;
    Game G;
    bool loaded = false;
    while (getline(cin, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
        if (line.empty()) continue;
        istringstream ss(line);
        string cmd;
        ss >> cmd;
        if (cmd == "QUIT") break;

        if (cmd == "TRACE") {
            string path;
            getline(ss, path);
            size_t a = path.find_first_not_of(" \t");
            if (a != string::npos) path = path.substr(a);
            if (path.empty()) {
                printf("ERR TRACE needs a path\n");
            } else {
                trace_open(path);
                printf(g_trace ? "OK\n" : "ERR cannot open trace\n");
            }
            fflush(stdout);
            continue;
        }

        if (cmd == "TRACECLOSE") {
            trace_close();
            printf("OK\n");
            fflush(stdout);
            continue;
        }

        if (cmd == "LOAD" || cmd == "LOADX") {
            const bool strict = (cmd == "LOAD");
            string path;
            int seed = 0, mask = 0b0011;
            ss >> path >> seed;
            if (!(ss >> mask)) mask = 0b0011;
            G = Game();
            G.seed = seed;
            G.active_mask = parse_mask(mask);
            G.debug_mode = strict ? 0 : 1;
            const string err = load_map(G, path, strict);
            if (!err.empty()) {
                loaded = false;
                printf("ERR %s\n", err.c_str());
            } else {
                loaded = true;
                printf("OK %016llx 0\n", (unsigned long long)G.hash);
            }
            fflush(stdout);
            continue;
        }

        if (cmd == "STEP") {
            if (!loaded) { printf("ERR not loaded\n"); fflush(stdout); continue; }
            if (G.over) { printf("ERR over\n"); fflush(stdout); continue; }
            string rest;
            getline(ss, rest);
            vector<string> segs;
            size_t pos = 0;
            while (true) {
                const size_t bar = rest.find('|', pos);
                segs.push_back(rest.substr(pos, bar == string::npos ? string::npos : bar - pos));
                if (bar == string::npos) break;
                pos = bar + 1;
            }
            Order orders[SEATS];
            if (G.active_mask == 0b0011) {
                for (int s = 0; s < 2; s++)
                    orders[s] = s < (int)segs.size() ? parse_order_line(segs[s]) : Order{};
            } else {
                for (int s = 0; s < SEATS; s++)
                    orders[s] = s < (int)segs.size() ? parse_order_line(segs[s]) : Order{};
            }
            do_round(G, orders);
            print_state(G);
            continue;
        }

        if (cmd == "STATE") {
            if (!loaded) { printf("ERR not loaded\n"); fflush(stdout); continue; }
            print_state(G);
            continue;
        }

        if (cmd == "INFO") {
            if (!loaded) { printf("ERR not loaded\n"); fflush(stdout); continue; }
            for (int s = 0; s < SEATS; s++) {
                if (!seat_active(G, s)) continue;
                for (int i = s * WORMS_PER_SEAT; i < (s + 1) * WORMS_PER_SEAT; i++)
                    printf("INFO worm %d %d %d %d\n", i, G.worm[i].x, G.worm[i].y, G.worm[i].hp);
            }
            printf("INFO water %d wind %d\n", G.water, G.wind);
            fflush(stdout);
            continue;
        }

        if (cmd == "GRID") {
            if (!loaded) { printf("ERR not loaded\n"); fflush(stdout); continue; }
            for (int y = 0; y < H; y++) printf("G %s\n", G.grid[y].c_str());
            printf("GEND\n");
            fflush(stdout);
            continue;
        }

        if (cmd == "SETWORM" || cmd == "SETHP" || cmd == "SETWIND" || cmd == "SETWATER"
            || cmd == "KILL") {
            if (!G.debug_mode) { printf("ERR debug only\n"); fflush(stdout); continue; }
            if (cmd == "SETWORM") {
                int id, x, y;
                ss >> id >> x >> y;
                if (id < 0 || id >= NW || !in_map(x, y) || is_solid(G, x, y) || is_water(G, x, y)) {
                    printf("ERR bad place\n");
                } else {
                    G.worm[id].x = x;
                    G.worm[id].y = y;
                    G.worm[id].alive = 1;
                    recompute_hash(G);
                    printf("OK\n");
                }
            } else if (cmd == "SETHP") {
                int id, hp;
                ss >> id >> hp;
                if (id < 0 || id >= NW || hp < 0 || hp > WORM_HP) {
                    printf("ERR bad hp\n");
                } else {
                    G.worm[id].hp = hp;
                    recompute_hash(G);
                    printf("OK\n");
                }
            } else if (cmd == "SETWIND") {
                int w;
                ss >> w;
                if (w < -10 || w > 10) printf("ERR bad wind\n");
                else { G.wind = w; recompute_hash(G); printf("OK\n"); }
            } else if (cmd == "SETWATER") {
                int w;
                ss >> w;
                if (w < 0 || w > H) printf("ERR bad water\n");
                else { G.water = w; recompute_hash(G); printf("OK\n"); }
            } else {
                int id;
                ss >> id;
                if (id < 0 || id >= NW) printf("ERR bad id\n");
                else { kill_worm(G, id); recompute_hash(G); printf("OK\n"); }
            }
            fflush(stdout);
            continue;
        }

        printf("ERR unknown command\n");
        fflush(stdout);
    }
    trace_close();
    return 0;
}
#endif  // P01_ENGINE_NO_MAIN
