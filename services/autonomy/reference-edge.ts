const SCALE = BigInt("1000000000000000000");
const DECIMAL_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const INTEGER_RE = /^(0|[1-9][0-9]*)$/;

function parseScaled(value: string, field: string, allowZero = true): bigint {
  if (typeof value !== "string") throw new Error(`Invalid ${field}`);
  const match = DECIMAL_RE.exec(value);
  if (!match || (match[2]?.length ?? 0) > 18) throw new Error(`Invalid ${field}`);
  const fraction = (match[2] ?? "").padEnd(18, "0");
  const scaled = BigInt(match[1]) * SCALE + BigInt(fraction || "0");
  if (!allowZero && scaled <= BigInt(0)) throw new Error(`${field} must be positive`);
  return scaled;
}

function parseAmount(value: string, decimals: number, field: string): bigint {
  if (!INTEGER_RE.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`Invalid ${field}`);
  }
  const amount = BigInt(value);
  if (amount <= BigInt(0)) throw new Error(`${field} must be positive`);
  return amount;
}

function pow10(decimals: number): bigint {
  return BigInt(10) ** BigInt(decimals);
}
function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder !== BigInt(0) && numerator < BigInt(0) ? quotient - BigInt(1) : quotient;
}
function ceilPositiveDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - BigInt(1)) / denominator;
}
function formatScaled(value: bigint): string {
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + whole.toString() + (fraction ? "." + fraction : "");
}

export type ReferenceEdgeInput = {
  inputAmount: string;
  inputDecimals: number;
  inputTokenUsdPrice: string;
  inputTokenTaxRate: string;
  outputAmount: string;
  outputDecimals: number;
  outputTokenUsdPrice: string;
  outputTokenTaxRate: string;
  tradeFeeUsd: string;
  gasCostUsd: string;
};

export type ReferenceEdgeResult = {
  expectedEdgeBps: number;
  inputCostUsd: string;
  grossOutputValueUsd: string;
  netOutputValueUsd: string;
  totalFeesUsd: string;
};

/**
 * Conservative net edge against the supplied output valuation, which may be an executable exit quote or a reference target.
 * This is not guaranteed profit or an executable exit quote. Gas USD is required;
 * the function never treats a missing gas estimate as zero.
 */
export function calculateNetEdge(input: ReferenceEdgeInput): ReferenceEdgeResult {
  const inputAmount = parseAmount(input.inputAmount, input.inputDecimals, "inputAmount");
  const outputAmount = parseAmount(input.outputAmount, input.outputDecimals, "outputAmount");
  const inputPrice = parseScaled(input.inputTokenUsdPrice, "inputTokenUsdPrice", false);
  const targetPrice = parseScaled(input.outputTokenUsdPrice, "outputTokenUsdPrice", false);
  const inputTax = parseScaled(input.inputTokenTaxRate, "inputTokenTaxRate");
  const outputTax = parseScaled(input.outputTokenTaxRate, "outputTokenTaxRate");
  const tradeFee = parseScaled(input.tradeFeeUsd, "tradeFeeUsd");
  const gasCost = parseScaled(input.gasCostUsd, "gasCostUsd");
  if (inputTax > SCALE || outputTax > SCALE) throw new Error("Token tax rate must be between 0 and 1");

  // Round costs upward and proceeds downward so fractional units cannot
  // make an otherwise unprofitable candidate appear eligible.
  const inputNotional = ceilPositiveDiv(inputAmount * inputPrice, pow10(input.inputDecimals));
  const inputTaxCost = ceilPositiveDiv(inputNotional * inputTax, SCALE);
  const outputGross = outputAmount * targetPrice / pow10(input.outputDecimals);
  const outputTaxCost = ceilPositiveDiv(outputGross * outputTax, SCALE);
  const outputNet = outputGross - outputTaxCost;
  const totalFees = tradeFee + gasCost;
  const totalCost = inputNotional + inputTaxCost + totalFees;
  if (totalCost <= BigInt(0)) throw new Error("Total input cost must be positive");

  const edge = floorDiv((outputNet - totalCost) * BigInt(10_000), totalCost);
  const expectedEdgeBps = Number(edge);
  if (!Number.isSafeInteger(expectedEdgeBps)) throw new Error("Expected edge is outside the supported numeric range");
  return {
    expectedEdgeBps,
    inputCostUsd: formatScaled(inputNotional + inputTaxCost),
    grossOutputValueUsd: formatScaled(outputGross),
    netOutputValueUsd: formatScaled(outputNet),
    totalFeesUsd: formatScaled(totalFees),
  };
}
