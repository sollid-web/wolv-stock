-- Harden the additive WOLV autonomy schema without changing existing application tables.
-- Public market data remains read-only; execution and portfolio data stays service-role only.

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname LIKE 'wolv_%'
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = pg_catalog, public',
      fn.signature
    );
  END LOOP;
END;
$$;

-- Trigger functions do not need to be directly executable through the Data API.
ALTER FUNCTION public.wolv_keep_newest_market_price()
  SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.wolv_keep_newest_market_price()
  FROM PUBLIC, anon, authenticated;

-- Keep the three intentionally public market-data tables read-only.
REVOKE ALL PRIVILEGES ON TABLE
  public.wolv_market_prices_latest,
  public.wolv_market_price_history,
  public.wolv_market_opportunities
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.wolv_market_prices_latest,
  public.wolv_market_price_history,
  public.wolv_market_opportunities
TO anon, authenticated;
