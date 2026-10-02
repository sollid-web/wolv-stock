import { parseUnits } from "viem";

const UINT256_MAX = BigInt(2) ** BigInt(256) - BigInt(1);

export const BSC_USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
export const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function isPositiveUint256(value: string): boolean {
  const normalized = normalizeUint256(value);
  return normalized !== null && BigInt(normalized) > BigInt(0);
}

export function normalizeUint256(value: string): string | null {
  if (!/^(?:\d{1,78}|0x[a-fA-F0-9]{1,64})$/.test(value)) return null;
  const amount = BigInt(value);
  return amount <= UINT256_MAX ? amount.toString() : null;
}

export function usdtAmountToWei(value: string): string {
  const amount = value.trim();
  if (!/^(?:\d+\.?\d{0,18}|\.\d{1,18})$/.test(amount)) {
    throw new Error("Enter a positive USDT amount with no more than 18 decimal places");
  }
  const normalized = amount.startsWith(".") ? `0${amount}` : amount;
  const parsed = parseUnits(normalized.endsWith(".") ? normalized.slice(0, -1) : normalized, 18);
  if (parsed <= BigInt(0)) throw new Error("USDT amount must be greater than zero");
  return parsed.toString();
}

export function isValidUsdtAmount(value: string): boolean {
  try {
    usdtAmountToWei(value);
    return true;
  } catch {
    return false;
  }
}

export function isSafeOrderId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}