const BINANCE_HOST = "web3.binance.com";

export const RESPONSIVE_FIXTURE_TOKEN = "0x0000000000000000000000000000000000000123";
export const RESPONSIVE_UNAVAILABLE_TOKEN = "0x0000000000000000000000000000000000000124";

const assets = [
  {
    tokenContractAddress: RESPONSIVE_FIXTURE_TOKEN,
    underlyingTicker: "TEST",
    underlyingName: "Responsive Test Company",
    tokenName: "TEST Stock",
    symbol: "TESTon",
    platformId: "ondo",
    tokenToShareRatio: "1",
    tokenPrice: "100",
    referencePrice: "100",
    statusInfo: { marketStatus: "open", openState: true },
  },
  {
    tokenContractAddress: RESPONSIVE_UNAVAILABLE_TOKEN,
    underlyingTicker: "OFFLINE",
    underlyingName: "Unavailable Test Company",
    tokenName: "OFFLINE Stock",
    symbol: "OFFLINEon",
    platformId: "ondo",
    tokenToShareRatio: "1",
    tokenPrice: "100",
    referencePrice: "100",
    statusInfo: { marketStatus: "open", openState: true },
  },
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unavailable(url) {
  return url.searchParams.get("tokenContractAddress") === RESPONSIVE_UNAVAILABLE_TOKEN;
}

if (process.env.WOLV_RESPONSIVE_FIXTURE === "1") {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const requestUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.hostname !== BINANCE_HOST) return originalFetch(input, init);

    if (url.pathname.endsWith("/api/v1/dex/market/rwa/tokens")) {
      return jsonResponse({ success: true, data: assets });
    }
    if (url.pathname.endsWith("/api/v1/dex/market/rwa/platforms")) {
      return jsonResponse({ success: true, data: [{ platformId: "ondo" }] });
    }
    if (url.pathname.endsWith("/api/v1/dex/market/rwa/underlying-market")) {
      if (unavailable(url)) return jsonResponse({ success: false, code: 503, msg: "Responsive fixture: market data unavailable" }, 503);
      return jsonResponse({ success: true, data: { marketData: { peRatioTTM: 20, marketCap: 1_000_000, high52W: 120, low52W: 80 } } });
    }
    if (url.pathname.endsWith("/api/v1/dex/market/rwa/underlying-profile")) {
      return jsonResponse({ success: true, data: { industry: "Test fixtures", country: "Test" } });
    }
    if (url.pathname.endsWith("/api/v1/dex/market/candles")) {
      const now = Date.now();
      return jsonResponse({
        success: true,
        data: [
          ["99", "101", "98", "100", "1000", String(now - 3_600_000), "1"],
          ["100", "102", "99", "101", "1100", String(now), "1"],
        ],
      });
    }
    if (url.pathname.endsWith("/api/v1/dex/aggregator/quote")) {
      const token = url.searchParams.get("toTokenAddress");
      if (token === RESPONSIVE_UNAVAILABLE_TOKEN) return jsonResponse({ success: true, data: [] });
      const inputAmount = url.searchParams.get("amount") ?? "100000000000000000000";
      return jsonResponse({
        success: true,
        data: [{
          quoteId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          binanceChainId: "56",
          executionMode: "RFQ",
          fromTokenAmount: inputAmount,
          toTokenAmount: "1000000000000000000",
          fromToken: {
            tokenContractAddress: "0x55d398326f99059ff775485246999027b3197955",
            tokenUnitPrice: "1",
            decimal: "18",
          },
          toToken: {
            tokenContractAddress: token,
            decimal: "18",
          },
          vendorName: "responsive-mock",
          priceImpactPercent: "0",
        }],
      });
    }

    return jsonResponse({ success: false, code: 404, msg: "Responsive fixture: unsupported Binance endpoint" }, 404);
  };
}
