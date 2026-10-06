import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const baseUrl = new URL(process.env.BASE_URL || "http://127.0.0.1:3000");
const widths = [320, 390, 414, 768, 1440];
const height = 900;
const timeoutMs = 90_000;

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const candidate of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const result = spawnSync("which", [candidate], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error("Chromium not found. Set CHROME_BIN to a headless Chromium executable.");
}

const profileDir = await mkdtemp(path.join(os.tmpdir(), "wolv-responsive-"));
const chrome = spawn(findChrome(), [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-allow-origins=*",
  `--user-data-dir=${profileDir}`,
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  "about:blank",
], { stdio: "ignore" });

let ws;
let nextId = 0;
const pending = new Map();
let documentStatus = null;

function connectDevTools(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("Timed out connecting to Chromium DevTools")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to Chromium DevTools"));
    }, { once: true });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else if (message.method === "Network.responseReceived" && message.params.type === "Document") {
        documentStatus = message.params.response.status;
      }
    });
  });
}

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DevTools command timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Page evaluation failed");
  }
  return result.result.value;
}

async function waitForPage(pathname, expected) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const state = await evaluate(`(() => ({
        ready: document.readyState,
        path: location.pathname,
        title: document.title,
        bodyText: document.body?.innerText?.slice(0, 5000) ?? ""
      }))()`);
      if (state.ready === "complete" && state.path === pathname && expected.test(state.bodyText)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return state;
      }
    } catch {
      // Navigation destroys the old execution context; retry against the new document.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for page ${pathname}`);
}

async function navigate(url, expected) {
  documentStatus = null;
  const pathname = new URL(url).pathname;
  const result = await send("Page.navigate", { url });
  if (result.errorText) throw new Error(`Navigation failed for ${url}: ${result.errorText}`);
  const state = await waitForPage(pathname, expected);
  if (documentStatus != null) assert.ok(documentStatus < 400, `${url} returned HTTP ${documentStatus}`);
  assert.ok(!/Internal Server Error|Application error: a server-side exception/i.test(state.bodyText), `${url} rendered a server error`);
  return state;
}

async function run() {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  let port;
  const waitStarted = Date.now();
  while (!port && Date.now() - waitStarted < 10_000) {
    try {
      port = Number((await readFile(portFile, "utf8")).split("\n")[0]);
    } catch {
      if (chrome.exitCode != null) throw new Error(`Chromium exited with code ${chrome.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!port) throw new Error("Chromium did not publish a DevTools port");

  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  assert.ok(targetResponse.ok, `Could not create Chromium page target: HTTP ${targetResponse.status}`);
  const target = await targetResponse.json();
  await connectDevTools(target.webSocketDebuggerUrl);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  let stockPath = process.env.TEST_TOKEN_ADDRESS
    ? `/stock/${process.env.TEST_TOKEN_ADDRESS}`
    : null;
  const fixedRoutes = [
    { path: "/", expected: /TOKENIZED STOCKS|Find the price/ },
    { path: "/gap", expected: /Cross-venue price discovery|Listed vs Executable Price/ },
    { path: "/markets", expected: /Browse tokenized markets|BSC spot directory/ },
    { path: "/trade", expected: /Select an Asset to Trade/ },
    { path: "/wallet", expected: /Wallet Address|Connect your wallet|Checking wallet connection/ },
  ];

  for (const width of widths) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });

    for (const route of fixedRoutes) {
      const url = new URL(route.path, baseUrl).href;
      const state = await navigate(url, route.expected);
      assert.match(state.bodyText, route.expected, `${route.path} did not render its expected product content at ${width}px`);
      const layout = await evaluate(`(() => ({
        viewport: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        title: document.title,
        navTargets: Array.from(document.querySelectorAll('nav[aria-label="Primary navigation"] a')).map((link) => {
          const { left, right, width, height } = link.getBoundingClientRect();
          return { left, right, width, height };
        })
      }))()`);
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${route.path} overflows horizontally at ${width}px (${layout.scrollWidth}px content in ${layout.clientWidth}px viewport)`);
      if (width < 768 && layout.navTargets.length > 0) {
        assert.ok(layout.navTargets.every((target) => target.width >= 48 && target.height >= 48), `${route.path} has a primary-navigation touch target below 48px at ${width}px`);
        assert.ok(layout.navTargets.every((target) => target.left >= 0 && target.right <= layout.viewport), `${route.path} has a clipped primary-navigation target at ${width}px`);
      }

      console.log(`PASS ${width}px ${route.path} · ${layout.scrollWidth}/${layout.clientWidth}px`);
    }

    if (stockPath) {
      for (const route of [
        { path: stockPath, expected: /Live asset signal|Token not found|Live asset data unavailable/ },
        { path: stockPath.replace(/^\/stock\//, "/trade/"), expected: /Trade |Connect your wallet|Checking wallet connection|Trading asset list unavailable|Asset not found/ },
      ]) {
        const url = new URL(route.path, baseUrl).href;
        const state = await navigate(url, route.expected);
        assert.match(state.bodyText, route.expected, `${route.path} did not render expected detail content at ${width}px`);
        const layout = await evaluate(`(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))()`);
        assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${route.path} overflows horizontally at ${width}px (${layout.scrollWidth}px content in ${layout.clientWidth}px viewport)`);
        console.log(`PASS ${width}px ${route.path} · ${layout.scrollWidth}/${layout.clientWidth}px`);
      }
    }
  }

  if (!stockPath) console.warn("SKIP dynamic stock/trade detail: no stock link found on homepage; set TEST_TOKEN_ADDRESS to include these routes.");
  console.log(`Responsive smoke passed for ${baseUrl.origin} at ${widths.join(", ")}px. No wallet connection or transaction was attempted.`);
}

try {
  await run();
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  if (chrome.exitCode == null && chrome.signalCode == null) {
    chrome.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
