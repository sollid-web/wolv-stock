import crypto from "crypto";

let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 250) await new Promise(r => setTimeout(r, 250 - diff));
  lastCall = Date.now();
}

const API_KEY = process.env.BINANCE_API_KEY!;
const SECRET_KEY = process.env.BINANCE_SECRET_KEY!;
const BASE_URL = "https://web3.binance.com/build";

function makeHeaders(method: string, path: string, body = "") {
  const timestamp = new Date().toISOString();
  const requestPath = "/build" + path;
  const preHash = timestamp + method.toUpperCase() + requestPath + body;
  const signature = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(preHash, "utf8")
    .digest("base64");
  return {
    "X-OC-APIKEY": API_KEY,
    "X-OC-TIMESTAMP": timestamp,
    "X-OC-SIGN": signature,
  };
}

async function get(path: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  const fullPath = query ? `${path}?${query}` : path;
  const headers = makeHeaders("GET", fullPath);
  await rateLimit();
  const res = await fetch(`${BASE_URL}${fullPath}`, {
    headers,
    next: { revalidate: 60 },
  });
  const json = await res.json();
  if (!json.success && json.code !== 0) {
    throw new Error(`API error ${json.code}: ${json.msg}`);
  }
  return json;
}

// RWA — list all tokenized stocks
export async function getRWATokenList(platform?: string) {
  return get("/api/v1/dex/market/rwa/tokens",
    platform ? { platform } : {}
  );
}

// RWA — price for specific tokens
export async function getRWAPrice(contractAddresses: string[], chainId = "56") {
  return get("/api/v1/dex/market/rwa/price", {
    binanceChainId: chainId,
    tokenContractAddresses: contractAddresses.join(","),
  });
}

// RWA — search by keyword
export async function searchRWA(keyword: string) {
  return get("/api/v1/dex/market/rwa/search", { keyword });
}

// RWA — underlying company info
export async function getRWAProfile(contractAddress: string, chainId = "56") {
  return get("/api/v1/dex/market/rwa/underlying-profile", {
    binanceChainId: chainId,
    tokenContractAddress: contractAddress,
  });
}

// RWA — underlying market data (real stock price, P/E, 52w range)
export async function getRWAMarketData(contractAddress: string, chainId = "56") {
  return get("/api/v1/dex/market/rwa/underlying-market", {
    binanceChainId: chainId,
    tokenContractAddress: contractAddress,
  });
}

// RWA — issuance platforms (Ondo etc.)
export async function getRWAPlatforms() {
  return get("/api/v1/dex/market/rwa/platforms");
}

// Candlestick chart data
export async function getCandles(
  contractAddress: string,
  chainId = "56",
  bar = "1h",
  limit = "48"
) {
  return get("/api/v1/dex/market/candles", {
    binanceChainId: chainId,
    tokenContractAddress: contractAddress,
    bar,
    limit,
  });
}

// Aggregated quote (read-only): price to buy `toToken` with USDT on BSC
export async function getRWAQuote(
  toToken: string,
  amount = "100000000000000000000",
  wallet = "0x000000000000000000000000000000000000dEaD"
) {
  return get("/api/v1/dex/aggregator/quote", {
    binanceChainId: "56",
    fromTokenAddress: "0x55d398326f99059fF775485246999027B3197955",
    toTokenAddress: toToken,
    amount,
    userWalletAddress: wallet,
  });
}
