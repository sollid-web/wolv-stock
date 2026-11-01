import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const responsiveFixturePath = path.join(projectRoot, "scripts", "responsive-fixtures.mjs");
const widths = [320, 360, 390, 414, 768, 1024, 1440];
const height = 900;
const timeoutMs = 90_000;
const serverTimeoutMs = 120_000;
const fixtureTokenAddress = "0x0000000000000000000000000000000000000123";
const unavailableTokenAddress = "0x0000000000000000000000000000000000000124";
const missingTokenAddress = "0x0000000000000000000000000000000000000099";
const mockWalletAddress = "0x1234567890abcdef1234567890abcdef12345678";

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const candidate of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const result = spawnSync("which", [candidate], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error("Chromium not found. Set CHROME_BIN to a headless Chromium executable.");
}

let baseUrl;
const profileDirs = [];
let chrome;
let ws;
let nextId = 0;
const pending = new Map();
let documentStatus = null;
let server;
let serverOutput = "";

function testEnvironment() {
  return {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_WALLET_PROJECT_ID: "",
    WOLV_RESPONSIVE_FIXTURE: "",
    BAW_EXECUTION_ENABLED: "false",
    BAW_WALLET_API_TOKEN: "",
    WOLV_TRADING_DATABASE_URL: "",
    BAW_EXECUTION_DATABASE_URL: "",
  };
}

function runBuild() {
  console.log("Building the production app for responsive verification…");
  const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build", "--webpack"], {
    cwd: projectRoot,
    env: testEnvironment(),
    stdio: "inherit",
    timeout: 1_200_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Production build failed with exit code ${result.status}`);
}

async function findAvailablePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function appendServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
}

async function startProductionServer() {
  const port = await findAvailablePort();
  baseUrl = new URL(`http://127.0.0.1:${port}`);
  server = spawn(process.execPath, [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: projectRoot,
    env: {
      ...testEnvironment(),
      PORT: String(port),
      WOLV_RESPONSIVE_FIXTURE: "1",
      BINANCE_API_KEY: "responsive-fixture-key",
      BINANCE_SECRET_KEY: "responsive-fixture-secret",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${responsiveFixturePath}`].filter(Boolean).join(" "),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.setEncoding("utf8").on("data", appendServerOutput);
  server.stderr.setEncoding("utf8").on("data", appendServerOutput);
  server.once("error", (error) => appendServerOutput(`\nServer process error: ${error.message}`));

  const startedAt = Date.now();
  while (Date.now() - startedAt < serverTimeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(`Production server exited with code ${server.exitCode} before becoming healthy.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(3_000) });
      if (response.status === 200) {
        console.log(`Production server healthy at ${baseUrl.origin}`);
        return;
      }
      appendServerOutput(`\nHealth check returned HTTP ${response.status}`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Production server did not become healthy within ${serverTimeoutMs}ms.\n${serverOutput}`);
}

async function stopChild(child, name) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`${name} did not stop after SIGTERM/SIGKILL`);
  }
}

async function startChrome() {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "wolv-responsive-"));
  profileDirs.push(profileDir);
  chrome = spawn(findChrome(), [
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
  await send("Network.setBlockedURLs", {
    urls: [
      "*://*/api/agent/quote*",
      "*://*/api/agent/approve*",
      "*://*/api/agent/execute*",
      "*://*/api/quote*",
      "*://*/api/swap*",
      "*://*/api/order/submit*",
      "*://*/api/approve-transaction*",
      "*://*/api/transaction/broadcast*",
    ],
  });
}

async function stopChrome() {
  for (const request of pending.values()) clearTimeout(request.timer);
  pending.clear();
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  ws = undefined;
  await stopChild(chrome, "Chromium");
  chrome = undefined;
  documentStatus = null;
}

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
  let lastState;
  while (Date.now() - started < timeoutMs) {
    try {
      const state = await evaluate(`(() => ({
        ready: document.readyState,
        path: location.pathname,
        title: document.title,
        bodyText: document.body?.innerText?.slice(0, 5000) ?? ""
      }))()`);
      lastState = state;
      if (state.ready !== "loading" && state.path === pathname && expected.test(state.bodyText)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return state;
      }
    } catch {
      // Navigation destroys the old execution context; retry against the new document.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for page ${pathname}; last page state: ${JSON.stringify(lastState ?? null)}; ` +
    `document HTTP status: ${documentStatus ?? "unknown"}.\n${serverOutput}`,
  );
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

async function waitForCondition(expression, label, timeout = timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const result = await evaluate(expression);
      if (result) return result;
    } catch {
      // The client may replace the execution context while rendering.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function clickButton(label) {
  const clicked = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find((item) => item.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `Could not click enabled "${label}" button`);
}

async function runTradeRefusalChecks() {
  const script = `(() => {
    const account = ${JSON.stringify(mockWalletAddress)};
    let connected = sessionStorage.getItem("__WOLV_RESPONSIVE_WALLET_CONNECTED") === "1";
    window.__WOLV_WALLET_CALLS = [];
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method }) => {
        window.__WOLV_WALLET_CALLS.push(method);
        if (method === "eth_chainId") return "0x38";
        if (method === "net_version") return "56";
        if (method === "eth_accounts") return connected ? [account] : [];
        if (method === "eth_requestAccounts") {
          connected = true;
          sessionStorage.setItem("__WOLV_RESPONSIVE_WALLET_CONNECTED", "1");
          return [account];
        }
        if (method === "wallet_switchEthereumChain") return null;
        if (["eth_sendTransaction", "eth_signTypedData", "eth_signTypedData_v4", "personal_sign"].includes(method)) {
          throw new Error("Responsive test blocked wallet mutation");
        }
        return null;
      },
      on() {},
      removeListener() {},
    };

    const originalFetch = window.fetch.bind(window);
    window.__WOLV_QUOTE_MODE = "fresh";
    window.__WOLV_API_CALLS = [];
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.origin);
      if (url.pathname.startsWith("/api/")) window.__WOLV_API_CALLS.push(url.pathname);
      if (url.pathname === "/api/quote") {
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (window.__WOLV_QUOTE_MODE === "error") {
          return new Response(JSON.stringify({ error: "Responsive mock quote unavailable" }), { status: 502, headers: { "content-type": "application/json" } });
        }
        const amount = url.searchParams.get("amount");
        const quoteFetchedAt = window.__WOLV_QUOTE_MODE === "expired" ? Date.now() - 60000 : Date.now();
        return new Response(JSON.stringify({
          quoteId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          quoteBinding: "responsive-mock-binding",
          executionIntentId: "11111111-1111-4111-8111-111111111111",
          status: "QUOTED",
          executionEligibility: "NOT_AVAILABLE",
          quoteFetchedAt,
          quoteExpiresAt: quoteFetchedAt + 30000,
          executionMode: "RFQ",
          fromTokenAmount: amount,
          toTokenAmount: "1234567",
          fromToken: { tokenUnitPrice: "1", decimal: "18" },
          toToken: { decimal: "6" },
          tradeIntent: {
            direction: "BUY",
            chainId: 56,
            fromTokenAddress: "0x55d398326f99059ff775485246999027b3197955",
            toTokenAddress: ${JSON.stringify(fixtureTokenAddress)},
            fromTokenMetadata: {
              chainId: "56",
              tokenAddress: "0x55d398326f99059ff775485246999027b3197955",
              decimals: 18,
              resolutionSource: "BSC_ETH_CALL",
              blockNumber: "100",
              resolvedAt: quoteFetchedAt,
              validationStatus: "VALIDATED",
            },
            toTokenMetadata: {
              chainId: "56",
              tokenAddress: ${JSON.stringify(fixtureTokenAddress)},
              decimals: 6,
              resolutionSource: "BSC_ETH_CALL",
              blockNumber: "100",
              resolvedAt: quoteFetchedAt,
              validationStatus: "VALIDATED",
            },
            inputAmount: amount,
            expectedOutputAmount: "1234567",
            minimumOutputAmount: "1230000",
            slippageBps: 50
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (/^\\/api\\/(?:approve-transaction|swap|order\\/submit|transaction\\/broadcast|agent\\/(?:approve|execute))/.test(url.pathname)) {
        window.__WOLV_API_CALLS.push(url.pathname);
        return new Response(JSON.stringify({ error: "Responsive test blocked execution endpoint" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    };
  })()`;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: script });
  await navigate(new URL(`/trade/${fixtureTokenAddress}`, baseUrl).href, /Connect your wallet|Checking wallet connection/);
  await waitForCondition(
    `document.body.innerText.includes("Connect your wallet")`,
    "disconnected wallet refusal state",
  );
  assert.equal(await evaluate(`Array.from(document.querySelectorAll("button")).some((button) => button.innerText.trim() === "Get Quote")`), false);
  console.log("PASS trade UI disconnected wallet · quote action unavailable");

  await clickButton("Connect browser wallet");
  await waitForCondition(
    `document.body.innerText.includes("Disconnect") && document.body.innerText.includes("Connected")`,
    "mock wallet connection",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder="Enter USDT amount"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "10");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitForCondition(
    `Array.from(document.querySelectorAll("button")).some((button) => button.innerText.trim() === "Get Quote" && !button.disabled)`,
    "enabled quote action",
  );
  await clickButton("Get Quote");
  await waitForCondition(
    `Array.from(document.querySelectorAll("button")).some((button) => button.innerText.trim() === "Fetching...")`,
    "quote loading state",
  );
  console.log("PASS trade UI · quote loading state");
  await waitForCondition(
    `document.body.innerText.includes("Quote only — no transaction submitted.")`,
    "unsupported execution refusal",
  );
  const freshQuote = await evaluate(`(() => ({
    text: document.body.innerText,
    buttons: Array.from(document.querySelectorAll("button")).map((button) => button.innerText.trim()),
    dialogs: document.querySelectorAll('[role="dialog"], dialog').length,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    clientWidth: document.documentElement.clientWidth
  }))()`);
  assert.match(freshQuote.text, /QUOTED/);
  assert.match(freshQuote.text, /1\.234567 TEST/);
  assert.match(freshQuote.text, /Approved minimum output: 1\.23 TEST/);
  assert.doesNotMatch(freshQuote.text, /Sign & Execute Trade|Approve USDT|Sign Typed Data/);
  assert.equal(freshQuote.dialogs, 0, "A transaction dialog appeared while execution is unsupported");
  assert.ok(freshQuote.scrollWidth <= freshQuote.clientWidth + 1, "The quote/refusal UI overflows horizontally");
  console.log("PASS trade UI connected wallet · accurate 6-decimal quote shown · execution unavailable");

  await evaluate(`(() => { window.__WOLV_QUOTE_MODE = "expired"; })()`);
  await clickButton("Get Quote");
  await waitForCondition(`document.body.innerText.includes("EXPIRED")`, "expired quote refusal");
  assert.equal(await evaluate(`Array.from(document.querySelectorAll("button")).some((button) => /Sign & Execute Trade|Approve USDT|Sign Typed Data/.test(button.innerText))`), false);
  console.log("PASS trade UI · expired quote remains non-executable");

  await evaluate(`(() => { window.__WOLV_QUOTE_MODE = "error"; })()`);
  await clickButton("Get fresh quote");
  await waitForCondition(`document.body.innerText.includes("Responsive mock quote unavailable")`, "quote error state");
  const prohibitedCalls = await evaluate(`(() => ({
    wallet: window.__WOLV_WALLET_CALLS.filter((method) => /sendTransaction|signTypedData|personal_sign/.test(method)),
    api: window.__WOLV_API_CALLS.filter((pathname) => pathname !== "/api/quote")
  }))()`);
  assert.deepEqual(prohibitedCalls.wallet, [], "A wallet signing or transaction method was called");
  assert.deepEqual(prohibitedCalls.api, [], "A transaction/approval endpoint was called");
  console.log("PASS trade UI · quote error shown · no signing, approval, swap, or broadcast attempted");
}

async function runAgentRefusalChecks() {
  const script = `(() => {
    const account = ${JSON.stringify(mockWalletAddress)};
    let connected = sessionStorage.getItem("__WOLV_RESPONSIVE_WALLET_CONNECTED") === "1";
    window.__WOLV_AGENT_WALLET_CALLS = [];
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method }) => {
        window.__WOLV_AGENT_WALLET_CALLS.push(method);
        if (method === "eth_chainId") return "0x38";
        if (method === "net_version") return "56";
        if (method === "eth_accounts") return connected ? [account] : [];
        if (method === "eth_requestAccounts") {
          connected = true;
          sessionStorage.setItem("__WOLV_RESPONSIVE_WALLET_CONNECTED", "1");
          return [account];
        }
        if (method === "wallet_switchEthereumChain") return null;
        if (["personal_sign", "eth_sign"].includes(method)) return "0x" + "11".repeat(65);
        if (method === "eth_sendTransaction" || method.startsWith("eth_signTypedData")) {
          throw new Error("Responsive test blocked transaction signing or submission");
        }
        return null;
      },
      on() {},
      removeListener() {},
    };
    const originalFetch = window.fetch.bind(window);
    window.__WOLV_AGENT_ACTIONS = [];
    window.__WOLV_AGENT_ENDPOINTS = [];
    window.__WOLV_AGENT_SESSION_AUTHORIZED = false;
    window.__WOLV_AGENT_SESSION_REQUESTS = [];
    window.__WOLV_AGENT_QUOTE_MODE = "rejected";
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.origin);
      const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.pathname === "/api/agent/execute" && method === "GET") {
        return new Response(JSON.stringify({
          executionMode: "wallet-confirmation",
          agentIdentity: { standard: "ERC-8004", registrationId: null, status: "not-registered" },
          commerce: { standard: "ERC-8183", jobId: null, status: "disabled" },
          sessionKey: { status: "disabled", reason: "Agent signing is not enabled." },
          x402: { status: "disabled", reason: "No autonomous job is created." },
          walletProviders: {
            altana: { sdkAvailable: false, configured: false },
            twak: { sdkAvailable: false, configured: false }
          },
          recentTransactions: []
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/agent/session" && method === "GET") {
        const fixtureAuthenticated = window.__WOLV_AGENT_SESSION_AUTHORIZED === true;
        window.__WOLV_AGENT_SESSION_REQUESTS.push({ fixtureAuthenticated, method });
        return new Response(JSON.stringify(fixtureAuthenticated
          ? { authenticated: true, address: ${JSON.stringify(mockWalletAddress)} }
          : { error: "BAW session is not authorized." }), {
          status: fixtureAuthenticated ? 200 : 401,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.pathname === "/api/agent/session/challenge" && method === "POST") {
        return new Response(JSON.stringify({ message: "Responsive mock wallet challenge" }), {
          headers: { "content-type": "application/json" }
        });
      }
      if (url.pathname === "/api/agent/session" && method === "POST") {
        window.__WOLV_AGENT_SESSION_AUTHORIZED = true;
        return new Response(JSON.stringify({
          authenticated: true,
          address: ${JSON.stringify(mockWalletAddress)}
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/agent/session" && method === "DELETE") {
        window.__WOLV_AGENT_SESSION_AUTHORIZED = false;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/api/agent/wallet" && method === "GET") {
        return new Response(JSON.stringify({
          connected: true,
          fetchedAt: new Date().toISOString(),
          chains: [{ binanceChainId: "56", name: "BNB Smart Chain", simpleName: "BSC" }],
          addresses: [],
          balances: [],
          settings: null,
          errors: []
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/agent/control" && method === "GET") {
        const stopReason = "Responsive fixture global stop state";
        return new Response(JSON.stringify({
          control: {
            emergency_stop: true,
            stop_monitoring: true,
            reject_new_opportunities: true,
            stop_reason: stopReason,
            permission_expires_at: null,
            permission_active: false,
            updated_at: Date.now()
          },
          activity: [],
          nextCursor: null,
          proposals: [],
          policyRefusals: [],
          observations: [],
          activePolicy: null,
          opportunities: [],
          analyses: [],
          strategyEvaluations: [],
          execution: { enabled: false, status: "EXECUTION_BLOCKED" },
          configuration: {
            orchestrationEnabled: false,
            collectorEnabled: false,
            databaseConfigured: true
          }
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/agent/execute" && method === "POST") {
        const body = JSON.parse(init.body);
        window.__WOLV_AGENT_ACTIONS.push(body.action);
        if (body.action === "simulate" || body.action === "preview") {
          return new Response(JSON.stringify({
            requestId: "responsive-mock-draft",
            status: body.action === "simulate" ? "mock-evaluated" : "local-draft",
            strategy: {
              side: "buy",
              ticker: "AAPL",
              amount: "0.1",
              amountUnit: "BNB",
              triggerDirection: "down",
              triggerPercent: 2,
              maxSlippagePercent: 1
            },
            execution: { mode: "wallet-confirmation", transactionBroadcast: false, automatedExecution: false },
            ...(body.action === "simulate" ? { mockTrigger: { triggered: true, changePercent: -2 } } : {})
          }), { headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: "Responsive fixture blocked execution." }), { status: 503, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/agent/quote" && method === "POST") {
        window.__WOLV_AGENT_ENDPOINTS.push("quote");
        if (window.__WOLV_AGENT_QUOTE_MODE === "rejected") {
          return new Response(JSON.stringify({
            status: "REJECTED",
            eligibility: "REJECTED",
            rejectionReasons: ["Provider semantics are not verified."],
            error: "Provider semantics are not verified."
          }), { status: 422, headers: { "content-type": "application/json" } });
        }
        const quoteFetchedAt = Date.now() - 60000;
        return new Response(JSON.stringify({
          status: "QUOTED",
          eligibility: "ELIGIBLE",
          rejectionReasons: [],
          direction: "BUY",
          chainId: "56",
          tokenAddress: ${JSON.stringify(fixtureTokenAddress)},
          underlyingTicker: "TEST",
          walletAddress: ${JSON.stringify(mockWalletAddress)},
          fromTokenAddress: "0x55d398326f99059ff775485246999027b3197955",
          toTokenAddress: ${JSON.stringify(fixtureTokenAddress)},
          fromCoinSymbol: "USDT",
          fromCoinAmount: "5",
          toCoinSymbol: "TESTon",
          toCoinAmount: "0.05",
          slippage: 0.01,
          slippageBps: 100,
          tokenPriceUsd: 100,
          referencePrice: 100,
          referenceGapPercent: 0,
          tokenDecimals: 6,
          quoteFetchedAt,
          expiresAt: quoteFetchedAt + 30000,
          quoteBindingId: "a".repeat(64),
          quoteBinding: "responsive-mock-binding",
          execution: { transactionSubmitted: false, signingRequested: false }
        }), { headers: { "content-type": "application/json" } });
      }
      if (/^\\/api\\/agent\\/(?:approve|execute)$/.test(url.pathname)) {
        window.__WOLV_AGENT_ENDPOINTS.push(url.pathname.slice("/api/agent/".length));
        return new Response(JSON.stringify({ status: "REJECTED", error: "Responsive fixture blocked BAW actions." }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    };
  })()`;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: script });
  await navigate(new URL("/agent", baseUrl).href, /(?=.*Deterministic risk policy)(?=.*Quote only — no transaction submitted)/s);
  await waitForCondition(
    `document.body.innerText.includes("A short-lived browser-wallet session is required for control changes.")`,
    "unauthorized BAW quote refusal",
  );
  assert.equal(await evaluate(`window.__WOLV_AGENT_ENDPOINTS.includes("quote")`), false);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll("button")).some((button) => button.innerText.trim() === "Authorize control plane")`), true);
  console.log("PASS agent terminal · disconnected BAW authorization disables quote request");

  await navigate(new URL("/wallet", baseUrl).href, /Connect your wallet|Wallet connection/);
  await waitForCondition(
    `Array.from(document.querySelectorAll("button")).some((button) => button.innerText.trim().startsWith("Connect browser wallet") && !button.disabled)`,
    "enabled mock wallet connect action",
  );
  await clickButton("Connect browser wallet");
  await waitForCondition(
    `document.body.innerText.includes("Wallet Address") && document.body.innerText.includes("Disconnect Wallet")`,
    "mock browser wallet connection",
  );
  await navigate(new URL("/agent", baseUrl).href, /(?=.*Deterministic risk policy)(?=.*Quote only — no transaction submitted)/s);
  await waitForCondition(
    `document.body.innerText.includes("Authorize control plane")`,
    "connected browser wallet authorization action",
  );
  await clickButton("Authorize control plane");
  await waitForCondition(
    `document.body.innerText.includes("Emergency controls") && document.body.innerText.includes("EXECUTION_BLOCKED")`,
    "authorized persistent control-plane dashboard",
  );
  const agentState = await evaluate(`(() => ({
    text: document.body.innerText,
    actions: window.__WOLV_AGENT_ACTIONS,
    endpoints: window.__WOLV_AGENT_ENDPOINTS,
    executionButtons: Array.from(document.querySelectorAll("button")).map((button) => button.innerText.trim()).filter((label) => /Approve and Execute|Review and prepare/.test(label))
  }))()`);
  assert.match(agentState.text, /Emergency controls/);
  assert.match(agentState.text, /Pending proposals/);
  assert.match(agentState.text, /Opportunity queue/);
  assert.match(agentState.text, /Persisted activity/);
  assert.match(agentState.text, /EXECUTION_BLOCKED/);
  assert.deepEqual(agentState.executionButtons, []);
  console.log("PASS agent terminal · authorized control plane remains execution-blocked and exposes proposal/policy controls");
}

async function run() {
  const fixedRoutes = [
    { path: "/", expected: /TOKENIZED STOCKS|Find the price/ },
    { path: "/gap", expected: /Cross-venue price discovery|Listed vs Indicative Estimate/ },
    { path: "/markets", expected: /Browse tokenized markets|BSC spot directory/ },
    { path: "/trade", expected: /Select an Asset to Trade/ },
    { path: "/wallet", expected: /Wallet Address|Connect your wallet|Checking wallet connection/ },
    { path: "/agent", expected: /(?=.*Deterministic risk policy)(?=.*Quote only — no transaction submitted)/s },
  ];

  for (const width of widths) {
    await startChrome();
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

    for (const route of [
      { path: `/stock/${fixtureTokenAddress}`, expected: /Live asset signal/i },
      { path: `/trade/${fixtureTokenAddress}`, expected: /Trade TEST|Connect your wallet|Checking wallet connection/ },
      { path: "/stock/not-a-contract", expected: /Token not found/ },
      { path: "/trade/not-a-contract", expected: /Asset not found/ },
      { path: `/stock/${missingTokenAddress}`, expected: /Token not found/ },
      { path: `/trade/${missingTokenAddress}`, expected: /Asset not found/ },
      { path: `/stock/${unavailableTokenAddress}`, expected: /Live asset signal.*(?:Indicative )?quote unavailable.*(?:no route|no valid market route)/is },
    ]) {
        const url = new URL(route.path, baseUrl).href;
        const state = await navigate(url, route.expected);
        assert.match(state.bodyText, route.expected, `${route.path} did not render expected detail content at ${width}px`);
        const layout = await evaluate(`(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))()`);
        assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${route.path} overflows horizontally at ${width}px (${layout.scrollWidth}px content in ${layout.clientWidth}px viewport)`);
        console.log(`PASS ${width}px ${route.path} · ${layout.scrollWidth}/${layout.clientWidth}px`);
    }
    await stopChrome();
  }

  await startChrome();
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await runTradeRefusalChecks();
  await stopChrome();
  await startChrome();
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await runAgentRefusalChecks();
  console.log(`Responsive smoke passed for ${baseUrl.origin} at ${widths.join(", ")}px. All provider data was mocked; no signature or transaction was submitted.`);
}

try {
  runBuild();
  await startProductionServer();
  await run();
} finally {
  try {
    await stopChrome();
  } finally {
    try {
      await stopChild(server, "Next.js production server");
    } finally {
      await Promise.all(profileDirs.map((profileDir) => rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
    }
  }
}
