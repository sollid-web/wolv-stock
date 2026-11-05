import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { bsc, bscTestnet } from "viem/chains";
import {
  getBscChain,
  getBscRpcUrl,
  getConfiguredBscChain,
  getWalletConnectChainId,
  isBscNetworkAllowedOnPath,
  isSupportedBscChainId,
} from "../lib/bscChain.ts";
import { getAgentPublicClient } from "../lib/kernelClient.ts";

const envKeys = [
  "NEXT_PUBLIC_BSC_CHAIN_ID",
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

test("uses the mainnet configuration by default and rejects malformed chain IDs", () => {
  delete process.env.NEXT_PUBLIC_BSC_CHAIN_ID;
  assert.equal(getConfiguredBscChain(), bsc);

  process.env.NEXT_PUBLIC_BSC_CHAIN_ID = "56,97";
  assert.throws(() => getConfiguredBscChain(), /must be 56 .* or 97/);
});
