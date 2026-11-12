# Remotion 接入

观战器把“某一帧的画面”做成确定性函数：同一个 trace 加同一个帧号，应得到同一张画面。Remotion 只需要逐帧驱动它。

前置条件：先在仓库根目录启动服务。样例 `demo-4seat.json` 不需要题目包，仅回放模式即可。

```bat
python server\app.py --no-open
```

不要用 `--host 0.0.0.0` 暴露服务，见主 [README](../README.md) 的安全提示。

## 方案 A：iframe + seekFrame

```tsx
import { useEffect, useRef, useState } from "react";
import { AbsoluteFill, useCurrentFrame, delayRender, continueRender } from "remotion";

export const P01Scene = () => {
  const frame = useCurrentFrame();
  const ref = useRef<HTMLIFrameElement>(null);
  const [handle] = useState(() => delayRender("p01 viewer"));

  useEffect(() => {
    const win: any = ref.current?.contentWindow;
    if (!win) return;
    win.__P01V__.ready.then(async () => {
      await win.__P01V__.loadTrace("/traces/samples/demo-4seat.json");
      win.__P01V__.setUI(false);
      win.__P01V__.setCamera("full");
      continueRender(handle);
    });
  }, []);

  useEffect(() => {
    const win: any = ref.current?.contentWindow;
    win?.__P01V__?.seekFrame(frame);
  }, [frame]);

  return (
    <AbsoluteFill>
      <iframe
        ref={ref}
        src="http://127.0.0.1:8765/?ui=0&autoplay=0&camera=full&muted=1"
        style={{ width: 1920, height: 1080, border: 0 }}
      />
    </AbsoluteFill>
  );
};
```

说明：

- 这段代码是接入思路的示意，未在 Remotion 工程里实际跑过；`iframe` 的 `contentWindow` 需要同源或允许访问，请按你的工程调整。
- 画面逻辑分辨率 960 x 540，CSS 放大并保持像素风。
- `?ui=0` 隐藏 HUD 只留画布；画布本身不透明，`bg=<css 颜色>` 只改页面背景色变量，不能得到透明背景。
- `seekFrame` 会先暂停再同步绘制到指定帧。
- Remotion 渲染建议加 `muted=1`。

## 方案 B：PNG 序列

用 Node + Puppeteer（本仓库不内置依赖）循环 `seekFrame(i)` 再 `capture()` 导出：

```js
import puppeteer from "puppeteer";
import fs from "node:fs";

fs.mkdirSync("frames", { recursive: true });
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto("http://127.0.0.1:8765/?trace=/traces/samples/demo-4seat.json&ui=0&autoplay=0&muted=1");
await page.evaluate(() => window.__P01V__.ready);
const total = await page.evaluate(() => window.__P01V__.getFrameCount());
for (let i = 0; i < total; i++) {
  const data = await page.evaluate((n) => {
    window.__P01V__.seekFrame(n);
    return window.__P01V__.capture();
  }, i);
  fs.writeFileSync(`frames/${String(i).padStart(5, "0")}.png`,
                   Buffer.from(data.split(",")[1], "base64"));
}
await browser.close();
```

`capture()` 导出的是 960 x 540 的画布内容。该脚本同样未在本仓库中实际运行验证。

## URL 参数

`trace`、`frame`、`autoplay`（`0` 或 `1`）、`ui`（`0` 隐藏 HUD）、`debug`（`1`）、`camera`（`full` / `auto` / `follow:<seat>` / `manual`）、`speed`、`muted`（`1` 强制静音）、`bg`。带 `frame` 时页面加载后会停在该帧。

## `window.__P01V__` API

```ts
window.__P01V__ = {
  ready: Promise<void>,
  loadTrace(url): Promise<...>,        // 载入 trace 并停在第 0 帧，不自动播放
  getMeta(),                           // 当前 trace 的 meta
  getFrameCount(): number,
  seekFrame(n): void,                  // 暂停并同步绘制到第 n 帧
  renderFrame(n): void,                // 同 seekFrame
  play(), pause(), setSpeed(x),
  setCamera("full" | "auto" | "follow:<seat>" | "manual"),
  setUI(on), setDebug(on), setMuted(on),
  getFrameInfo(): { frame, total, round, wind, water, phase, tick, stateHash,
                    camera, playing, speed, camRect },
  getKeyMoments(): { frame, round, tick, type, label, seat }[],
  capture(): string                    // PNG dataURL
};
```

此外还暴露了调试用的 `timeline`、`trace`、`renderer`、`camera`、`getFrame(i)`、`getTerrainSnapshot(i)`。

## 关键事件对齐

`getKeyMoments()` 返回的 `frame` 是烘焙后的帧号，可以直接映射到 Remotion 的 `Sequence from={frame}`。`type` 取值：`fire`、`explode`、`hurt`、`kill`、`water`、`end`。例如给每次爆炸加字幕或音效：

```js
const moments = await page.evaluate(() => window.__P01V__.getKeyMoments());
moments.filter((m) => m.type === "explode").forEach((m) => {
  // <Sequence from={m.frame} durationInFrames={30}>...</Sequence>
});
```

帧号基于每秒 60 帧的时间轴；如果你的 Remotion 合成不是 60 fps，需要自行换算。
