import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const [validatorArg, tokenArg, feedArg, maxAgeArg] = process.argv.slice(2);
if (!validatorArg || !tokenArg || !feedArg || !maxAgeArg) {
  throw new Error("Usage: node scripts/configure-chainlink-token-feed.mjs <validator> <token> <chainlink-usd-feed> <max-age-seconds>");
}
const validator = getAddress(validatorArg);
const token = getAddress(tokenArg);
const feed = getAddress(feedArg);
const maxAge = Number(maxAgeArg);
if (!Number.isSafeInteger(maxAge) || maxAge < 60 || maxAge > 86_400) {
  throw new Error("max-age-seconds must be an integer from 60 to 86400.");
}
const rawKey = process.env.PRIVATE_KEY?.trim().replace(/^['"]|['"]$/g, "");
if (!rawKey) throw new Error("PRIVATE_KEY is not set in this terminal environment.");
const privateKey = /^0x/i.test(rawKey) ? rawKey : `0x${rawKey}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("PRIVATE_KEY must be a 32-byte hex value.");
const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain: bscTestnet, transport: http(process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545") });
const walletClient = createWalletClient({ account, chain: bscTestnet, transport: publicClient.transport });
const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const validatorAbi = parseAbi([
  "function setTokenUsdFeed(address token,address feed,uint32 maxAge)",
  "function tokenUsdFeeds(address token) view returns (address)",
]);
if (await publicClient.getChainId() !== 97) throw new Error("This setup script only supports BSC Testnet.");
const [validatorCode, tokenCode, feedCode, decimals, round] = await Promise.all([
  publicClient.getBytecode({ address: validator }),
  publicClient.getBytecode({ address: token }),
  publicClient.getBytecode({ address: feed }),
  publicClient.readContract({ address: feed, abi: feedAbi, functionName: "decimals" }),
  publicClient.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" }),
]);
if (!validatorCode || !tokenCode || !feedCode) throw new Error("Validator, token, and Chainlink feed must all have deployed bytecode.");
if (decimals > 18) throw new Error("Feed decimals above 18 are not supported.");
const [roundId, answer, , updatedAt, answeredInRound] = round;
const now = BigInt(Math.floor(Date.now() / 1000));
if (answer <= 0n || updatedAt === 0n || updatedAt > now || now - updatedAt > BigInt(maxAge) || answeredInRound < roundId) {
  throw new Error("Chainlink feed has an invalid, stale, or incomplete latest round.");
}
console.log(`Guardian: ${account.address}`);
console.log(`Validator: ${validator}`);
console.log(`Token: ${token}`);
console.log(`Chainlink USD feed: ${feed}`);
console.log(`Feed decimals: ${decimals}`);
console.log(`Max age: ${maxAge}s`);
const hash = await walletClient.writeContract({
  address: validator,
  abi: validatorAbi,
  functionName: "setTokenUsdFeed",
  args: [token, feed, maxAge],
  account,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") throw new Error(`Feed configuration reverted: ${hash}`);
const configured = await publicClient.readContract({ address: validator, abi: validatorAbi, functionName: "tokenUsdFeeds", args: [token] });
if (configured.toLowerCase() !== feed.toLowerCase()) throw new Error("Feed configuration readback mismatch.");
console.log(`Configured token/USD feed in transaction ${hash}`);
