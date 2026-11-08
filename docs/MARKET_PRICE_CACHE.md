# WOLV Market Price Cache

WOLV reuses its existing Supabase-hosted PostgreSQL database. This feature adds two tables; it does not create another database or require Redis.

## Data flow

1. The long-running Node market worker reads the explicit BSC watchlist from `WOLV_MARKET_WATCHLIST`.
2. It loads Binance's RWA catalogue, requests current RWA prices in batches, validates token identity and positive decimal prices, then persists observations and atomically upserts the latest row.
3. The frontend reads `GET /api/market/prices`, which queries only the compact latest-price table. It does not call Binance on every page load.
4. The response includes `ageMs` and `stale`. Stale data may be displayed as cached/reference information, never used as a fresh execution quote.

## Tables

- `wolv_market_prices_latest`: one current row per (chain, token); optimized for fast frontend reads.
- `wolv_market_price_history`: append-only provider observations, uniquely keyed by provider timestamp.

Both tables allow public reads and reserve writes for Supabase service role. Never expose the service-role key to browser code.

## Configuration

Use the existing app environment values:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BINANCE_API_KEY`
- `BINANCE_SECRET_KEY`

Add an explicit JSON watchlist and optional refresh interval:

```bash
WOLV_MARKET_WATCHLIST='["0x...","0x..."]'
WOLV_MARKET_REFRESH_MS=30000
```

Run the collector as a persistent Node worker, separate from Next.js request handling:

```bash
node --conditions=react-server --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types worker/marketPriceWorker.ts
```

The worker is read-only against Binance and writes only market observations to Supabase. It does not sign, submit or broadcast transactions. The first deployment should use a small explicit watchlist and verify the exact live Binance price response shape before widening coverage.

## Operational boundaries

- Worker failures leave the last successful cache row intact; API responses expose its age.
- A five-minute display freshness threshold is not an execution threshold. Execution must request and validate a fresh wallet-bound quote and simulate it independently.
- Do not put service-role credentials in `NEXT_PUBLIC_*` variables.
- Apply the SQL migration to the existing Supabase project before starting the worker.
- Do not deploy or enable live trading as part of this change.
