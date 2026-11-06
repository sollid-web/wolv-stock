import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createPublicClient, custom } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import {
  getBscChain,
  getBscRpcUrl,
  getConfiguredBscChain,
  getWalletConnectChainId,
  isBscNetworkAllowedOnPath,
  isSupportedBscChainId,
} from "../lib/bscChain.ts";
import {
  estimateKernelUserOperationFees,
  getAgentPublicClient,
} from "../lib/kernelClient.ts";

const envKeys = [
  "NEXT_PUBLIC_BSC_CHAIN_ID",
  "NEXT_PUBLIC_CHAIN_ID",
  "NEXT_PUBLIC_BSC_RPC_URL",
  "NEXT_PUBLIC_BSC_TESTNET_RPC_URL",
];
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("maps BSC mainnet and testnet IDs to their respective chains", () => {
  assert.equal(getBscChain(56), bsc);
  assert.equal(getBscChain(97), bscTestnet);
  assert.equal(isSupportedBscChainId(56), true);
  assert.equal(isSupportedBscChainId(97), true);
  assert.equal(isSupportedBscChainId(1), false);
  assert.throws(() => getBscChain(1), /must be 56 .* or 97/);
});

test("allows testnet only on /agent and keeps trade and wallet routes mainnet-only", () => {
  process.env.NEXT_PUBLIC_BSC_CHAIN_ID = "97";

  assert.equal(isBscNetworkAllowedOnPath("/agent", 97), true);
  assert.equal(isBscNetworkAllowedOnPath("/trade", 97), false);
  assert.equal(isBscNetworkAllowedOnPath("/wallet", 97), false);
  assert.equal(isBscNetworkAllowedOnPath("/agent/settings", 97), false);
  assert.equal(isBscNetworkAllowedOnPath("/agent/", 97), true);
  assert.equal(isBscNetworkAllowedOnPath("/agent", 56), true);
  assert.equal(getWalletConnectChainId("/agent"), 97);
  assert.equal(getWalletConnectChainId("/agent/"), 97);
  assert.equal(getWalletConnectChainId("/trade"), 56);
});

test("uses the configured testnet for policy clients and its own public RPC", () => {
  process.env.NEXT_PUBLIC_BSC_CHAIN_ID = "97";
  process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL = "https://testnet-rpc.example";

  assert.equal(getConfiguredBscChain(), bscTestnet);
  assert.equal(getAgentPublicClient().chain.id, 97);
  assert.equal(getBscRpcUrl(97), "https://testnet-rpc.example/");
});

test("estimates Kernel UserOperation fees from the BSC public RPC", async () => {
  const methods = [];
  const publicClient = createPublicClient({
    chain: bscTestnet,
    transport: custom({
      request: async ({ method }) => {
        methods.push(method);
        if (method === "eth_getBlockByNumber") {
          return {
            number: "0x1",
            hash: `0x${"1".repeat(64)}`,
            parentHash: `0x${"2".repeat(64)}`,
            nonce: "0x0000000000000000",
            sha3Uncles: `0x${"3".repeat(64)}`,
            logsBloom: `0x${"0".repeat(512)}`,
            transactionsRoot: `0x${"4".repeat(64)}`,
            stateRoot: `0x${"5".repeat(64)}`,
            receiptsRoot: `0x${"6".repeat(64)}`,
            miner: `0x${"0".repeat(40)}`,
            difficulty: "0x0",
            totalDifficulty: "0x0",
            extraData: "0x",
            size: "0x1",
            gasLimit: "0x1c9c380",
            gasUsed: "0x5208",
            timestamp: "0x1",
            transactions: [],
            uncles: [],
            mixHash: `0x${"7".repeat(64)}`,
            baseFeePerGas: "0x3b9aca00",
          };
        }
        if (method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    }),
  });

  const fees = await estimateKernelUserOperationFees(publicClient);

  assert.deepEqual(fees, {
    maxFeePerGas: 2_200_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  assert.deepEqual(methods, ["eth_getBlockByNumber", "eth_maxPriorityFeePerGas"]);
});

test("uses NEXT_PUBLIC_CHAIN_ID for the agent network when no BSC-specific override is set", () => {
  delete process.env.NEXT_PUBLIC_BSC_CHAIN_ID;
  process.env.NEXT_PUBLIC_CHAIN_ID = "97";

  assert.equal(getConfiguredBscChain(), bscTestnet);
  assert.equal(getAgentPublicClient().chain.id, 97);
  assert.equal(getWalletConnectChainId("/agent"), 97);
});

test("uses the mainnet configuration by default and rejects malformed chain IDs", () => {
  delete process.env.NEXT_PUBLIC_BSC_CHAIN_ID;
  delete process.env.NEXT_PUBLIC_CHAIN_ID;
  assert.equal(getConfiguredBscChain(), bsc);

  process.env.NEXT_PUBLIC_BSC_CHAIN_ID = "56,97";
  assert.throws(() => getConfiguredBscChain(), /must be 56 .* or 97/);
});
