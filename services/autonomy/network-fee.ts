const SCALE = BigInt("1000000000000000000");
const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/;

/**
 * Binance labels quote.tradeFee as an estimated network fee in USD and warns
 * that it may be inaccurate. Apply a configurable upward buffer before using
 * it as a risk input. This is still an estimate, not a gas guarantee.
 */
export function applyNetworkFeeBuffer(
  estimatedNetworkFeeUsd: string,
  bufferBps = 10_000,
): string {
  const match = DECIMAL.exec(estimatedNetworkFeeUsd);
  if (!match || !Number.isInteger(bufferBps) || bufferBps < 0 || bufferBps > 100_000) {
    throw new Error("Invalid estimated network fee or buffer");
  }
  const fraction = (match[2] ?? "").padEnd(18, "0");
  const amount = BigInt(match[1]) * SCALE + BigInt(fraction || "0");
  const buffered = (amount * BigInt(10_000 + bufferBps) + BigInt(9_999)) / BigInt(10_000);
  const whole = buffered / SCALE;
  const decimal = (buffered % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return whole.toString() + (decimal ? "." + decimal : "");
}
