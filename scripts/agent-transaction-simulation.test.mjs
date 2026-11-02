import assert from "node:assert/strict";
import test from "node:test";
import { encodeAgentBuyCall } from "../lib/smartAccount.ts";
import {
  handleAgentTransactionSimulationPost,
  simulateAgentTransaction,
} from "../services/agentTransactionSimulation.ts";
import { parseEther } from "viem";

const OWNER = "0x0000000000000000000000000000000000000789";
const ROUTER = "0x0000000000000000000000000000000000000123";
const TOKEN = "0x0000000000000000000000000000000000000456";
const WRAPPED = "0x0000000000000000000000000000000000000001";
const CONFIG = {
  chain: { id: 97 },
  rpcUrl: "https://rpc.example",
  bundlerRpcUrl: "https://bundler.example",
  routerAddress: ROUTER,
  policyHookAddress: "0x0000000000000000000000000000000000000321",
  targetTokenAddress: TOKEN,
  wrappedNativeAddress: WRAPPED,
};

function harness(overrides = {}) {
  const calls = [];
  const gasEstimates = [];
  const rpc = {
    getChainId: async () => 97,
    getBlockNumber: async () => 123n,
    getBalance: async () => parseEther("1"),
    getGasPrice: async () => 3n,
    estimateGas: async (transaction) => {
      gasEstimates.push(transaction);
      return 100_000n;
    },
    call: async (transaction) => {
      calls.push(transaction);
      return { data: "0x" };
    },
    ...overrides.rpc,
  };
  const dependencies = {
    getConfig: () => CONFIG,
    createPublicClient: () => ({}),
    createRpc: () => rpc,
    buildBuyCall: async (_client, request) => ({
      ...encodeAgentBuyCall(
        { accountAddress: request.accountAddress, amountBnb: request.amountBnb },
        1_000n,
        CONFIG,
      ),
      quote: {
        expectedAmountOut: 1_100n,
        amountOutMin: 1_000n,
        priceImpactBps: 40,
        slippageBps: request.slippageBps,
        poolAddress: "0x0000000000000000000000000000000000000999",
      },
    }),
    now: () => Date.now(),
    ...overrides.dependencies,
  };
  return { calls, gasEstimates, rpc, dependencies };
}

test("simulation validates a BSC testnet route, balance, gas, and performs only read calls", async () => {
  const { calls, gasEstimates, dependencies } = harness();
  const result = await simulateAgentTransaction(
    { amountBnb: "0.1", slippageBps: 100 },
    OWNER,
    dependencies,
  );

  assert.equal(result.status, "SIMULATION_PASSED");
  assert.equal(result.chainId, 97);
  assert.equal(result.blockNumber, "123");
  assert.equal(result.account, OWNER);
  assert.equal(result.router, ROUTER);
  assert.equal(result.targetToken, TOKEN);
  assert.equal(result.minimumAmountOut, "1000");
  assert.equal(result.estimatedNetworkFeeWei, "300000");
  assert.equal(result.execution.signingRequested, false);
  assert.equal(result.execution.transactionBroadcast, false);
  assert.equal(result.execution.executionEnabled, false);
  assert.equal(gasEstimates.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].account, OWNER);
});

test("simulation refuses an RPC chain mismatch before building a route", async () => {
  let built = false;
  const { dependencies } = harness({
    rpc: { getChainId: async () => 56 },
    dependencies: { buildBuyCall: async () => { built = true; throw new Error("unexpected"); } },
  });

  await assert.rejects(
    simulateAgentTransaction({ amountBnb: "0.1", slippageBps: 100 }, OWNER, dependencies),
    { code: "CHAIN_MISMATCH" },
  );
  assert.equal(built, false);
});

test("simulation does not report success when the EVM call fails", async () => {
  const { dependencies } = harness({
    rpc: { call: async () => { throw new Error("execution reverted"); } },
  });
  await assert.rejects(
    simulateAgentTransaction({ amountBnb: "0.1", slippageBps: 100 }, OWNER, dependencies),
    { code: "RPC_ERROR" },
  );
});

test("insufficient funds and invalid route never reach eth_call", async (t) => {
  await t.test("insufficient balance", async () => {
    const { calls, dependencies } = harness({
      rpc: { getBalance: async () => 1n },
    });
    await assert.rejects(
      simulateAgentTransaction({ amountBnb: "0.1", slippageBps: 100 }, OWNER, dependencies),
      { code: "BALANCE_INSUFFICIENT" },
    );
    assert.equal(calls.length, 0);
  });

  await t.test("wrong recipient", async () => {
    const { calls, dependencies } = harness({
      dependencies: {
        buildBuyCall: async () => ({
          ...encodeAgentBuyCall({ accountAddress: TOKEN, amountBnb: parseEther("0.1") }, 1_000n, CONFIG),
          quote: {
            expectedAmountOut: 1_100n,
            amountOutMin: 1_000n,
            priceImpactBps: 40,
            slippageBps: 100,
            poolAddress: "0x0000000000000000000000000000000000000999",
          },
        }),
      },
    });
    await assert.rejects(
      simulateAgentTransaction({ amountBnb: "0.1", slippageBps: 100 }, OWNER, dependencies),
      { code: "ROUTE_INVALID" },
    );
    assert.equal(calls.length, 0);
  });
});

test("simulation endpoint requires authorization and strict bounded inputs", async (t) => {
  const makeRequest = (body, headers = { "content-type": "application/json" }) =>
    new Request("https://wolv.test/api/agent/simulation", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  await t.test("unauthorized", async () => {
    let rpcCreated = false;
    const response = await handleAgentTransactionSimulationPost(
      makeRequest({ amountBnb: "0.1", slippageBps: 100 }),
      {
        authorize: async () => "unauthorized",
        createRpc: () => { rpcCreated = true; throw new Error("unexpected"); },
      },
    );
    assert.equal(response.status, 401);
    assert.equal(rpcCreated, false);
  });

  await t.test("extra fields", async () => {
    let rpcCreated = false;
    const response = await handleAgentTransactionSimulationPost(
      makeRequest({ amountBnb: "0.1", slippageBps: 100, recipient: TOKEN }),
      {
        authorize: async () => "authorized",
        getOwnerAddress: async () => OWNER,
        createRpc: () => { rpcCreated = true; throw new Error("unexpected"); },
      },
    );
    assert.equal(response.status, 422);
    assert.equal(rpcCreated, false);
  });
});
