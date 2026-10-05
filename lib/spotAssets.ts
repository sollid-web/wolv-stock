import { getRWATokenList } from "@/lib/binance";
import { isSpotEligibleAsset, type SpotAssetIdentity } from "@/lib/compliance";
import { isRwaAssetListResponse } from "./rwaAssetResponse";

type RwaScalar = string | number | null;

export type RwaAssetRecord = SpotAssetIdentity & {
  tokenContractAddress: string;
  underlyingTicker: string;
  platformId: string;
  underlyingName?: string;
  tokenName?: string;
  symbol?: string;
  name?: string;
  tokenLogoUrl?: string;
  tokenToShareRatio?: RwaScalar;
  tokenPrice?: RwaScalar;
  referencePrice?: RwaScalar;
  volume24H?: RwaScalar;
  marketCap?: RwaScalar;
  peRatioTTM?: RwaScalar;
  statusInfo?: { openState?: boolean; marketStatus?: string | null };
  tags?: string[];
};

export type RwaPlatformRecord = { platformId: string; logoUrl?: string };

function stringOrNull(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function scalar(value: unknown): RwaScalar | undefined {
  return typeof value === "string" || typeof value === "number" || value === null
    ? value
    : undefined;
}

export function parseRwaAssetRecords(response: unknown): RwaAssetRecord[] {
  if (!isRwaAssetListResponse(response)) return [];

  return response.data.flatMap((value) => {
    if (
      !isRecord(value) ||
      typeof value.tokenContractAddress !== "string" ||
      typeof value.underlyingTicker !== "string" ||
      typeof value.platformId !== "string"
    ) return [];

    const status = isRecord(value.statusInfo) ? value.statusInfo : null;
    const tags = Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === "string")
      : undefined;

    return [{
      tokenContractAddress: value.tokenContractAddress,
      underlyingTicker: value.underlyingTicker,
      platformId: value.platformId,
      tokenLogoUrl: typeof value.tokenLogoUrl === "string" ? value.tokenLogoUrl : undefined,
      underlyingName: optionalString(value.underlyingName),
      tokenName: optionalString(value.tokenName),
      name: optionalString(value.name),
      symbol: optionalString(value.symbol),
      leverage: scalar(value.leverage),
      leverageFactor: scalar(value.leverageFactor),
      tokenToShareRatio: scalar(value.tokenToShareRatio),
      tokenPrice: scalar(value.tokenPrice),
      referencePrice: scalar(value.referencePrice),
      volume24H: scalar(value.volume24H),
      marketCap: scalar(value.marketCap),
      peRatioTTM: scalar(value.peRatioTTM),
      statusInfo: status ? {
        openState: typeof status.openState === "boolean" ? status.openState : undefined,
        marketStatus: stringOrNull(status.marketStatus),
      } : undefined,
      tags,
    }];
  });
}

export function parseRwaPlatformRecords(response: unknown): RwaPlatformRecord[] {
  if (!isRecord(response) || !Array.isArray(response.data)) return [];
  return response.data.flatMap((value) => {
    if (!isRecord(value) || typeof value.platformId !== "string") return [];
    return [{
      platformId: value.platformId,
      logoUrl: typeof value.logoUrl === "string" ? value.logoUrl : undefined,
    }];
  });
}

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
  if (!isRwaAssetListResponse(response)) return false;

  const token = response.data.find((value) => {
    if (!isRecord(value)) return false;
    return stringField(value, "tokenContractAddress")?.toLowerCase() === address.toLowerCase();
  });
  if (!isRecord(token)) return false;

  const identity = toSpotIdentity(token);
  return Boolean(identity.tokenContractAddress) && isSpotEligibleAsset(identity);
}
