import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const BNB_USD_FEED = process.env.BSC_TESTNET_BNB_USD_FEED;
const BNB_FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const RPC_URL =
  process.env.BSC_TESTNET_RPC_URL ||
  "https://data-seed-prebsc-1-s1.binance.org:8545";

function requirePrivateKey() {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY?.trim().replace(/^['"]|['"]$/g, "");
  if (!privateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not set in this terminal environment.");
  }
  const normalizedPrivateKey = /^0x/i.test(privateKey)
    ? privateKey
    : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedPrivateKey)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex value prefixed with 0x.");
  }
  return normalizedPrivateKey;
}

async function compileContract() {
  const source = await readFile(
    new URL("../contracts/TradingAgentPolicyValidatorV2.sol", import.meta.url),
    "utf8",
  );
  const input = {
    language: "Solidity",
    sources: {
      "TradingAgentPolicyValidatorV2.sol": { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const result = spawnSync("solc", ["--standard-json"], {
    cwd: process.cwd(),
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `solc exited with status ${result.status}`);
  }

  const output = JSON.parse(result.stdout);
  const errors = output.errors?.filter((error) => error.severity === "error") ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.formattedMessage).join("\n"));
  }

  const contract =
    output.contracts?.["TradingAgentPolicyValidatorV2.sol"]
      ?.TradingAgentPolicyValidatorV2;
  if (!contract?.abi || !contract.evm?.bytecode?.object) {
    throw new Error("Failed to compile TradingAgentPolicyValidatorV2.");
  }
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

async function main() {
  if (!BNB_USD_FEED || !/^0x[0-9a-fA-F]{40}$/.test(BNB_USD_FEED)) throw new Error("BSC_TESTNET_BNB_USD_FEED must be the verified Chainlink BNB/USD feed address.");
  const privateKey = requirePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: bscTestnet,
    transport: http(RPC_URL),
  });
  const walletClient = createWalletClient({
    account,
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== 97) throw new Error(`Expected BSC Testnet 97, got ${chainId}.`);

  const [routerCode, entryPointCode, deployerBalance] = await Promise.all([
    publicClient.getBytecode({ address: ROUTER }),
    publicClient.getBytecode({ address: ENTRY_POINT }),
    publicClient.getBalance({ address: account.address }),
  ]);
  if (!routerCode || routerCode === "0x") throw new Error("Router has no bytecode.");
  if (!entryPointCode || entryPointCode === "0x") {
    throw new Error("EntryPoint has no bytecode.");
  }
  if (deployerBalance === 0n) {
    throw new Error("Deployer has no testnet BNB for gas.");
  }

  const factoryCall = await publicClient.call({
    to: ROUTER,
    data: encodeFunctionData({ abi: [{ type: "function", name: "factory", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }] }),
  });
  if (!factoryCall.data || factoryCall.data === "0x") {
    throw new Error("Router factory() call returned no data.");
  }
  const factory = decodeFunctionResult({
    abi: [{ type: "function", name: "factory", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
    data: factoryCall.data,
    functionName: "factory",
  });
  const factoryCode = await publicClient.getBytecode({ address: factory });
  if (!factoryCode || factoryCode === "0x") {
    throw new Error("Router factory address has no bytecode.");
  }

  const [bnbFeedCode, bnbFeedDecimals, bnbFeedDescription, bnbFeedRound] = await Promise.all([
    publicClient.getBytecode({ address: BNB_USD_FEED }),
    publicClient.readContract({ address: BNB_USD_FEED, abi: BNB_FEED_ABI, functionName: "decimals" }),
    publicClient.readContract({ address: BNB_USD_FEED, abi: BNB_FEED_ABI, functionName: "description" }),
    publicClient.readContract({ address: BNB_USD_FEED, abi: BNB_FEED_ABI, functionName: "latestRoundData" }),
  ]);
  if (!bnbFeedCode || bnbFeedCode === "0x") throw new Error("Configured BNB/USD feed has no bytecode.");
  if (bnbFeedDecimals > 18 || !/BNB\s*\/\s*USD$/i.test(bnbFeedDescription.trim())) {
    throw new Error(`Configured Chainlink feed "${bnbFeedDescription}" is not a supported BNB/USD feed.`);
  }
  const [feedRoundId, feedAnswer, , feedUpdatedAt, feedAnsweredInRound] = bnbFeedRound;
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (
    feedRoundId === 0n || feedAnswer <= 0n || feedUpdatedAt === 0n
    || feedUpdatedAt > now || now - feedUpdatedAt > 3600n
    || feedAnsweredInRound < feedRoundId
  ) {
    throw new Error("Configured BNB/USD Chainlink feed has an invalid, stale, future, or incomplete latest round.");
  }
  const { abi, bytecode } = await compileContract();
  console.log(`Deployer: ${account.address}`);
  console.log(`Balance: ${deployerBalance.toString()} wei`);
  console.log(`Router: ${ROUTER}`);
  console.log(`EntryPoint: ${ENTRY_POINT}`);
  console.log(`Factory: ${factory}`);
  console.log(`BNB/USD Chainlink feed: ${BNB_USD_FEED}`);

  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [ROUTER, ENTRY_POINT, BNB_USD_FEED],
    account,
  });
  console.log(`Transaction: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 120_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`Deployment reverted: ${hash}`);
  }
  if (!receipt.contractAddress) {
    throw new Error(`Deployment receipt had no contract address: ${hash}`);
  }

  const deployedCode = await publicClient.getBytecode({
    address: receipt.contractAddress,
  });
  if (!deployedCode || deployedCode === "0x") {
    throw new Error("Deployment address has no runtime bytecode.");
  }

  console.log(`Contract: ${receipt.contractAddress}`);
  console.log(`Block: ${receipt.blockNumber}`);
  console.log(`Guardian: ${account.address}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
