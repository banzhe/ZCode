import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/composer-request-metrics.fixture.tsx";
const TRIGGER = "chat-request-metrics-trigger";
const PANEL = "chat-request-metrics-panel";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/composer-request-metrics");

// 面板行文案按 locale 断言：数值由 fixture 固定，避免测试与实现互相推导。
const LABELS = {
  "en-US": [
    "Latest request",
    "Decode TPS",
    "Time to first token (TTFT)",
    "TPS incl. TTFT",
    "Request body",
    "Body send time",
    "zstd (this request)",
    "Session average and total",
    "Average decode TPS",
    "Average TPS incl. TTFT",
    "Average TTFT",
    "Average body",
    "Total body",
    "Average send time",
    "Total send time",
    "zstd ratio",
  ],
  "zh-CN": [
    "最近一次请求",
    "解码 TPS",
    "首字耗时（TTFT）",
    "含首字 TPS",
    "请求体大小",
    "请求体发送耗时",
    "zstd（本次）",
    "会话平均与累计",
    "平均解码 TPS",
    "平均含首字 TPS",
    "平均首字耗时",
    "平均请求体",
    "总请求体",
    "平均发送耗时",
    "总发送耗时",
    "zstd 压缩率",
  ],
};

let server;
let browser;
let origin;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "request-metrics-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

for (const width of [390, 1200])
  for (const theme of ["light", "dark"]) {
    const locale = width === 390 ? "zh-CN" : "en-US";
    test(`RQM01 pill ${width}/${theme}`, async () => {
      const viewportHeight = 1000;
      const page = await browser.newPage({ viewport: { width, height: viewportHeight } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);

        const trigger = page.getByTestId(TRIGGER);
        await trigger.waitFor();
        // 最近一次请求的解码 TPS 与单位必须在药丸上可见。
        assert.equal((await trigger.innerText()).trim(), "42.1 t/s");

        await trigger.hover();
        const panel = page.getByTestId(PANEL);
        await panel.waitFor();
        const panelText = await panel.innerText();
        for (const label of LABELS[locale]) assert.ok(panelText.includes(label), label);
        // 上传耗时与 TTFT 必须分别展示，不能被「到响应头」口径合并。
        assert.ok(panelText.includes("320 ms"));
        assert.ok(panelText.includes("850 ms"));
        assert.ok(panelText.includes("38.4 t/s"));
        assert.ok(panelText.includes("1.2 s"));

        // 面板不得超出视口，也不得让页面横向溢出。
        const box = await panel.boundingBox();
        assert.ok(box, "panel must have a layout box");
        assert.ok(box.y >= -1, `panel top ${box.y}`);
        assert.ok(box.y + box.height <= viewportHeight + 1, `panel bottom ${box.y + box.height}`);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );

        await page.screenshot({ path: join(artifacts, `${width}-${theme}.png`), fullPage: true });

        // 切到没有指标的任务：药丸必须消失，不能残留上一个任务的数字。
        await page.getByText("Switch task", { exact: true }).click();
        await trigger.waitFor({ state: "detached" });
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
