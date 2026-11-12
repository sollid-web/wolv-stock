import test from "node:test";
import assert from "node:assert/strict";
import { createBscRpcClient } from "../services/autonomy/bsc-rpc.ts";

const wallet = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const txHash = "0x" + "a".repeat(64);

function rpcFetch(handler) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    calls.push(request);
    const result = await handler(request.method, request.params);
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: request.id, result,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("BSC client verifies chain and returns exact gas and native balances", async () => {
  const fake = rpcFetch((method) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_gasPrice") return "0x3b9aca00";
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    throw new Error("unexpected method " + method);
  });
  const client = createBscRpcClient({ rpcUrl: "https://rpc.example", fetchImpl: fake.fetchImpl });
  assert.deepEqual(await client.getGasPrice().then((x) => x.wei), "1000000000");
  assert.equal(await client.getNativeBalance(wallet), "1000000000000000000");
  assert.equal(fake.calls.filter((x) => x.method === "eth_chainId").length, 2);
});

test("BSC client rejects a wrong chain before reading account data", async () => {
  const fake = rpcFetch((method) => method === "eth_chainId" ? "0x1" : "0x1");
  const client = createBscRpcClient({ rpcUrl: "https://rpc.example", fetchImpl: fake.fetchImpl });
  await assert.rejects(client.getNativeBalance(wallet), /not BNB Smart Chain/);
  assert.deepEqual(fake.calls.map((x) => x.method), ["eth_chainId"]);
});

test("BSC client simulates exact unsigned transaction without sending it", async () => {
  const fake = rpcFetch((method) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_call") return "0x";
    if (method === "eth_estimateGas") return "0x5208";
    throw new Error("unexpected method " + method);
  });
  const client = createBscRpcClient({ rpcUrl: "https://rpc.example", fetchImpl: fake.fetchImpl });
  const result = await client.simulateTransaction({
    from: wallet, to: token, data: "0x12345678", value: "0", gasPrice: "1000000000",
  });
  assert.equal(result.success, true);
  assert.equal(result.gasEstimate, "21000");
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fake.calls.some((x) => x.method === "eth_sendRawTransaction"), false);
  assert.equal(fake.calls.filter((x) => x.method === "eth_call").length, 1);
});

test("BSC client reads ERC-20 balance at a requested block", async () => {
  const balance = BigInt(123456).toString(16).padStart(64, "0");
  const fake = rpcFetch((method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_call") {
      assert.equal(params[0].to, token);
      assert.equal(params[0].data, "0x70a08231" + wallet.slice(2).padStart(64, "0"));
      assert.equal(params[1], "0x100");
      return "0x" + balance;
    }
    throw new Error("unexpected method " + method);
  });
  const client = createBscRpcClient({ rpcUrl: "https://rpc.example", fetchImpl: fake.fetchImpl });
  assert.equal(await client.getTokenBalance(token, wallet, "0x100"), "123456");
});

test("BSC client validates mined receipt and distinguishes failed transactions", async () => {
  const fake = rpcFetch((method) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_getTransactionReceipt") return {
      transactionHash: txHash, status: "0x0", blockNumber: "0x100",
      gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", logs: [],
    };
    throw new Error("unexpected method " + method);
  });
  const client = createBscRpcClient({ rpcUrl: "https://rpc.example", fetchImpl: fake.fetchImpl });
  const receipt = await client.getReceipt(txHash);
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.blockNumber, "256");
  assert.equal(receipt.gasUsed, "21000");
});

test("BSC client rejects insecure remote RPC URLs and malformed receipts", async () => {
  const insecure = createBscRpcClient({ rpcUrl: "http://rpc.example", fetchImpl: async () => {
    throw new Error("must not call network");
  } });
  await assert.rejects(insecure.assertBsc(), /must use HTTPS/);
  const malformed = rpcFetch((method) => method === "eth_chainId" ? "0x38" : ({
    transactionHash: txHash, status: "0x2", blockNumber: "0x100",
    gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00",
  }));
  const client = createBscRpcClient({ rpcUrl: "https://rpc.example", fetchImpl: malformed.fetchImpl });
  await assert.rejects(client.getReceipt(txHash), /unknown status/);
});


test("BSC client binds transaction sender, target and chain and reads head block", async () => {
  const fake = rpcFetch((method) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_getTransactionByHash") return {
      hash: txHash, from: wallet, to: token, chainId: "0x38",
    };
    if (method === "eth_blockNumber") return "0x1234";
    throw new Error("unexpected method " + method);
  });
  const client = createBscRpcClient({ rpcUrl: "https://rpc.example", fetchImpl: fake.fetchImpl });
  assert.deepEqual(await client.getTransaction(txHash), {
    hash: txHash, from: wallet, to: token, chainId: "56",
  });
  assert.equal(await client.getBlockNumber(), "4660");
});

test("BSC receipt rejects missing or malformed transfer-log evidence", async () => {
  const fake = rpcFetch((method) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_getTransactionReceipt") return {
      transactionHash: txHash, status: "0x1", blockNumber: "0x100",
      gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00",
      logs: [{ address: token, topics: ["0x1234"], data: "0x01" }],
    };
    throw new Error("unexpected method " + method);
  });
  const client = createBscRpcClient({ rpcUrl: "https://rpc.example", fetchImpl: fake.fetchImpl });
  await assert.rejects(client.getReceipt(txHash), /malformed log fields/);
});
