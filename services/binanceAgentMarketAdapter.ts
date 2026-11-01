import "server-only";
import { getRWATokenList } from "../lib/binance.ts";
import { isSpotEligibleAsset } from "../lib/compliance.ts";
import { isRwaAssetListResponse, parseRwaAssetRecords } from "../lib/rwaAssetResponse.ts";
import type { AssetVersionInput } from "../lib/agentControlPlane.ts";
import type { MarketDataAdapter } from "./marketDataCollector.ts";

export class BinanceAgentMarketAdapter implements MarketDataAdapter {
  readonly providerId = "binance-web3-rwa-catalogue";

  async loadCatalogue(watchlist: readonly string[]): Promise<AssetVersionInput[]> {
    const response: unknown = await getRWATokenList();
    if (!isRwaAssetListResponse(response)) {
      throw new Error("Binance RWA catalogue response did not match the documented asset-list contract.");
    }
    const selected = new Set(watchlist.map((address) => address.toLowerCase()));
    return parseRwaAssetRecords(response).flatMap((asset) => {
      if (!selected.has(asset.tokenContractAddress.toLowerCase()) ||
        !isSpotEligibleAsset(asset)) return [];
      const ratio = decimalString(asset.tokenToShareRatio);
      return [{
        chainId: 56,
        tokenAddress: asset.tokenContractAddress,
        ticker: asset.underlyingTicker,
        platform: asset.platformId,
        decimals: null,
        shareDenomination: ratio ? { tokenToShareRatio: ratio } : null,
        metadataSource: this.providerId,
        observedAt: Date.now(),
        blockNumber: null,
        blockHash: null,
        metadata: {
          symbol: asset.symbol ?? null,
          tokenName: asset.tokenName ?? null,
          underlyingName: asset.underlyingName ?? null,
          tokenToShareRatio: ratio,
          tokenPrice: scalarString(asset.tokenPrice),
          referencePrice: scalarString(asset.referencePrice),
          marketStatus: asset.statusInfo?.marketStatus ?? null,
          openState: asset.statusInfo?.openState ?? null,
        },
      }];
    });
  }
}

function decimalString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = String(value);
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(parsed) && Number.isFinite(Number(parsed)) && Number(parsed) > 0
    ? parsed
    : null;
}

function scalarString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = String(value);
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(parsed) && Number.isFinite(Number(parsed))
    ? parsed
    : null;
}
