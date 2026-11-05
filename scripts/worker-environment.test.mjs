import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkerEnvironmentAliases } from "../worker/workerEnvironment.ts";

test("maps worker-specific BSC testnet chain and RPC settings to smart-account config", () => {
  const env = {
    CHAIN_ID: "97",
    RPC_URL: "https://testnet-rpc.example",
  };

  applyWorkerEnvironmentAliases(env);

  assert.equal(env.NEXT_PUBLIC_CHAIN_ID, "97");
  assert.equal(env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL, "https://testnet-rpc.example");
});

test("uses BSC_CHAIN_ID when the worker-specific chain setting is absent", () => {
  const env = { NEXT_PUBLIC_BSC_CHAIN_ID: "97" };

  applyWorkerEnvironmentAliases(env);

  assert.equal(env.NEXT_PUBLIC_CHAIN_ID, "97");
});

test("does not override explicit agent chain or testnet RPC settings", () => {
  const env = {
    CHAIN_ID: "97",
    NEXT_PUBLIC_CHAIN_ID: "56",
    RPC_URL: "https://worker-rpc.example",
    NEXT_PUBLIC_BSC_TESTNET_RPC_URL: "https://configured-rpc.example",
  };

  applyWorkerEnvironmentAliases(env);

  assert.equal(env.NEXT_PUBLIC_CHAIN_ID, "56");
  assert.equal(env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL, "https://configured-rpc.example");
});
