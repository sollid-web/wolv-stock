export type RwaAssetListResponse = { data: Record<string, unknown>[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
