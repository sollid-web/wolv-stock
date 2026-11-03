import { evaluateDynamicStrategy, type DynamicMarketMetrics } from "@/lib/dynamicStrategy";
import { authorizeBawWalletRequest, getBawWalletSession } from "@/services/bawWalletAuth";
import { AgentMemoryStore } from "@/services/agentMemoryStore";
import { collectLiveDynamicMetrics, DynamicStrategyProviderError } from "@/services/dynamicStrategyProvider";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(request: Request) {
  const token = process.env.BAW_WALLET_API_TOKEN;
  const authorization = await authorizeBawWalletRequest(request, token);
  if (authorization !== "authorized") {
    return Response.json(
      { error: "A valid operator authorization is required." },
      { status: authorization === "not_configured" ? 503 : 401 },
    );
  }
  const session = await getBawWalletSession(request, token);
  if (!session) {
    return Response.json(
      { error: "Dynamic strategy history requires an authenticated BAW wallet session." },
      { status: 401, headers },
    );
  }
  const databaseUrl = process.env.WOLV_AGENT_DATABASE_URL ?? process.env.WOLV_TRADING_DATABASE_URL;
  if (!databaseUrl) {
    return Response.json(
      { error: "Dynamic strategy history is not configured.", code: "NOT_CONFIGURED" },
      { status: 503, headers },
    );
  }
  const store = new AgentMemoryStore(databaseUrl);
  try {
    await store.initialize();
    const cycles = await store.listDynamicStrategyCycles(session.address, 50, 56);
    const runs = await store.listDynamicStrategyRuns(session.address, 56, 50);
    return Response.json({ cycles, runs, count: cycles.length, transactionSubmitted: false }, { headers });
  } catch {
    return Response.json(
      { error: "Dynamic strategy history could not be loaded.", code: "STORAGE_UNAVAILABLE" },
      { status: 503, headers },
    );
  } finally {
    await store.close();
  }
}

export async function POST(request: Request) {
  const token = process.env.BAW_WALLET_API_TOKEN;
  const authorization = await authorizeBawWalletRequest(
    request,
    token,
  );
  if (authorization !== "authorized") {
    return Response.json(
      { error: "A valid operator authorization is required." },
      { status: authorization === "not_configured" ? 503 : 401 },
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 4096)) {
    return Response.json({ error: "Request body exceeds the 4 KB limit." }, { status: 413, headers });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400, headers });
  }
  if (!isRecord(body)) {
    return Response.json({ error: "Request body must be a JSON object." }, { status: 422, headers });
  }

  const evaluatedAt = Date.now();
  let metrics: DynamicMarketMetrics;
  let provenance: Record<string, unknown>;

  if (Object.keys(body).length === 1 && body.source === "live") {
    let ownerAddress: string | null = null;
    try {
      const session = await getBawWalletSession(request, token);
      ownerAddress = session?.address ?? null;
    } catch {
      ownerAddress = null;
    }
    if (!ownerAddress) {
      return Response.json(
        { error: "Live dynamic strategy evaluation requires an authenticated BAW wallet session." },
        { status: 401, headers },
      );
    }

    const databaseUrl = process.env.WOLV_AGENT_DATABASE_URL ?? process.env.WOLV_TRADING_DATABASE_URL;
    let baseline: number | null = null;
    let baselineSource = "explicit_environment_baseline";
    let store: AgentMemoryStore | null = null;
    let runId: string | null = null;
    try {
      if (!databaseUrl) {
        return Response.json(
          { error: "Live dynamic strategy persistence is not configured.", code: "NOT_CONFIGURED" },
          { status: 503, headers },
        );
      }
      store = new AgentMemoryStore(databaseUrl);
      await store.initialize();
      await store.recoverStaleDynamicStrategyRuns(ownerAddress, 56, evaluatedAt - 5 * 60_000, evaluatedAt);
      const runKey = createHash("sha256").update(`${ownerAddress.toLowerCase()}:56:${Math.floor(evaluatedAt / 60_000)}`).digest("hex");
      const claimed = await store.claimDynamicStrategyRun(ownerAddress, 56, runKey, evaluatedAt);
      runId = claimed.runId;
      if (!runId) {
        return Response.json(
          { error: "A live dynamic strategy run for this wallet is already in progress or completed for this minute.", code: "DUPLICATE_RUN" },
          { status: 409, headers },
        );
      }
        const recent = await store.listDynamicStrategyCycles(ownerAddress, 1, 56);
        const recentMetrics = recent[0]?.metrics;
        if (isRecord(recentMetrics) && typeof recentMetrics.pancakeLiquidityUsd === "number") {
          baseline = recentMetrics.pancakeLiquidityUsd;
          baselineSource = "previous_verified_dynamic_cycle";
        }
      if (baseline === null) {
        const configuredBaseline = process.env.WOLV_DYNAMIC_LIQUIDITY_BASELINE_USD;
        const parsed = configuredBaseline ? Number(configuredBaseline) : Number.NaN;
        baseline = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }
      if (baseline === null) {
        await store.completeDynamicStrategyRun(runId, ownerAddress, "FAILED", Date.now(), "Verified liquidity baseline unavailable.");
        return Response.json(
          { error: "Live evaluation is blocked: a verified liquidity baseline is unavailable.", code: "BASELINE_UNAVAILABLE" },
          { status: 503, headers },
        );
      }
      const live = await collectLiveDynamicMetrics({ baselineLiquidityUsd: baseline });
      metrics = live.metrics;
      provenance = {
        ...live.provenance,
        baselineSource,
      };
      await persistCycle(store, ownerAddress, evaluatedAt, metrics, provenance);
      await store.completeDynamicStrategyRun(runId, ownerAddress, "COMPLETED", Date.now());
    } catch (error) {
      if (store && runId) {
        await store.completeDynamicStrategyRun(
          runId,
          ownerAddress,
          "FAILED",
          Date.now(),
          error instanceof Error ? error.message : "Live dynamic strategy run failed.",
        );
      }
      if (error instanceof DynamicStrategyProviderError) {
        return Response.json(
          { error: error.message, code: error.code },
          { status: error.code === "PROVIDER_DISABLED" ? 503 : 502, headers },
        );
      }
      return Response.json(
        { error: "Live dynamic strategy providers failed.", code: "PROVIDER_UNAVAILABLE" },
        { status: 502, headers },
      );
    } finally {
      await store?.close();
    }
  } else {
    if (Object.keys(body).length !== 1 || !isRecord(body.metrics)) {
      return Response.json({ error: "Request must contain only a metrics object or { \"source\":\"live\" }." }, { status: 422, headers });
    }
    metrics = body.metrics as DynamicMarketMetrics;
    const metricRecord = metrics as unknown as Record<string, unknown>;
    if (Object.keys(metrics).length !== 5 ||
      !["observedAt", "pancakeLiquidityUsd", "baselineLiquidityUsd", "gasPriceGwei", "atrBps"].every(
        (key) => typeof metricRecord[key] === "number",
      )) {
      return Response.json({ error: "Dynamic metrics contain missing, extra, or non-numeric fields." }, { status: 422, headers });
    }
    provenance = { source: "operator_supplied_mock_or_replay", verified: false };
  }

  const decision = evaluateDynamicStrategy(metrics, evaluatedAt);
  return Response.json({
    request: { metrics },
    decision,
    provenance,
    receipt: {
      evaluatedAt,
      transactionSubmitted: false,
      signingRequested: false,
      modeSwitchSubmitted: false,
    },
  }, { headers });
}

async function persistCycle(
  store: AgentMemoryStore,
  ownerAddress: string,
  evaluatedAt: number,
  metrics: DynamicMarketMetrics,
  provenance: Record<string, unknown>,
): Promise<void> {
  const decision = evaluateDynamicStrategy(metrics, evaluatedAt);
  await store.recordDynamicStrategyCycle({
    ownerAddress,
    chainId: 56,
    observedAt: metrics.observedAt,
    metrics: metrics as unknown as Record<string, unknown>,
    provenance,
    mode: decision.mode,
    marketSession: decision.marketSession,
    action: decision.action,
    accepted: decision.accepted,
    reasons: decision.reasons,
    warnings: decision.warnings,
    liquidityChangePercent: decision.liquidityChangePercent,
    evaluatedAt,
  });
}
