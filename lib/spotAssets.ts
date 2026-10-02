import { getRWATokenList } from "@/lib/binance";
import { isSpotEligibleAsset, type SpotAssetIdentity } from "@/lib/compliance";

type RwaTokenRecord = SpotAssetIdentity & { tokenContractAddress?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  return typeof record[field] === "string" ? record[field] : undefined;
}

function numericField(record: Record<string, unknown>, field: string): number | string | undefined {
  const value = record[field];
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function toSpotIdentity(record: Record<string, unknown>): RwaTokenRecord {
  return {
    tokenContractAddress: stringField(record, "tokenContractAddress"),
    underlyingTicker: stringField(record, "underlyingTicker"),
    symbol: stringField(record, "symbol"),
    underlyingName: stringField(record, "underlyingName"),
    tokenName: stringField(record, "tokenName"),
    name: stringField(record, "name"),
    leverage: numericField(record, "leverage"),
    leverageFactor: numericField(record, "leverageFactor"),
  };
}

export async function isSpotRwaTokenAddress(address: string): Promise<boolean> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return false;

  const response: unknown = await getRWATokenList();
  if (!isRecord(response) || !Array.isArray(response.data)) return false;

  const token = response.data.find((value) => {
    if (!isRecord(value)) return false;
    return stringField(value, "tokenContractAddress")?.toLowerCase() === address.toLowerCase();
  });
  if (!isRecord(token)) return false;

  const identity = toSpotIdentity(token);
  return Boolean(identity.tokenContractAddress) && isSpotEligibleAsset(identity);
}