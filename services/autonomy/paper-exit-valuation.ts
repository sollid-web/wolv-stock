const SCALE = BigInt("1000000000000000000");
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;

function scaled(value: string, field: string): bigint {
  const match = DECIMAL.exec(value);
  if (!match) throw new Error("Invalid " + field);
  return BigInt(match[1]) * SCALE + BigInt((match[2] ?? "").padEnd(18, "0") || "0");
}
function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Invalid token decimals");
  return BigInt(10) ** BigInt(decimals);
}
function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= BigInt(0)) throw new Error("Division denominator must be positive");
  return (n + d - BigInt(1)) / d;
}

/** Apply a slippage haircut and output-token tax, rounding proceeds down. */
export function conservativeExitProceeds(input: {
  expectedAmountOut: string; slippageBps: number; outputTaxRate: string;
}): string {
  if (!INTEGER.test(input.expectedAmountOut) || BigInt(input.expectedAmountOut) <= BigInt(0) ||
      !Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 5000) {
    throw new Error("Invalid exit amount or slippage");
  }
  const tax = scaled(input.outputTaxRate, "outputTaxRate");
  if (tax < BigInt(0) || tax > SCALE) throw new Error("Output tax must be between zero and one");
  const afterSlippage = BigInt(input.expectedAmountOut) * BigInt(10_000 - input.slippageBps) / BigInt(10_000);
  return (afterSlippage * (SCALE - tax) / SCALE).toString();
}

/** Convert a USD fee estimate into output-token base units, rounding fee upward. */
export function usdFeeToTokenUnits(input: {
  feeUsd: string; tokenUsdPrice: string; tokenDecimals: number;
}): string {
  const fee = scaled(input.feeUsd, "feeUsd");
  const price = scaled(input.tokenUsdPrice, "tokenUsdPrice");
  if (price <= BigInt(0)) throw new Error("Output token USD price must be positive");
  return ceilDiv(fee * pow10(input.tokenDecimals), price).toString();
}

export function calculateExitReturnBps(costBasisInputUnits: string, netProceedsInputUnits: string): number {
  if (!INTEGER.test(costBasisInputUnits) || BigInt(costBasisInputUnits) <= BigInt(0) ||
      !INTEGER.test(netProceedsInputUnits) || BigInt(netProceedsInputUnits) < BigInt(0)) {
    throw new Error("Invalid exit cost basis or proceeds");
  }
  const result = (BigInt(netProceedsInputUnits) - BigInt(costBasisInputUnits)) * BigInt(10_000) / BigInt(costBasisInputUnits);
  const number = Number(result);
  if (!Number.isSafeInteger(number)) throw new Error("Exit return is outside supported range");
  return number;
}
