#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
      }
    }
  }
}

export function schemaSummary(order) {
  const base = {
    format: order.typedDataFormat,
    sha256: order.typedDataHash,
    byteLength: order.typedDataFormat === "HEX_EIP712_PAYLOAD"
      ? Math.max(0, (order.typedDataToSign.length - 2) / 2)
      : Buffer.byteLength(order.typedDataToSign, "utf8"),
  };
  if (order.typedDataFormat !== "JSON_TYPED_DATA") {
    return { ...base, opaqueHex: true, signingAllowedByCurrentWolvPolicy: false };
  }
  const typed = JSON.parse(order.typedDataToSign);
  const domain = typed.domain ?? {};
  const types = typed.types ?? {};
  const fields = Object.fromEntries(Object.entries(types).map(([typeName, members]) => [
    typeName,
    Array.isArray(members) ? members.map((field) => ({
      name: typeof field?.name === "string" ? field.name : null,
      type: typeof field?.type === "string" ? field.type : null,
    })) : [],
  ]));
  return {
    ...base,
    opaqueHex: false,
    domain: {
      fieldNames: Object.keys(domain).sort(),
      chainId: domain.chainId ?? null,
      verifyingContract: typeof domain.verifyingContract === "string" ? domain.verifyingContract : null,
      name: typeof domain.name === "string" ? domain.name : null,
      version: typeof domain.version === "string" ? domain.version : null,
    },
    primaryType: typed.primaryType,
    typeDefinitions: fields,
    messageFieldNames: Object.keys(typed.message ?? {}).sort(),
    signingAllowedByCurrentWolvPolicy: false,
  };
}

export async function runRfqSchemaProbe(args = process.argv.slice(2), env = process.env) {
  const walletAddress = argFrom(args, "wallet", env.WOLV_AUTONOMY_WALLET_ADDRESS);
  const inputTokenAddress = argFrom(args, "input-token", env.WOLV_AUTONOMY_INPUT_TOKEN_ADDRESS);
  const outputTokenAddress = argFrom(args, "output-token", env.WOLV_AUTONOMY_PROBE_OUTPUT_TOKEN_ADDRESS);
  const amountIn = argFrom(args, "amount", env.WOLV_AUTONOMY_ORDER_AMOUNT_BASE_UNITS);
  const slippageBps = Number(argFrom(args, "slippage-bps", env.WOLV_AUTONOMY_MAX_SLIPPAGE_BPS ?? "50"));
  const maxPriceImpactBps = Number(argFrom(args, "max-impact-bps", env.WOLV_AUTONOMY_MAX_PRICE_IMPACT_BPS ?? "100"));
  for (const [field, value] of Object.entries({ walletAddress, inputTokenAddress, outputTokenAddress, amountIn })) {
    if (!value) throw new Error("Missing " + field + " (CLI argument or local environment).");
  }
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) {
    throw new Error("BINANCE_API_KEY and BINANCE_SECRET_KEY are required in the local server environment.");
  }
  const { getValidatedBinanceRwaQuote } = await import("../services/autonomy/binance-quote-provider.ts");
  const { buildValidatedBinanceRfqOrder } = await import("../services/autonomy/binance-rfq-order-provider.ts");
  const quote = await getValidatedBinanceRwaQuote({
    chainId: "56", walletAddress, inputTokenAddress, outputTokenAddress, amountIn, slippageBps,
  });
  const order = await buildValidatedBinanceRfqOrder({
    quote, slippageBps, maxPriceImpactBps,
  });
  return {
    mode: "READ_ONLY_UNSIGNED_RFQ_SCHEMA_PROBE",
    signed: false,
    submitted: false,
    broadcast: false,
    chainId: order.chainId,
    walletAddress: order.walletAddress,
    inputTokenAddress: order.inputTokenAddress,
    outputTokenAddress: order.outputTokenAddress,
    amountIn: order.amountIn,
    expectedAmountOut: order.expectedAmountOut,
    quoteId: order.quoteId,
    orderId: order.orderId,
    vendor: order.vendor,
    signingScheme: order.signingScheme,
    approvalRequired: order.approvalRequired,
    approvalTarget: order.approvalTarget,
    quoteExpiresAt: order.quoteExpiresAt,
    typedData: schemaSummary(order),
  };
}

function argFrom(args, name, fallback) {
  const index = args.indexOf("--" + name);
  return index >= 0 ? args[index + 1] : fallback;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  loadLocalEnv();
  try {
    const result = await runRfqSchemaProbe(process.argv.slice(2), process.env);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("[rfq-schema-probe] failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  }
}
