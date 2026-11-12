import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { bscTestnet } from "viem/chains";
import { hashAgentPolicy } from "../lib/agentPolicyHash.ts";

const RPC_URL =
  process.env.BSC_TESTNET_RPC_URL ||
  "https://data-seed-prebsc-1-s1.binance.org:8545";
const MAX_TRADE_VALUE = 500_000_000_000_000_000n;
const POLICY_ABI = parseAbi([
  "function isInitialized(address smartAccount) view returns (bool)",
  "function getTargetToken(address account) view returns (address)",
  "function setAccountPolicy(address smartAccount, address intentSigner, bytes32 policyHash, uint192 maxTradeValue, uint64 expiresAt)",
]);
const KERNEL_ABI = parseAbi([
  "function execute(bytes32 mode, bytes executionCalldata)",
]);
const SINGLE_CALL_MODE = `0x${"00".repeat(32)}`;

function parseArguments(argv) {
  const values = new Map();
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-testnet") {
      if (confirmed) throw new Error("Duplicate --confirm-testnet flag.");
      confirmed = true;
      continue;
    }
    if (!["--hook", "--account", "--owner-address", "--strategy-id", "--target-token", "--intent-signer", "--max-trade-wei", "--expires-at", "--amount-bnb-wei", "--entry-price-micros", "--slippage-bps", "--max-price-impact-bps"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  if (!confirmed) throw new Error("Refusing to prepare policy calldata without --confirm-testnet.");
  for (const required of ["--hook", "--account", "--owner-address", "--strategy-id", "--target-token", "--intent-signer", "--max-trade-wei", "--expires-at", "--amount-bnb-wei", "--entry-price-micros", "--slippage-bps", "--max-price-impact-bps"]) {
    if (!values.has(required)) throw new Error(`Required argument missing: ${required}`);
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const hookAddress = getAddress(args.get("--hook"));
  const accountAddress = getAddress(args.get("--account"));
  const ownerAddress = getAddress(args.get("--owner-address"));
  const strategyId = args.get("--strategy-id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(strategyId)) {
    throw new Error("--strategy-id must be 1-64 safe identifier characters.");
  }
  const targetToken = getAddress(args.get("--target-token"));
  const intentSigner = getAddress(args.get("--intent-signer"));
  const maxTradeValue = BigInt(args.get("--max-trade-wei"));
  if (maxTradeValue <= 0n || maxTradeValue > MAX_TRADE_VALUE) {
    throw new Error("--max-trade-wei must be between 1 and 0.5 BNB in wei.");
  }
  const expiresAt = BigInt(args.get("--expires-at"));
  const amountBnb = BigInt(args.get("--amount-bnb-wei"));
  const entryPriceMicros = BigInt(args.get("--entry-price-micros"));
  const slippageBps = Number(args.get("--slippage-bps"));
  const maxPriceImpactBps = Number(args.get("--max-price-impact-bps"));
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (expiresAt <= nowSeconds || expiresAt > (1n << 64n) - 1n) {
    throw new Error("--expires-at must be a future Unix timestamp that fits uint64.");
  }
  const publicClient = createPublicClient({
    chain: bscTestnet,
    transport: http(RPC_URL),
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== 97) throw new Error(`Expected BSC Testnet 97; RPC returned ${chainId}.`);
  const code = await publicClient.getBytecode({ address: hookAddress });
  if (!code || code === "0x") throw new Error("Hook address has no deployed bytecode.");

  const installed = await publicClient.readContract({
    address: hookAddress,
    abi: POLICY_ABI,
    functionName: "isInitialized",
    args: [accountAddress],
  });
  if (!installed) {
    throw new Error("The smart account must install the new policy hook before policy configuration.");
  }
  const installedTargetToken = await publicClient.readContract({
    address: hookAddress,
    abi: POLICY_ABI,
    functionName: "getTargetToken",
    args: [accountAddress],
  });
  if (installedTargetToken.toLowerCase() !== targetToken.toLowerCase()) {
    throw new Error(`Installed policy hook target ${installedTargetToken} does not match --target-token ${targetToken}.`);
  }
  const policyHash = hashAgentPolicy({
    strategyId,
    account,
    targetToken,
    maxTradeValue,
    expiresAt,
    intentSigner,
    amountBnb,
    entryPriceMicros,
    slippageBps,
    maxPriceImpactBps,
  });

  const policyCall = encodeFunctionData({
    abi: POLICY_ABI,
    functionName: "setAccountPolicy",
    args: [accountAddress, intentSigner, policyHash, maxTradeValue, expiresAt],
  });
  const executionCalldata = concatHex([
    hookAddress,
    encodeAbiParameters([{ type: "uint256" }], [0n]),
    policyCall,
  ]);
  const kernelCallData = encodeFunctionData({
    abi: KERNEL_ABI,
    functionName: "execute",
    args: [SINGLE_CALL_MODE, executionCalldata],
  });

  console.log("No transaction was signed or broadcast.");
  console.log(`Chain: BSC Testnet 97`);
  console.log(`Hook: ${hookAddress}`);
  console.log(`Smart account: ${accountAddress}`);
  console.log(`Strategy ID: ${strategyId}`);
  console.log(`Target token: ${targetToken}`);
  console.log(`Intent signer: ${intentSigner}`);
  console.log(`Policy hash: ${policyHash}`);
  console.log(`Maximum trade: ${maxTradeValue} wei`);
  console.log(`Strategy amount: ${amountBnb} wei`);
  console.log(`Entry price threshold: ${entryPriceMicros} micro-USD`);
  console.log(`Maximum slippage: ${slippageBps} BPS`);
  console.log(`Maximum price impact: ${maxPriceImpactBps} BPS`);
  console.log(`Policy expires: ${expiresAt}`);
  console.log("Submit this Kernel call through the smart account with its owner validator:");
  console.log(kernelCallData);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
