import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  createAgentPublicClient,
  createAgentSessionSigner,
  calculateDynamicQuote,
  encodeAgentBuyCall,
  getAgentSmartAccountConfig,
  runAgentExecutionWithTelemetry,
} from "../lib/smartAccount.ts";
import { decodeFunctionData, parseEther } from "viem";

const publicEnvKeys = [
  "NEXT_PUBLIC_CHAIN_ID",
  "NEXT_PUBLIC_BSC_RPC_URL",
  "NEXT_PUBLIC_BSC_TESTNET_RPC_URL",
  "NEXT_PUBLIC_BSC_BUNDLER_RPC_URL",
  "NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL",
  "NEXT_PUBLIC_ROUTER_ADDRESS",
  "NEXT_PUBLIC_POLICY_HOOK_ADDRESS",
  "NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS",
];
const previousEnv = new Map(
  publicEnvKeys.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("builds a BSC testnet config and public client from validated env", () => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "97";
  process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL =
    "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
  process.env.NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL =
    "https://bundler.example.test/rpc";
  process.env.NEXT_PUBLIC_ROUTER_ADDRESS =
    "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3";
  process.env.NEXT_PUBLIC_POLICY_HOOK_ADDRESS =
    "0x0000000000000000000000000000000000000123";
  process.env.NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS =
    "0x0000000000000000000000000000000000000456";

  const config = getAgentSmartAccountConfig();
  const client = createAgentPublicClient();

  assert.equal(config.chain.id, 97);
  assert.equal(config.routerAddress, "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3");
  assert.equal(config.bundlerRpcUrl, "https://bundler.example.test/rpc");
  assert.equal(config.targetTokenAddress, "0x0000000000000000000000000000000000000456");
  assert.equal(client.chain.id, 97);
});

test("rejects an unsupported chain ID", () => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "1";
  assert.throws(
    () => getAgentSmartAccountConfig(),
    /NEXT_PUBLIC_CHAIN_ID must be 56 \(BSC\) or 97 \(BSC testnet\)/,
  );
});

test("rejects missing deployed hook configuration", () => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "97";
  process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL =
    "https://bundler.example.test/rpc";
  process.env.NEXT_PUBLIC_ROUTER_ADDRESS =
    "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3";
  delete process.env.NEXT_PUBLIC_POLICY_HOOK_ADDRESS;
  process.env.NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS =
    "0x0000000000000000000000000000000000000456";

  assert.throws(
    () => getAgentSmartAccountConfig(),
    /NEXT_PUBLIC_POLICY_HOOK_ADDRESS must be a valid EVM address/,
  );
});

test("rejects bundler URLs containing embedded credentials", () => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "97";
  process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL =
    "https://user:secret@bundler.example.test/rpc";
  process.env.NEXT_PUBLIC_ROUTER_ADDRESS =
    "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3";
  process.env.NEXT_PUBLIC_POLICY_HOOK_ADDRESS =
    "0x0000000000000000000000000000000000000123";
  process.env.NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS =
    "0x0000000000000000000000000000000000000456";

  assert.throws(
    () => getAgentSmartAccountConfig(),
    /must be a public HTTP\(S\) URL without credentials/,
  );
});

test("encodes only a one-hop WBNB-to-target-token buy for the smart account", () => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "97";
  process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL =
    "https://bundler.example.test/rpc";
  process.env.NEXT_PUBLIC_ROUTER_ADDRESS =
    "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3";
  process.env.NEXT_PUBLIC_POLICY_HOOK_ADDRESS =
    "0x0000000000000000000000000000000000000123";
  process.env.NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS =
    "0x0000000000000000000000000000000000000456";
  const config = getAgentSmartAccountConfig();

  const call = encodeAgentBuyCall(
    {
      accountAddress: "0x0000000000000000000000000000000000000789",
      amountBnb: parseEther("0.001"),
    },
    100n,
    config,
  );
  const decoded = decodeFunctionData({
    abi: [{
      type: "function",
      name: "swapExactETHForTokens",
      stateMutability: "payable",
      inputs: [
        { name: "amountOutMin", type: "uint256" },
        { name: "path", type: "address[]" },
        { name: "to", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
      outputs: [{ name: "amounts", type: "uint256[]" }],
    }],
    data: call.data,
  });

  assert.equal(call.to, config.routerAddress);
  assert.equal(call.value, parseEther("0.001"));
  assert.equal(decoded.functionName, "swapExactETHForTokens");
  assert.deepEqual(decoded.args[1], [
    config.wrappedNativeAddress,
    config.targetTokenAddress,
  ]);
  assert.equal(decoded.args[2], "0x0000000000000000000000000000000000000789");
  assert.equal(decoded.args[0], 100n);
});

test("generates distinct ephemeral session signers", () => {
  const firstSigner = createAgentSessionSigner();
  const secondSigner = createAgentSessionSigner();

  assert.match(firstSigner.address, /^0x[0-9a-fA-F]{40}$/);
  assert.match(secondSigner.address, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(firstSigner.address, secondSigner.address);
});

test("rejects trade calls outside the on-chain cap or without minimum output", () => {
  process.env.NEXT_PUBLIC_CHAIN_ID = "97";
  process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL =
    "https://bundler.example.test/rpc";
  process.env.NEXT_PUBLIC_ROUTER_ADDRESS =
    "0x9Ac64Cc6e4415144C455BD8E4837Fea55603e5c3";
  process.env.NEXT_PUBLIC_POLICY_HOOK_ADDRESS =
    "0x0000000000000000000000000000000000000123";
  process.env.NEXT_PUBLIC_AGENT_TARGET_TOKEN_ADDRESS =
    "0x0000000000000000000000000000000000000456";
  const config = getAgentSmartAccountConfig();
  const accountAddress = "0x0000000000000000000000000000000000000789";

  assert.throws(
    () => encodeAgentBuyCall(
      { accountAddress, amountBnb: parseEther("0.500001") },
      1n,
      config,
    ),
    /at most 0.5 BNB/,
  );
  assert.throws(
    () => encodeAgentBuyCall(
      { accountAddress, amountBnb: 1n },
      0n,
      config,
    ),
    /amountOutMin must be greater than zero/,
  );
});

test("calculates a reserve-based quote and applies configured slippage", () => {
  const amountIn = parseEther("0.001");
  const reserves = {
    reserveIn: parseEther("1000"),
    reserveOut: parseEther("1000000"),
  };
  const quote = calculateDynamicQuote(amountIn, reserves, 100, 300);
  const tighterQuote = calculateDynamicQuote(amountIn, reserves, 50, 300);

  assert.ok(quote.expectedAmountOut > quote.amountOutMin);
  assert.equal(quote.amountOutMin, quote.expectedAmountOut * 9900n / 10000n);
  assert.equal(
    tighterQuote.amountOutMin,
    tighterQuote.expectedAmountOut * 9950n / 10000n,
  );
  assert.ok(quote.priceImpactBps >= 30);
  assert.ok(quote.priceImpactBps < 300);
});

test("rejects empty pools, excessive price impact, and invalid slippage", () => {
  assert.throws(
    () => calculateDynamicQuote(1n, { reserveIn: 0n, reserveOut: 1n }),
    /reserves must both be greater than zero/,
  );
  assert.throws(
    () => calculateDynamicQuote(
      parseEther("100"),
      { reserveIn: parseEther("1000"), reserveOut: parseEther("1000000") },
      100,
      300,
    ),
    /Price impact .* exceeds maximum 300 bps/,
  );
  assert.throws(
    () => calculateDynamicQuote(
      1n,
      { reserveIn: parseEther("1000"), reserveOut: parseEther("1000000") },
      501,
      300,
    ),
    /slippageBps must be an integer between 1 and 500/,
  );
});

test("records structured submitted and successful UserOperation telemetry", async () => {
  const records = [];
  const hash = `0x${"a".repeat(64)}`;
  const transactionHash = `0x${"b".repeat(64)}`;
  await runAgentExecutionWithTelemetry(
    {
      account: "0x0000000000000000000000000000000000000789",
      targetToken: "0x0000000000000000000000000000000000000456",
      amountBnb: parseEther("0.001"),
    },
    async onSubmitted => {
      onSubmitted(hash, { priceImpactBps: 35, slippageBps: 100 });
      return {
        userOperationHash: hash,
        receipt: { success: true, receipt: { transactionHash } },
        quote: { priceImpactBps: 35, slippageBps: 100 },
      };
    },
    record => records.push(record),
  );

  assert.deepEqual(records.map(({ event }) => event), [
    "attempted",
    "submitted",
    "succeeded",
  ]);
  assert.equal(records[1].userOperationHash, hash);
  assert.equal(records[2].transactionHash, transactionHash);
  assert.equal(records[2].priceImpactBps, 35);
});

test("records failed UserOperation telemetry with a stable rejection reason", async () => {
  const records = [];
  const hash = `0x${"c".repeat(64)}`;

  await assert.rejects(
    runAgentExecutionWithTelemetry(
      {
        account: "0x0000000000000000000000000000000000000789",
        targetToken: "0x0000000000000000000000000000000000000456",
        amountBnb: parseEther("0.001"),
      },
      async onSubmitted => {
        onSubmitted(hash, { priceImpactBps: 310, slippageBps: 100 });
        return {
          userOperationHash: hash,
          receipt: {
            success: false,
            reason: "UserOperation execution reverted",
            receipt: { transactionHash: `0x${"d".repeat(64)}` },
          },
        };
      },
      record => records.push(record),
    ),
    /UserOperation execution reverted/,
  );

  assert.deepEqual(records.map(({ event }) => event), [
    "attempted",
    "submitted",
    "rejected",
  ]);
  assert.equal(records[2].reasonCode, "USER_OPERATION_REVERTED");
  assert.equal(records[2].userOperationHash, hash);
});
