// P01 visual demo bot: cycles ROCKET / GRENADE / DRILL so the viewer can
// exercise every projectile effect. Deterministic, no search.
#include <cstdlib>
#include <string>
#include "arena4.hpp"

int main() {
    arena4::State S;
    while (arena4::read_turn(std::cin, S)) {
        const int act = S.first_own_alive();
        if (act < 0 || S.over) { std::cout << (S.seat * 3) << " WAIT" << std::endl; continue; }
        const int enemy = S.nearest_enemy(act);
        int angle = 90, power = 65;
        if (enemy >= 0) {
            const arena4::Worm &e = S.worm[enemy];
            arena4::Aim a = arena4::aim_at(S.worm[act].x, S.worm[act].y, e.x, e.y,
                                           S.wind, S.water, S.grid_or_null());
            angle = a.angle; power = a.power;
        }
        const char *wpn = "ROCKET";
        const int phase = (S.round + S.seat) % 3;
        if (phase == 1 && S.worm[act].grenades > 0) wpn = "GRENADE";
        if (phase == 2 && S.worm[act].drills > 0) wpn = "DRILL";
        if (wpn[0] == 'D') { angle = 45; power = 50; }
        std::cout << act << " F " << wpn << " " << angle << " " << power << std::endl;
    }
    return 0;
}
