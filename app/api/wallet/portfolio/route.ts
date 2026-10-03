import { NextResponse } from "next/server";
import { getAllTokenBalancesByAddress, getPortfolioOverview } from "@/lib/binance";
import { EVM_ADDRESS_PATTERN } from "@/lib/apiValidation";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type Holding = {
  binanceChainId: string;
  tokenContractAddress: string;
  symbol: string;
  balance: number | null;
  rawBalance: string | null;
  tokenPriceUsd: number | null;
  valueUsd: number | null;
  isRiskToken: boolean;
};

function normalizeHoldings(result: unknown): Holding[] {
  if (!isRecord(result) || !Array.isArray(result.data)) return [];
  const holdings: Holding[] = [];

  for (const chainEntry of result.data) {
    if (!isRecord(chainEntry) || !Array.isArray(chainEntry.tokenAssets)) continue;
    for (const rawAsset of chainEntry.tokenAssets) {
      if (!isRecord(rawAsset)) continue;
      const balance = numberValue(rawAsset.balance);
      const tokenPriceUsd = numberValue(rawAsset.tokenPrice);
      const valueUsd = balance != null && tokenPriceUsd != null ? balance * tokenPriceUsd : null;
      const symbol = typeof rawAsset.symbol === "string" ? rawAsset.symbol : "Unknown asset";
      const tokenContractAddress = typeof rawAsset.tokenContractAddress === "string" ? rawAsset.tokenContractAddress : "";
      const binanceChainId = typeof rawAsset.binanceChainId === "string"
        ? rawAsset.binanceChainId
        : typeof chainEntry.binanceChainId === "string" ? chainEntry.binanceChainId : "56";

      if ((balance == null || balance <= 0) && (valueUsd == null || valueUsd <= 0)) continue;
      holdings.push({
        binanceChainId,
        tokenContractAddress,
        symbol,
        balance,
        rawBalance: typeof rawAsset.rawBalance === "string" ? rawAsset.rawBalance : null,
        tokenPriceUsd,
        valueUsd,
        isRiskToken: rawAsset.isRiskToken === true,
      });
    }
  }

  return holdings.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  if (!address || !EVM_ADDRESS_PATTERN.test(address)) {
    return NextResponse.json({ error: "Invalid EVM wallet address" }, { status: 400 });
  }

  try {
    const [balances, overview] = await Promise.all([
      getAllTokenBalancesByAddress(address),
      getPortfolioOverview(address, "2"),
    ]);

    return NextResponse.json(
      {
        address,
        chainId: "56",
        holdings: normalizeHoldings(balances),
        overview: isRecord(overview) && isRecord(overview.data) ? overview.data : null,
        fetchedAt: Date.now(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error: unknown) {
    console.error("Wallet portfolio lookup failed:", error);
    return NextResponse.json(
      { error: "Wallet portfolio data is temporarily unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
