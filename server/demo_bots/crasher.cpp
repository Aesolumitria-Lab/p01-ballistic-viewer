// P01 visual demo bot: 0.1s 后直接退出，用于验证 runner 的 dead_bots 容错。
// 不读输入、不回答任何 TURN；进程存活 100ms 后退出。
#include <chrono>
#include <thread>

int main() {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    return 0;
}
