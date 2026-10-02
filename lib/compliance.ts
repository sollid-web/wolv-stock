const SPOT_TRADING_ONLY_BLACKLIST = new Set(["SOXL", "KORU", "MUU"]);
const LEVERAGED_ASSET_PATTERN = /\b(?:leveraged?|inverse|daily\s+(?:long|short)|\d+(?:\.\d+)?\s*x(?:\s*(?:long|short))?)\b/i;

export type SpotAssetIdentity = {
  underlyingTicker?: string | null;
  symbol?: string | null;
  underlyingName?: string | null;
  tokenName?: string | null;
  name?: string | null;
  leverage?: number | string | null;
  leverageFactor?: number | string | null;
};

export function isAssetCompliant(symbol: string): boolean {
  if (typeof symbol !== "string") return false;

  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return false;

  return !SPOT_TRADING_ONLY_BLACKLIST.has(normalized);
}

export function isSpotEligibleAsset(asset: SpotAssetIdentity | string): boolean {
  if (typeof asset === "string") return isAssetCompliant(asset);

  const symbol = asset.underlyingTicker ?? asset.symbol ?? "";
  if (!isAssetCompliant(symbol)) return false;

  const description = [
    asset.tokenName,
    asset.underlyingName,
    asset.name,
  ].filter(Boolean).join(" ");
  if (LEVERAGED_ASSET_PATTERN.test(description)) return false;

  for (const value of [asset.leverage, asset.leverageFactor]) {
    if (value != null) {
      const leverage = Number(value);
      if (!Number.isFinite(leverage) || Math.abs(leverage) > 1) return false;
    }
  }

  return true;
}

export function filterSpotEligibleAssets<T extends SpotAssetIdentity>(assets: T[]): T[] {
  return assets.filter(isSpotEligibleAsset);
}

// Preserve the original export for existing callers while tightening its spot-only behavior.
export function filterCompliantAssets<T extends SpotAssetIdentity>(assets: T[]): T[] {
  return filterSpotEligibleAssets(assets);
}
