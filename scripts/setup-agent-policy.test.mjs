import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPublicClient,
  custom,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiParameters,
  parseEther,
} from "viem";
import { bscTestnet } from "viem/chains";
import { configureAgentPolicy } from "../lib/setupAgentPolicy.ts";

const ACCOUNT = "0x0000000000000000000000000000000000000789";
const OWNER = "0x0000000000000000000000000000000000000111";
const HOOK = "0x0000000000000000000000000000000000000321";
const TOKEN = "0x0000000000000000000000000000000000000456";
const SIGNER = "0x0000000000000000000000000000000000000788";
const POLICY_STRATEGY = {
  strategyId: "aapl-entry",
  amountBnb: parseEther("0.1"),
  entryPriceMicros: 100_000_000n,
  slippageBps: 100,
  maxPriceImpactBps: 300,
};
const INSTALL_HASH = `0x${"a".repeat(64)}`;
const POLICY_USEROP_HASH = `0x${"c".repeat(64)}`;

const readAbi = [{
  type: "function",
  name: "isInitialized",
  stateMutability: "view",
  inputs: [{ name: "smartAccount", type: "address" }],
  outputs: [{ type: "bool" }],
}, {
  type: "function",
  name: "getTargetToken",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "address" }],
}, {
  type: "function",
  name: "getAccountPolicy",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [
    { type: "bool" },
    { type: "bytes32" },
    { type: "uint192" },
    { type: "uint64" },
    { type: "address" },
  ],
}];
const installAbi = [{
  type: "function",
  name: "installModule",
  inputs: [
    { name: "moduleType", type: "uint256" },
    { name: "module", type: "address" },
    { name: "initData", type: "bytes" },
  ],
  outputs: [],
}];
const policyAbi = [{
  type: "function",
  name: "setAccountPolicy",
  inputs: [
    { name: "smartAccount", type: "address" },
    { name: "intentSigner", type: "address" },
    { name: "policyHash", type: "bytes32" },
    { name: "maxTradeValue", type: "uint192" },
    { name: "expiresAt", type: "uint64" },
  ],
  outputs: [],
}];

function createHarness({ initiallyInstalled = false, installedTarget = TOKEN } = {}) {
  let initialized = initiallyInstalled;
  let policyState = [
    false,
    `0x${"0".repeat(64)}`,
    0n,
    0n,
    "0x0000000000000000000000000000000000000000",
  ];
  const calls = [];
  const waits = [];
  const transport = custom({
    request: async ({ method, params }) => {
      if (method === "eth_chainId") return "0x61";
      if (method !== "eth_call") throw new Error(`Unexpected RPC method: ${method}`);
      const call = params[0];
      const selector = call.data.slice(0, 10);
      if (selector === encodeFunctionData({
        abi: readAbi,
        functionName: "isInitialized",
        args: [ACCOUNT],
      }).slice(0, 10)) {
        return encodeAbiParameters([{ type: "bool" }], [initialized]);
      }
      if (selector === encodeFunctionData({
        abi: readAbi,
        functionName: "getTargetToken",
        args: [ACCOUNT],
      }).slice(0, 10)) {
        return encodeAbiParameters([{ type: "address" }], [installedTarget]);
      }
      if (selector === encodeFunctionData({
        abi: readAbi,
        functionName: "getAccountPolicy",
        args: [ACCOUNT],
      }).slice(0, 10)) {
        return encodeAbiParameters(
          [{ type: "bool" }, { type: "bytes32" }, { type: "uint192" }, { type: "uint64" }, { type: "address" }],
          policyState,
        );
      }
      throw new Error(`Unexpected read selector: ${selector}`);
    },
  });
  const publicClient = createPublicClient({ chain: bscTestnet, transport });
  const kernelClient = {
    account: { address: ACCOUNT },
    chain: bscTestnet,
    sendUserOperation: async ({ calls: userOpCalls }) => {
      calls.push(userOpCalls);
      const call = userOpCalls[0];
      if (call.to === ACCOUNT) {
        const decoded = decodeFunctionData({ abi: installAbi, data: call.data });
        assert.equal(decoded.functionName, "installModule");
        initialized = true;
        return INSTALL_HASH;
      }
      const configured = decodeFunctionData({ abi: policyAbi, data: call.data });
      policyState = [
        true,
        configured.args[2],
        configured.args[3],
        configured.args[4],
        configured.args[1],
      ];
      return POLICY_USEROP_HASH;
    },
    waitForUserOperationReceipt: async ({ hash }) => {
      waits.push(hash);
      return { success: true };
    },
  };
  return {
    calls,
    waits,
    publicClient,
    kernelClient,
  };
}

test("installs hook then signs policy in separate single-call owner UserOperations", async () => {
  const harness = createHarness();
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const result = await configureAgentPolicy({
    ownerKernelClient: harness.kernelClient,
    publicClient: harness.publicClient,
    validatorAddress: HOOK,
    ownerAddress: OWNER,
    ...POLICY_STRATEGY,
    targetToken: TOKEN,
    intentSigner: SIGNER,
    maxTradeValue: parseEther("0.5"),
    expiresAt,
  });

  assert.equal(result.account, ACCOUNT);
  assert.equal(result.installUserOperationHash, INSTALL_HASH);
  assert.equal(result.policyUserOperationHash, POLICY_USEROP_HASH);
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.calls.map((calls) => calls.length), [1, 1]);
  assert.deepEqual(harness.waits, [INSTALL_HASH, POLICY_USEROP_HASH]);

  const install = decodeFunctionData({
    abi: installAbi,
    data: harness.calls[0][0].data,
  });
  assert.equal(install.args[0], 4n);
  assert.equal(install.args[1], HOOK);
  assert.equal(install.args[2].slice(0, 4), "0x00");
  assert.equal(
    decodeAbiParameters(parseAbiParameters("address"), `0x${install.args[2].slice(4)}`)[0],
    TOKEN,
  );

  const configured = decodeFunctionData({
    abi: policyAbi,
    data: harness.calls[1][0].data,
  });
  assert.equal(harness.calls[1][0].to, HOOK);
  assert.deepEqual(configured.args, [
    ACCOUNT,
    SIGNER,
    result.policyHash,
    parseEther("0.5"),
    expiresAt,
  ]);
});

test("configures policy without reinstalling an already installed hook", async () => {
  const harness = createHarness({ initiallyInstalled: true });
  const result = await configureAgentPolicy({
    ownerKernelClient: harness.kernelClient,
    publicClient: harness.publicClient,
    validatorAddress: HOOK,
    targetToken: TOKEN,
    intentSigner: SIGNER,
    maxTradeValue: parseEther("0.25"),
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
  });
  assert.equal(result.installUserOperationHash, undefined);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.waits.length, 1);
});

test("fails before signing if the installed token or owner-operation receipt is invalid", async () => {
  const mismatched = createHarness({ initiallyInstalled: true, installedTarget: SIGNER });
  await assert.rejects(configureAgentPolicy({
    ownerKernelClient: mismatched.kernelClient,
    publicClient: mismatched.publicClient,
    validatorAddress: HOOK,
    targetToken: TOKEN,
    intentSigner: SIGNER,
    maxTradeValue: parseEther("0.25"),
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
  }), /does not match/);
  assert.equal(mismatched.calls.length, 0);

  const reverted = createHarness();
  reverted.kernelClient.waitForUserOperationReceipt = async () => ({ success: false });
  await assert.rejects(configureAgentPolicy({
    ownerKernelClient: reverted.kernelClient,
    publicClient: reverted.publicClient,
    validatorAddress: HOOK,
    targetToken: TOKEN,
    intentSigner: SIGNER,
    maxTradeValue: parseEther("0.25"),
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
  }), /Hook installation UserOperation reverted/);
  assert.equal(reverted.calls.length, 1);
});
