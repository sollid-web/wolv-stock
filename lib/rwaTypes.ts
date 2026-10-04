import type { SpotAssetIdentity } from "@/lib/compliance";

export type RwaToken = SpotAssetIdentity & {
  tokenContractAddress: string;
  tokenLogoUrl?: string | null;
  tags?: string[];
  underlyingTicker?: string | null;
  underlyingName?: string | null;
  tokenName?: string | null;
  platformId?: string | null;
  tokenPrice?: string | number | null;
  referencePrice?: string | number | null;
  tokenToShareRatio?: string | number | null;
  volume24H?: string | number | null;
  marketCap?: string | number | null;
  peRatioTTM?: string | number | null;
  statusInfo?: {
    marketStatus?: string | null;
    openState?: boolean | null;
  } | null;
};

export type RwaPlatform = {
  platformId: string;
  logoUrl?: string | null;
};

export function isRwaToken(value: unknown): value is RwaToken {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).tokenContractAddress === "string";
}
