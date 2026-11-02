import "server-only";
import {
  call,
  estimateGas,
  getBalance,
  getChainId,
  getGasPrice,
  getBlockNumber,
} from "viem/actions";
import {
  decodeFunctionData,
  getAddress,
  isAddress,
  parseEther,
  type Address,
  type Client,
  type Hex,
} from "viem";
import {
  buildAgentBuyCall,
  createAgentPublicClient,
  getAgentSmartAccountConfig,
  type AgentSmartAccountConfig,
} from "../lib/smartAccount.ts";
import {
  authorizeBawWalletRequest,
  getBawWalletSession,
  readBawWalletAuthJson,
  type BawWalletAuthorization,
} from "./bawWalletAuth.ts";

const MAX_BODY_BYTES = 4_096;
const MAX_TRADE_VALUE = parseEther("0.5");
const MAX_SLIPPAGE_BPS = 100;
const MAX_DEADLINE_SECONDS = 300;
const HEADERS = { "Cache-Control": "no-store" };

const ROUTER_ABI = [
  {
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
  },
] as const;

type SimulationCall = {
  account: Address;
  to: Address;
  value: bigint;
  data: Hex;
};

type SimulationRpc = {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBalance(account: Address): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  estimateGas(transaction: SimulationCall): Promise<bigint>;
  call(transaction: SimulationCall): Promise<unknown>;
};

type SimulationInput = {
  amountBnb: string;
  slippageBps: number;
};

export class AgentTransactionSimulationError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "CONFIG_INVALID"
    | "CHAIN_MISMATCH"
    | "ROUTE_INVALID"
    | "BALANCE_INSUFFICIENT"
    | "RPC_ERROR";
  readonly status: number;

  constructor(
    code: AgentTransactionSimulationError["code"],
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "AgentTransactionSimulationError";
    this.code = code;
    this.status = status;
  }
}

export type AgentTransactionSimulationDependencies = {
  authorize?: (request: Request) => Promise<BawWalletAuthorization>;
  getOwnerAddress?: (request: Request) => Promise<string | null>;
  getConfig?: () => AgentSmartAccountConfig;
  createPublicClient?: (config: AgentSmartAccountConfig) => Client;
  createRpc?: (config: AgentSmartAccountConfig) => SimulationRpc;
  buildBuyCall?: typeof buildAgentBuyCall;
  now?: () => number;
};

export async function simulateAgentTransaction(
  input: SimulationInput,
  ownerAddress: string,
  dependencies: Pick<
    AgentTransactionSimulationDependencies,
    "getConfig" | "createPublicClient" | "createRpc" | "buildBuyCall" | "now"
  > = {},
) {
  let config: AgentSmartAccountConfig;
  try {
    config = (dependencies.getConfig ?? getAgentSmartAccountConfig)();
  } catch {
    throw new AgentTransactionSimulationError(
      "CONFIG_INVALID",
      "Agent simulation configuration is unavailable.",
      503,
    );
  }
  if (config.chain.id !== 97) {
    throw new AgentTransactionSimulationError(
      "CHAIN_MISMATCH",
      "Agent transaction simulation is restricted to BSC testnet (chain ID 97).",
      409,
    );
  }

  if (!isAddress(ownerAddress)) {
    throw new AgentTransactionSimulationError(
      "INVALID_INPUT",
      "Wallet session address is invalid.",
      401,
    );
  }
  const owner = getAddress(ownerAddress);
  if (
    typeof input.amountBnb !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(input.amountBnb)
  ) {
    throw new AgentTransactionSimulationError(
      "INVALID_INPUT",
      "Simulation amount must be a positive decimal BNB amount.",
      422,
    );
  }
  const amountBnb = parseEther(input.amountBnb);
  if (
    amountBnb <= BigInt(0) ||
    amountBnb > MAX_TRADE_VALUE ||
    !Number.isSafeInteger(input.slippageBps) ||
    input.slippageBps < 1 ||
    input.slippageBps > MAX_SLIPPAGE_BPS
  ) {
    throw new AgentTransactionSimulationError(
      "INVALID_INPUT",
      "Simulation amount or slippage is outside the configured limit.",
      422,
    );
  }

  const rpc = (dependencies.createRpc ?? createSimulationRpc)(config);
  try {
    const chainId = await rpc.getChainId();
    if (chainId !== 97) {
      throw new AgentTransactionSimulationError(
        "CHAIN_MISMATCH",
        "RPC chain does not match BSC testnet (chain ID 97).",
        409,
      );
    }

    const built = await (dependencies.buildBuyCall ?? buildAgentBuyCall)(
      (dependencies.createPublicClient ?? createAgentPublicClient)(config),
      {
        accountAddress: owner,
        amountBnb,
        slippageBps: input.slippageBps,
        maxPriceImpactBps: 300,
      },
      config,
    );
    const decoded = decodeFunctionData({
      abi: ROUTER_ABI,
      data: built.data,
    });
    const [minimumOutput, path, recipient, deadline] = decoded.args;
    const nowSeconds = BigInt(Math.floor((dependencies.now ?? Date.now)() / 1000));
    if (
      built.to.toLowerCase() !== config.routerAddress.toLowerCase() ||
      built.value !== amountBnb ||
      decoded.functionName !== "swapExactETHForTokens" ||
      minimumOutput <= BigInt(0) ||
      minimumOutput !== built.quote.amountOutMin ||
      built.quote.slippageBps !== input.slippageBps ||
      built.quote.priceImpactBps > 300 ||
      path.length !== 2 ||
      path[0].toLowerCase() !== config.wrappedNativeAddress.toLowerCase() ||
      path[1].toLowerCase() !== config.targetTokenAddress.toLowerCase() ||
      recipient.toLowerCase() !== owner.toLowerCase() ||
      deadline <= nowSeconds ||
      deadline > nowSeconds + BigInt(MAX_DEADLINE_SECONDS)
    ) {
      throw new AgentTransactionSimulationError(
        "ROUTE_INVALID",
        "Built transaction does not match the configured router, token path, recipient, or spend limit.",
        422,
      );
    }

    const transaction: SimulationCall = {
      account: owner,
      to: built.to,
      value: built.value,
      data: built.data,
    };
    const [blockNumber, balance, gasPrice, gasEstimate] = await Promise.all([
      rpc.getBlockNumber(),
      rpc.getBalance(owner),
      rpc.getGasPrice(),
      rpc.estimateGas(transaction),
    ]);
    const requiredBalance = built.value + gasEstimate * gasPrice;
    if (balance < requiredBalance) {
      throw new AgentTransactionSimulationError(
        "BALANCE_INSUFFICIENT",
        "Wallet balance does not cover the trade value and estimated network fee.",
        422,
      );
    }
    await rpc.call(transaction);

    return {
      status: "SIMULATION_PASSED" as const,
      chainId,
      blockNumber: blockNumber.toString(),
      simulatedAt: (dependencies.now ?? Date.now)(),
      account: owner,
      router: built.to,
      targetToken: config.targetTokenAddress,
      tokenPath: path,
      amountBnb: input.amountBnb,
      expectedAmountOut: built.quote.expectedAmountOut.toString(),
      minimumAmountOut: minimumOutput.toString(),
      slippageBps: built.quote.slippageBps,
      priceImpactBps: built.quote.priceImpactBps,
      estimatedGas: gasEstimate.toString(),
      estimatedGasPriceWei: gasPrice.toString(),
      estimatedNetworkFeeWei: (gasEstimate * gasPrice).toString(),
      execution: {
        signingRequested: false,
        transactionBroadcast: false,
        executionEnabled: false,
      },
    };
  } catch (error) {
    if (error instanceof AgentTransactionSimulationError) throw error;
    throw new AgentTransactionSimulationError(
      "RPC_ERROR",
      "BSC testnet could not complete the read-only transaction simulation.",
      502,
    );
  }
}

export async function handleAgentTransactionSimulationPost(
  request: Request,
  dependencies: AgentTransactionSimulationDependencies = {},
): Promise<Response> {
  const authorization = await (dependencies.authorize ?? ((incoming) =>
    authorizeBawWalletRequest(incoming, process.env.BAW_WALLET_API_TOKEN)))(request);
  if (authorization !== "authorized") {
    const status = authorization === "not_configured" ||
      authorization === "storage_unavailable" ? 503 : 401;
    return json({
      error: authorization === "not_configured"
        ? "Agent simulation access is not configured."
        : authorization === "storage_unavailable"
          ? "Operator authorization storage is unavailable."
          : "A valid operator authorization is required.",
    }, status);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 400);
  }

  const parsed = await readBawWalletAuthJson(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.message }, parsed.status);
  const input = parseSimulationInput(parsed.value);
  if (!input) {
    return json({
      error: "Simulation request must contain only amountBnb and slippageBps within the configured limits.",
    }, 422);
  }

  let ownerAddress: string | null;
  try {
    ownerAddress = dependencies.getOwnerAddress
      ? await dependencies.getOwnerAddress(request)
      : (await getBawWalletSession(request, process.env.BAW_WALLET_API_TOKEN))?.address ?? null;
  } catch {
    return json({ error: "Browser-wallet authorization storage is unavailable." }, 503);
  }
  if (!ownerAddress) return json({ error: "A valid operator wallet session is required." }, 401);

  try {
    return json(await simulateAgentTransaction(input, ownerAddress, dependencies));
  } catch (error) {
    if (error instanceof AgentTransactionSimulationError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    console.error("Agent transaction simulation failed:", error);
    return json({
      error: "Agent transaction simulation could not be completed.",
      code: "SIMULATION_FAILED",
    }, 502);
  }
}

function parseSimulationInput(value: unknown): SimulationInput | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  ) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.amountBnb !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(record.amountBnb) ||
    typeof record.slippageBps !== "number" ||
    !Number.isSafeInteger(record.slippageBps) ||
    record.slippageBps < 1 ||
    record.slippageBps > MAX_SLIPPAGE_BPS
  ) return null;
  try {
    const amount = parseEther(record.amountBnb);
    if (amount <= BigInt(0) || amount > MAX_TRADE_VALUE) return null;
  } catch {
    return null;
  }
  return { amountBnb: record.amountBnb, slippageBps: record.slippageBps };
}

function createSimulationRpc(config: AgentSmartAccountConfig): SimulationRpc {
  const client = createAgentPublicClient(config);
  return {
    getChainId: () => getChainId(client),
    getBlockNumber: () => getBlockNumber(client),
    getBalance: (account) => getBalance(client, { address: account }),
    getGasPrice: () => getGasPrice(client),
    estimateGas: (transaction) => estimateGas(client, transaction),
    call: (transaction) => call(client, transaction),
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS });
}
