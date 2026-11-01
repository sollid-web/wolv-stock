import "server-only";
import crypto from "node:crypto";

export function makeBinanceAuthHeaders(
  method: string,
  path: string,
  body = "",
  options: {
    apiKey?: string;
    secretKey?: string;
    now?: () => Date;
  } = {},
) {
  const apiKey = options.apiKey ?? process.env.BINANCE_API_KEY;
  const secretKey = options.secretKey ?? process.env.BINANCE_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new Error("Binance Web3 API credentials are not configured.");
  }
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const requestPath = "/build" + path;
  const preHash = timestamp + method.toUpperCase() + requestPath + body;
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(preHash, "utf8")
    .digest("base64");
  return {
    "X-OC-APIKEY": apiKey,
    "X-OC-TIMESTAMP": timestamp,
    "X-OC-SIGN": signature,
    "X-OC-RECV-WINDOW": "60000",
  };
}
