import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createBawRunner,
    parseAddresses,
    parseBalances,
    parseChains,
    parseSettings,
    parseWalletStatus,
    readWalletSnapshot,
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
        { binanceChainId: "56", chainName: "BSC", address: "not an address" },
    ],
};

const BALANCES = [
    { symbol: "USDT", address: "0x55d398326f9eF775485cA35bE4551F3f38b12345", binanceChainId: "56", balance: "1000.50", price: "1.0", value: "1000.50" },
    { symbol: "GHOST", address: "0xabc0000000000000000000000000000000000123", binanceChainId: "56", balance: "0", price: "0", value: "0" },
    { symbol: "BAD", address: "0xabc0000000000000000000000000000000000123", binanceChainId: "56", balance: "NaN", price: "1", value: "1" },
];

const SETTINGS = {
    maxSigninDuration: "48h",
    inactiveSignoutDuration: "48h",
    dailyLimit: 50000,
    quotaUsed: 0,
    quotaLeft: 50000,
    abnormalTxnHandling: "AUTO_REJECT",
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

test("parseAddresses drops entries with malformed addresses", () => {
    const parsed = parseAddresses(ADDRESSES);
    assert.equal(parsed.length, 2);
    assert.equal(parseAddresses({ addresses: [] }).length, 0);
    assert.throws(() => parseAddresses({}), /INVALID_OUTPUT/);
    assert.throws(() => parseAddresses([]), /INVALID_OUTPUT/);
});

test("parseBalances keeps decimal strings and drops non-numeric values", () => {
    const parsed = parseBalances(BALANCES);
    assert.equal(parsed.length, 2);
    assert.throws(() => parseBalances("no"), /INVALID_OUTPUT/);
});

test("parseChains requires name, simpleName, and binanceChainId", () => {
    const parsed = parseChains(CHAINS);
    assert.equal(parsed.length, 2);
    assert.equal(parseChains([{ binanceChainId: "56", name: "BNB Smart Chain", simpleName: "" }]).length, 0);
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
        "abnormalTxnHandling", "dailyLimit", "devMode", "inactiveSignoutDuration",
        "maxSigninDuration", "predictionEnabled", "quotaLeft", "quotaUsed",
        "sessionExpireTime", "tradeAllTokens",
    ]);
    assert.deepEqual(parsed.devMode, { enabled: false, expiresAt: null, balanceExceeded: false });
    assert.equal(parseSettings({ ...SETTINGS, devMode: { enabled: false, expiresAt: 123, balanceExceeded: false } }).devMode.expiresAt, 123);
    assert.throws(() => parseSettings({ ...SETTINGS, devMode: { enabled: "yes", expiresAt: null, balanceExceeded: false } }), /INVALID_OUTPUT/);
    assert.throws(() => parseSettings({ ...SETTINGS, sessionExpireTime: "" }), /INVALID_OUTPUT/);
});

test("createBawRunner rejects non-positive timeouts and uses BAW_BIN override", () => {
    assert.throws(() => createBawRunner({}, 0), /timeoutMs/);
    assert.throws(() => createBawRunner({}, -5), /timeoutMs/);
    const runner = createBawRunner({ BAW_BIN: "/usr/local/bin/baw" });
    assert.equal(typeof runner, "function");
});
