import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    createBawRunner,
    parseAddresses,
    parseBalances,
    parseChains,
    parseSettings,
    parseWalletStatus,
    readWalletSnapshot,
    buildBawMarketQuoteArgs,
    buildBawMarketSwapArgs,
    buildBawMarketOrderListArgs,
    parseBawMarketSwapArgs,
    parseBawMarketOrderListArgs,
    buildBawMarketOrderReconciliationArgs,
    parseBawMarketOrderHistoryOutput,
    parseBawMarketOrderSubmitOutput,
    parseBawMarketOrderListOutput,
} from "../services/bawCli.ts";

function jsonPayload(data) {
    return JSON.stringify({ success: true, data });
}

function createRunner(outputs) {
    const calls = [];
    return {
        calls,
        runner: async (args) => {
            calls.push(args.join(" "));
            const key = args.slice(0, 2).join(" ");
            const next = outputs[key];
            if (next === undefined) {
                throw Object.assign(new Error("unexpected command"), { code: "ENOENT" });
            }
            return { stdout: jsonPayload(next) };
        },
    };
}

const CHAINS = [
    { binanceChainId: "56", name: "BNB Smart Chain", simpleName: "BSC" },
    { binanceChainId: "CT_501", name: "Solana", simpleName: "Solana" },
];

const ADDRESSES = {
    addresses: [
        { binanceChainId: "56", chainName: "BSC", address: "0x1234567890abcdef1234567890abcdef12345678" },
        { binanceChainId: "CT_501", chainName: "Solana", address: "EhFh6YfvcCMuFjRbnxT3pFvixWJF9YVXTscMJLCwTbA" },
    ],
};

const BALANCES = [
    { symbol: "USDT", address: "0x55d398326f9eF775485cA35bE4551F3f38b12345", binanceChainId: "56", balance: "1000.50", price: "1.0", value: "1000.50" },
    { symbol: "GHOST", address: "0xabc0000000000000000000000000000000000123", binanceChainId: "56", balance: "0", price: "0", value: "0" },
];

const SETTINGS = {
    maxSigninDuration: "48h",
    inactiveSignoutDuration: "48h",
    dailyLimit: 50000,
    quotaUsed: 0,
    quotaLeft: 50000,
    abnormalTxnHandling: "AutoReject",
    tradeAllTokens: false,
    predictionEnabled: false,
    devMode: { enabled: false, expiresAt: null, balanceExceeded: false },
    sessionExpireTime: "2026-11-01T19:14:00+01:00",
};

function connectedRunner(overrides = {}) {
    return createRunner({
        "wallet status": { status: "CONNECTED" },
        "wallet chains": CHAINS,
        "wallet address": ADDRESSES,
        "wallet balance": BALANCES,
        "wallet settings": SETTINGS,
        ...overrides,
    });
}

async function createStubBinary(t, source) {
      const directory = await mkdtemp(join(tmpdir(), "wolv-baw-stub-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const binary = join(directory, "baw-stub");
      await writeFile(binary, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
      return { binary, directory };
}

test("readWalletSnapshot short-circuits to connected=false without further commands when unconnected", async () => {
    const { calls, runner } = createRunner({ "wallet status": { status: "UNCONNECTED" } });
    const snapshot = await readWalletSnapshot({ runner, now: () => 1_000 });
    assert.equal(snapshot.connected, false);
    assert.deepEqual(snapshot.chains, []);
    assert.equal(calls.length, 1);
});

test("readWalletSnapshot aggregates sanitized sections for a connected wallet", async () => {
    const { calls, runner } = connectedRunner();
    const snapshot = await readWalletSnapshot({ runner, now: () => 1_000 });
    assert.equal(snapshot.connected, true);
    assert.equal(snapshot.fetchedAt, new Date(1_000).toISOString());
    assert.deepEqual(snapshot.chains, CHAINS);
    assert.equal(snapshot.addresses.length, 2);
    assert.equal(snapshot.addresses[0].address, "0x1234567890abcdef1234567890abcdef12345678");
    assert.equal(snapshot.addresses[1].address, "EhFh6YfvcCMuFjRbnxT3pFvixWJF9YVXTscMJLCwTbA");
    assert.equal(snapshot.balances.length, 2);
    assert.equal(snapshot.balances[0].valueUsd, "1000.50");
    assert.equal(snapshot.settings.dailyLimit, 50000);
    assert.deepEqual(snapshot.errors, []);
    const expected = ["wallet status --json", "wallet chains --json", "wallet address --json", "wallet balance --json", "wallet settings --json"];
    assert.deepEqual(calls, expected);
});

test("readWalletSnapshot continues on a failing section and records a structured error", async () => {
    const base = connectedRunner();
    const runner = async (args) => {
        if (args[0] === "wallet" && args[1] === "balance") {
            return { stdout: JSON.stringify({ success: false, message: "balance lookup failed" }) };
        }
        return base.runner(args);
    };
    const snapshot = await readWalletSnapshot({ runner, now: () => 1_000 });
    assert.equal(snapshot.connected, true);
    assert.equal(snapshot.balances.length, 0);
    assert.deepEqual(snapshot.errors, [{ section: "balances", code: "BAW_COMMAND_FAILED" }]);
});

test("runJson rejects non-JSON, success=false, and malformed envelopes as INVALID_OUTPUT or BAW_COMMAND_FAILED", async () => {
    const malformed = createRunner({ "wallet status": { status: "CONNECTED" } });
    malformed.runner = async (args) => {
        if (args[0] === "wallet" && args[1] === "status") return { stdout: "not json" };
        return connectedRunner().runner(args);
    };
    await assert.rejects(readWalletSnapshot({ runner: malformed.runner, now: () => 0 }), /INVALID_OUTPUT/);

    const failure = createRunner({ "wallet status": { status: "CONNECTED" } });
    failure.runner = async (args) => {
        if (args[0] === "wallet" && args[1] === "status") return { stdout: JSON.stringify({ success: false }) };
        return connectedRunner().runner(args);
    };
    await assert.rejects(readWalletSnapshot({ runner: failure.runner, now: () => 0 }), /BAW_COMMAND_FAILED/);
});

test("unavailable CLI maps to BAW_UNAVAILABLE and the snapshot is not returned", async () => {
    const runner = async () => {
        throw Object.assign(new Error("spawn baw ENOENT"), { code: "ENOENT" });
    };
    await assert.rejects(readWalletSnapshot({ runner, now: () => 0 }), /BAW_UNAVAILABLE/);
});

test("parseAddresses rejects malformed addresses", () => {
    const parsed = parseAddresses(ADDRESSES);
    assert.equal(parsed.length, 2);
    assert.equal(parseAddresses({ addresses: [] }).length, 0);
    assert.throws(() => parseAddresses({
        addresses: [...ADDRESSES.addresses, { binanceChainId: "56", chainName: "BSC", address: "not an address" }],
    }), /INVALID_OUTPUT/);
    assert.throws(() => parseAddresses({}), /INVALID_OUTPUT/);
    assert.throws(() => parseAddresses([]), /INVALID_OUTPUT/);
});

test("parseBalances keeps decimal strings and rejects non-numeric values", () => {
    const parsed = parseBalances(BALANCES);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parseBalances([]), []);
    assert.throws(() => parseBalances({ balances: [] }), /INVALID_OUTPUT/);
    assert.throws(() => parseBalances([
        ...BALANCES,
        { symbol: "BAD", address: "0xabc0000000000000000000000000000000000123", binanceChainId: "56", balance: "NaN", price: "1", value: "1" },
    ]), /INVALID_OUTPUT/);
    assert.throws(() => parseBalances("no"), /INVALID_OUTPUT/);
});

test("parseChains requires name, simpleName, and binanceChainId", () => {
    const parsed = parseChains(CHAINS);
    assert.equal(parsed.length, 2);
    assert.throws(() => parseChains([{ binanceChainId: "56", name: "BNB Smart Chain", simpleName: "" }]), /INVALID_OUTPUT/);
    assert.throws(() => parseChains(null), /INVALID_OUTPUT/);
});

test("parseWalletStatus accepts only documented states", () => {
    assert.equal(parseWalletStatus({ status: "CONNECTED" }), "CONNECTED");
    assert.equal(parseWalletStatus({ status: "UNCONNECTED" }), "UNCONNECTED");
    assert.equal(parseWalletStatus({ status: "CREATING" }), "CREATING");
    assert.throws(() => parseWalletStatus({ status: "SOMETHING_ELSE" }), /INVALID_OUTPUT/);
    assert.throws(() => parseWalletStatus({}), /INVALID_OUTPUT/);
});

test("parseSettings returns only the whitelisted subset and rejects malformed records", () => {
    const parsed = parseSettings(SETTINGS);
    assert.deepEqual(Object.keys(parsed).sort(), [
        "abnormalTxnHandling", "dailyLimit", "predictionEnabled", "quotaLeft",
        "quotaUsed", "sessionExpireTime", "tradeAllTokens",
    ]);
    assert.equal(parsed.sessionExpireTime, SETTINGS.sessionExpireTime);
    assert.equal("devMode" in parsed, false);
    assert.throws(() => parseSettings({ ...SETTINGS, dailyLimit: "not-a-number" }), /INVALID_OUTPUT/);
    assert.throws(() => parseSettings({ ...SETTINGS, tradeAllTokens: "false" }), /INVALID_OUTPUT/);
    assert.throws(() => parseSettings({ ...SETTINGS, abnormalTxnHandling: "AUTO_REJECT" }), /INVALID_OUTPUT/);
});

test("createBawRunner rejects non-positive timeouts and uses BAW_BIN override", () => {
    assert.throws(() => createBawRunner({}, 0), /timeoutMs/);
    assert.throws(() => createBawRunner({}, -5), /timeoutMs/);
    const runner = createBawRunner({ BAW_BIN: "/usr/local/bin/baw" });
    assert.equal(typeof runner, "function");
});

test("createBawRunner executes the offline CLI stub and blocks every non-allowlisted command", async (t) => {
    const marker = join(tmpdir(), `wolv-baw-calls-${process.pid}-${Date.now()}`);
    const responses = {
        status: jsonPayload({ status: "CONNECTED" }),
        chains: jsonPayload(CHAINS),
        address: jsonPayload(ADDRESSES),
        balance: jsonPayload(BALANCES),
        settings: jsonPayload(SETTINGS),
    };
    const { binary } = await createStubBinary(t, `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(marker)}, args.join(" ") + "\\n");
const responses = ${JSON.stringify(responses)};
process.stdout.write(responses[args[1]]);
`);
    t.after(() => rm(marker, { force: true }));

    const runner = createBawRunner({ BAW_BIN: binary }, 2_000);
    const snapshot = await readWalletSnapshot({ runner, now: () => 1_000 });
    assert.equal(snapshot.connected, true);
    assert.equal(snapshot.addresses.length, 2);
    assert.equal(snapshot.balances.length, 2);
    assert.deepEqual(
        (await readFile(marker, "utf8")).trim().split("\n"),
        ["wallet status --json", "wallet chains --json", "wallet address --json", "wallet balance --json", "wallet settings --json"],
    );

    await assert.rejects(
        runner(["wallet", "send", "--recipient", "0x0000000000000000000000000000000000000000", "--json"]),
        /BAW_COMMAND_NOT_ALLOWED/,
    );
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 5);
});

test("createBawRunner times out an offline CLI stub", async (t) => {
    const { binary } = await createStubBinary(t, "setInterval(() => {}, 1_000);\n");
    const runner = createBawRunner({ BAW_BIN: binary }, 50);
    await assert.rejects(runner(["wallet", "status", "--json"]), /BAW_TIMEOUT/);
});

test("createBawRunner allows only parameterized validated market-order quote arguments", async (t) => {
    const marker = join(tmpdir(), `wolv-baw-quote-calls-${process.pid}-${Date.now()}`);
    const quoteOutput = JSON.stringify({
        success: true,
        data: {
            fromCoinSymbol: "USDT",
            fromCoinAmount: "10",
            toCoinSymbol: "AAPLon",
            toCoinAmount: "0.1",
            slippage: 0.01,
        },
    });
    const { binary } = await createStubBinary(t, `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(marker)}, args.join(" ") + "\\n");
process.stdout.write(${JSON.stringify(quoteOutput)});
`);
    t.after(() => rm(marker, { force: true }));

    const runner = createBawRunner({ BAW_BIN: binary }, 2_000);
    const args = buildBawMarketQuoteArgs({
        direction: "BUY",
        tokenAddress: "0x0000000000000000000000000000000000000123",
        amount: "10",
        chainId: "56",
        slippagePercent: "1",
    });
    const result = await runner(args);
    assert.match(result.stdout, /"fromCoinAmount":"10"/);
    assert.equal(
        (await readFile(marker, "utf8")).trim(),
        "market-order quote --fromTokenQty 10 --fromToken 0x55d398326f99059fF775485246999027B3197955 --toToken 0x0000000000000000000000000000000000000123 --binanceChainId 56 --slippage 1 --json",
    );

    await assert.rejects(
        runner(["market-order", "swap", "--fromTokenQty", "10", "--fromToken", "0x55d398326f99059fF775485246999027B3197955", "--toToken", "0x0000000000000000000000000000000000000123", "--binanceChainId", "56", "--json"]),
        /BAW_COMMAND_NOT_ALLOWED/,
    );
    await assert.rejects(
        runner([...args.slice(0, -1), "--mev", "false", "--json"]),
        /BAW_COMMAND_NOT_ALLOWED/,
    );
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
});

test("market-order swap and status commands accept only the documented exact argument shapes", () => {
    const token = "0x0000000000000000000000000000000000000123";
    const swap = buildBawMarketSwapArgs({
        direction: "BUY",
        tokenAddress: token,
        amount: "5",
        chainId: "56",
        slippagePercent: "0.5",
    });
    assert.equal(parseBawMarketSwapArgs(swap).direction, "BUY");
    assert.deepEqual(swap, [
        "market-order", "swap",
        "--fromTokenQty", "5",
        "--fromToken", "0x55d398326f99059fF775485246999027B3197955",
        "--toToken", token,
        "--binanceChainId", "56",
        "--slippage", "0.5",
        "--mev", "true",
        "--gasLevel", "MEDIUM",
        "--json",
    ]);
    assert.equal(parseBawMarketSwapArgs([...swap.slice(0, -5), "--mev", "false", "--gasLevel", "MEDIUM", "--json"]), null);
    for (const invalid of [
        { direction: "BUY", tokenAddress: token, amount: "1e2", chainId: "56", slippagePercent: "0.5" },
        { direction: "SELL", tokenAddress: token, amount: "1", chainId: "97", slippagePercent: "0.5" },
        { direction: "SELL", tokenAddress: token, amount: "1", chainId: "56", slippagePercent: "auto" },
    ]) {
        assert.throws(() => buildBawMarketSwapArgs(invalid), /BAW_COMMAND_NOT_ALLOWED/);
    }

    const listArgs = buildBawMarketOrderListArgs("1234567890");
    assert.deepEqual(listArgs, ["market-order", "list", "--orderId", "1234567890", "--json"]);
    assert.equal(parseBawMarketOrderListArgs(listArgs), "1234567890");
    assert.equal(parseBawMarketOrderListArgs(["market-order", "list", "--status", "PENDING", "--json"]), null);
    assert.throws(() => buildBawMarketOrderListArgs("123 --json"), /BAW_COMMAND_NOT_ALLOWED/);

    const historyArgs = buildBawMarketOrderReconciliationArgs({
        fromToken: "0x55d398326f99059fF775485246999027B3197955",
        toToken: token,
        startTime: 1_800_000_000_000,
        endTime: 1_800_000_000_100,
    });
    assert.equal(historyArgs[1], "list");
    assert.equal(historyArgs.at(-1), "--json");
    assert.throws(() => buildBawMarketOrderReconciliationArgs({
        fromToken: token,
        toToken: token,
        startTime: 2,
        endTime: 1,
    }), /BAW_COMMAND_NOT_ALLOWED/);
});

test("market-order submission and order-list responses parse only documented fields", () => {
    assert.equal(parseBawMarketOrderSubmitOutput('{"success":true,"data":{"orderId":"1234567890"}}'), "1234567890");
    for (const malformed of [
        '{"success":true,"data":{"orderId":"123","extra":"unexpected"}}',
        '{"success":true,"data":{"orderId":123}}',
        '{"success":false,"data":{"orderId":"123"}}',
    ]) assert.throws(() => parseBawMarketOrderSubmitOutput(malformed), /INVALID_OUTPUT/);

    const order = {
        orderType: "market",
        orderId: "1234567890",
        chain: "56",
        fromToken: "0x55d398326f99059fF775485246999027B3197955",
        fromTokenName: "USDT",
        fromTokenQty: "10",
        toToken: "0x0000000000000000000000000000000000000123",
        toTokenName: "AAPLon",
        toTokenActualQty: "0.1",
        status: "FINISHED",
        slippage: "0.5000",
        txHash: `0x${"a".repeat(64)}`,
        bookTime: "2026-04-01T23:50:10+08:00",
        updatedTime: "2026-04-01T23:50:12+08:00",
        refund: [{ tokenAddress: "0x55d398326f99059fF775485246999027B3197955", amount: "0.01", symbol: "USDT" }],
    };
    const result = parseBawMarketOrderListOutput(JSON.stringify({
        success: true,
        data: { total: 1, page: 1, pageSize: 20, list: [order] },
    }), {
        orderId: order.orderId,
        fromToken: order.fromToken,
        toToken: order.toToken,
        amount: "10",
    });

    assert.equal(result.status, "FINISHED");
    assert.equal(result.toTokenActualQty, "0.1");
    assert.equal(result.refund[0].symbol, "USDT");
    assert.throws(() => parseBawMarketOrderListOutput(
        JSON.stringify({ success: true, data: { list: [{ ...order, status: "CANCELLED" }] } }),
        { orderId: order.orderId, fromToken: order.fromToken, toToken: order.toToken, amount: "10" },
    ), /INVALID_OUTPUT/);
    const history = parseBawMarketOrderHistoryOutput(JSON.stringify({
        success: true,
        data: { total: 1, page: 1, pageSize: 20, list: [order] },
    }));
    assert.equal(history[0].orderId, order.orderId);
    assert.throws(() => parseBawMarketOrderHistoryOutput(JSON.stringify({
        success: true,
        data: { list: [{ ...order, status: "UNKNOWN" }] },
    })), /INVALID_OUTPUT/);
});

test("secure execFile runner invokes only the canonical mocked swap and order-status commands", async (t) => {
    const marker = join(tmpdir(), `wolv-baw-execution-calls-${process.pid}-${Date.now()}`);
    const responses = {
        swap: '{"success":true,"data":{"orderId":"1234567890"}}',
        list: '{"success":true,"data":{"total":0,"page":1,"pageSize":20,"list":[]}}',
    };
    const { binary } = await createStubBinary(t, `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(marker)}, args.join(" ") + "\\n");
process.stdout.write(${JSON.stringify(responses)}[args[1]]);
`);
    t.after(() => rm(marker, { force: true }));
    const runner = createBawRunner({ BAW_BIN: binary }, 2_000);
    const swap = buildBawMarketSwapArgs({
        direction: "SELL",
        tokenAddress: "0x0000000000000000000000000000000000000123",
        amount: "0.1",
        chainId: "56",
        slippagePercent: "1",
    });
    const submitted = await runner(swap);
    assert.equal(parseBawMarketOrderSubmitOutput(submitted.stdout), "1234567890");
    const list = buildBawMarketOrderListArgs("1234567890");
    await runner(list);
    assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
        "market-order swap --fromTokenQty 0.1 --fromToken 0x0000000000000000000000000000000000000123 --toToken 0x55d398326f99059fF775485246999027B3197955 --binanceChainId 56 --slippage 1 --mev true --gasLevel MEDIUM --json",
        "market-order list --orderId 1234567890 --json",
    ]);

    await assert.rejects(
        runner(["market-order", "swap", "--fromTokenQty", "10", "--fromToken", "0x55d398326f99059fF775485246999027B3197955", "--toToken", "0x0000000000000000000000000000000000000123", "--binanceChainId", "56", "--slippage", "auto", "--mev", "false", "--gasLevel", "HIGH", "--json"]),
        /BAW_COMMAND_NOT_ALLOWED/,
    );
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 2);
});
