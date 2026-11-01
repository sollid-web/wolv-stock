import type { SpotAssetIdentity } from "./compliance";

export type RwaAssetListResponse = { data: Record<string, unknown>[] };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function isRwaAssetListResponse(
  value: unknown,
  options: { allowEmpty?: boolean } = {}
): value is RwaAssetListResponse {
  if (!isRecord(value) || !Array.isArray(value.data)) return false;
  if (value.data.length === 0) return options.allowEmpty === true;

  return value.data.every((asset) =>
    isRecord(asset) &&
    typeof asset.tokenContractAddress === "string" && asset.tokenContractAddress.trim().length > 0 &&
    typeof asset.underlyingTicker === "string" && asset.underlyingTicker.trim().length > 0 &&
    typeof asset.platformId === "string" && asset.platformId.trim().length > 0
  );
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
