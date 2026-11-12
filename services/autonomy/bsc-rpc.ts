import { createHash } from "node:crypto";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^0x[a-fA-F0-9]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

type RpcFetch = typeof fetch;
type RpcResponse = { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };

function hexQuantity(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error("BSC RPC returned invalid " + field);
  }
  return value;
}
function normalizeAddress(value: string, field: string): string {
  if (!ADDRESS.test(value)) throw new Error("Invalid " + field + " address");
  return value.toLowerCase();
}
function quantity(value: string, field: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid " + field);
  return "0x" + BigInt(value).toString(16);
}

/**
 * Minimal BSC JSON-RPC client for independent preflight simulation and
 * read-only chain evidence. It never signs, broadcasts or sends transactions.
 */
export function createBscRpcClient(input: {
  rpcUrl?: string;
  fetchImpl?: RpcFetch;
  timeoutMs?: number;
  expectedChainId?: string;
}) {
  const rpcUrl = input.rpcUrl ?? process.env.WOLV_BSC_RPC_URL ?? "";
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 8_000;
  const expectedChainId = input.expectedChainId ?? "56";
  let requestId = 0;

  function configuredUrl(): string {
    if (!rpcUrl) throw new Error("WOLV_BSC_RPC_URL is not configured");
    let parsed: URL;
    try { parsed = new URL(rpcUrl); } catch { throw new Error("WOLV_BSC_RPC_URL is invalid"); }
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
      throw new Error("BSC RPC endpoint must use HTTPS outside localhost");
    }
    if (parsed.username || parsed.password) throw new Error("Do not embed RPC credentials in the URL");
    return parsed.toString();
  }

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const url = configuredUrl();
    const id = ++requestId;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("BSC RPC HTTP " + response.status);
      const body = await response.json() as RpcResponse;
      if (!body || body.jsonrpc !== "2.0" || body.id !== id) {
        throw new Error("BSC RPC response envelope does not match request");
      }
      if (body.error !== undefined && body.error !== null) {
        const message = typeof body.error === "object" && body.error !== null &&
          typeof (body.error as Record<string, unknown>).message === "string"
          ? (body.error as Record<string, string>).message : "provider error";
        throw new Error("BSC RPC " + method + " failed: " + message.slice(0, 240));
      }
      if (!("result" in body)) throw new Error("BSC RPC response is missing result");
      return body.result as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function assertBsc(): Promise<void> {
    const chainHex = hexQuantity(await rpc("eth_chainId", []), "chain ID");
    if (BigInt(chainHex).toString() !== expectedChainId || expectedChainId !== "56") {
      throw new Error("RPC endpoint is not BNB Smart Chain mainnet (chain 56)");
    }
  }

  async function getGasPrice(): Promise<{ wei: string; observedAt: string }> {
    await assertBsc();
    const value = hexQuantity(await rpc("eth_gasPrice", []), "gas price");
    if (BigInt(value) <= BigInt(0)) throw new Error("BSC RPC gas price must be positive");
    return { wei: BigInt(value).toString(), observedAt: new Date().toISOString() };
  }

  async function getNativeBalance(address: string): Promise<string> {
    await assertBsc();
    const account = normalizeAddress(address, "wallet");
    const value = hexQuantity(await rpc("eth_getBalance", [account, "latest"]), "native balance");
    return BigInt(value).toString();
  }

  async function getTokenBalance(tokenAddress: string, walletAddress: string, blockTag = "latest"): Promise<string> {
    await assertBsc();
    const token = normalizeAddress(tokenAddress, "token");
    const wallet = normalizeAddress(walletAddress, "wallet");
    if (blockTag !== "latest" && !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(blockTag)) {
      throw new Error("Invalid ERC-20 balance block tag");
    }
    const data = "0x70a08231" + wallet.slice(2).padStart(64, "0");
    const result = await rpc<unknown>("eth_call", [{ to: token, data }, blockTag]);
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
      throw new Error("BSC RPC returned malformed ERC-20 balanceOf data");
    }
    return BigInt(result).toString();
  }

  async function simulateTransaction(inputTx: {
    from: string; to: string; data: string; value: string; gasPrice?: string; gasLimit?: string;
  }): Promise<{ success: true; gasEstimate: string; chainId: string; simulatedAt: string; fingerprint: string }> {
    await assertBsc();
    const from = normalizeAddress(inputTx.from, "transaction sender");
    const to = normalizeAddress(inputTx.to, "transaction target");
    if (!HEX.test(inputTx.data) || inputTx.data === "0x") throw new Error("Transaction calldata is empty or malformed");
    const value = quantity(inputTx.value, "transaction value");
    const tx: Record<string, string> = { from, to, data: inputTx.data, value };
    if (inputTx.gasPrice !== undefined) tx.gasPrice = quantity(inputTx.gasPrice, "gas price");
    if (inputTx.gasLimit !== undefined) tx.gas = quantity(inputTx.gasLimit, "gas limit");
    // eth_call checks execution semantics without broadcasting; estimateGas
    // independently checks whether the node can estimate the exact payload.
    await rpc("eth_call", [tx, "pending"]);
    const estimate = hexQuantity(await rpc("eth_estimateGas", [tx, "pending"]), "gas estimate");
    if (BigInt(estimate) <= BigInt(0)) throw new Error("BSC RPC gas estimate must be positive");
    return {
      success: true,
      gasEstimate: BigInt(estimate).toString(),
      chainId: "56",
      simulatedAt: new Date().toISOString(),
      fingerprint: createHash("sha256").update(JSON.stringify(tx)).digest("hex"),
    };
  }

  async function getReceipt(transactionHash: string): Promise<{
    transactionHash: string; status: "SUCCESS" | "FAILED"; blockNumber: string;
    gasUsed: string; effectiveGasPrice: string;
    logs: Array<{ address: string; topics: string[]; data: string }>;
  } | null> {
    await assertBsc();
    if (!HASH.test(transactionHash)) throw new Error("Invalid transaction hash");
    const value = await rpc<unknown>("eth_getTransactionReceipt", [transactionHash]);
    if (value === null) return null;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("BSC RPC returned malformed transaction receipt");
    }
    const receipt = value as Record<string, unknown>;
    if (typeof receipt.transactionHash !== "string" || receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
      throw new Error("BSC RPC receipt hash does not match request");
    }
    const status = hexQuantity(receipt.status, "receipt status");
    if (status !== "0x1" && status !== "0x0") throw new Error("BSC RPC receipt has unknown status");
    const blockNumber = hexQuantity(receipt.blockNumber, "receipt block number");
    const gasUsed = hexQuantity(receipt.gasUsed, "receipt gas used");
    const effectiveGasPrice = hexQuantity(receipt.effectiveGasPrice, "receipt effective gas price");
    if (BigInt(blockNumber) <= BigInt(0) || BigInt(gasUsed) <= BigInt(0) || BigInt(effectiveGasPrice) <= BigInt(0)) {
      throw new Error("BSC RPC receipt is missing mined block or fee evidence");
    }
    return {
      transactionHash: transactionHash.toLowerCase(),
      status: status === "0x1" ? "SUCCESS" : "FAILED",
      blockNumber: BigInt(blockNumber).toString(),
      gasUsed: BigInt(gasUsed).toString(),
      effectiveGasPrice: BigInt(effectiveGasPrice).toString(),
    };
  }

  return {
    isConfigured: () => !!rpcUrl,
    assertBsc,
    getGasPrice,
    getNativeBalance,
    getTokenBalance,
    simulateTransaction,
    getReceipt,
  };
}
