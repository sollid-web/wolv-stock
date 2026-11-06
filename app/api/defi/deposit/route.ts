import {
  BinanceApiError,
  buildDeFiDepositTransaction,
} from "@/lib/binance";
import { AgentMemoryStore } from "@/services/agentMemoryStore";
import {
  authorizeWeekendDefiRequest,
  fetchWeekendDefiCalendarTransition,
  isRecord,
  jsonError,
  loadWeekendDefiSchedule,
  readMarketPulseGuard,
  readWeekendDefiRequestBody,
  validateWeekendDefiRequest,
} from "@/services/weekendDefiRoutes";
import { evaluateWeekendDefiPlan } from "@/services/weekendDefiRebalancer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeWeekendDefiRequest(request);
  if (authorization.error) return authorization.error;
  const { session } = authorization;
  if (!session) return jsonError("A connected wallet session is required.", 401);

  const parsed = await readWeekendDefiRequestBody(request);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const allowedKeys = ["scheduleId", "walletAddress", "investmentId", "amount"];
  if (Object.keys(body).length !== allowedKeys.length ||
    allowedKeys.some((key) => !Object.hasOwn(body, key))) {
    return jsonError("Deposit request parameters are invalid.", 422);
  }

  let store: AgentMemoryStore | undefined;
  try {
    store = new AgentMemoryStore();
    await store.initialize();
    const schedule = await loadWeekendDefiSchedule({
      store,
      ownerAddress: session.address,
      scheduleId: body.scheduleId,
    });
    if (!schedule) return jsonError("An owner-scoped Weekend DeFi strategy was not found.", 404);
    const validated = validateWeekendDefiRequest({
      walletAddress: body.walletAddress,
      sessionAddress: session.address,
      schedule,
      investmentId: body.investmentId,
      amount: body.amount,
      action: "DEPOSIT",
    });
    if (validated instanceof Response) return validated;

    const now = Date.now();
    const { current, previous } = await fetchWeekendDefiCalendarTransition(now);
    const pulseGuard = await readMarketPulseGuard(schedule.strategyConfig.guardTicker);
    const decision = evaluateWeekendDefiPlan({
      config: schedule.strategyConfig,
      action: "DEPOSIT",
      currentCalendar: current,
      previousCalendar: previous,
      now,
      sessionMismatch: pulseGuard.sessionMismatch,
    });
    if (pulseGuard.stale) {
      decision.warnings.push("The configured market-pulse row is stale; its status was not used as market-closure evidence.");
    }
    if (pulseGuard.sessionMismatch) {
      await store.recordAlert({
        ownerAddress: session.address,
        severity: "WARNING",
        kind: "WEEKEND_DEFI_SESSION_MISMATCH",
        message: "Market-pulse session mismatch observed; no capital deployment was triggered.",
        createdAt: now,
      });
    }
    if (!decision.allowed) {
      return Response.json({ decision }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }

    const transaction = await buildDeFiDepositTransaction(
      schedule.strategyConfig.protocolId,
      validated.investmentId,
      validated.amount,
      session.address,
    );
    if (!isRecord(transaction) || !Array.isArray(transaction.dataList) ||
      !isRecord(transaction.preview) || transaction.preview.success !== true ||
      transaction.dataList.length === 0) {
      throw new Error("The simulated Binance DeFi deposit response failed local validation.");
    }
    if (transaction.preview.warnings.some((warning) =>
      ["CRITICAL", "BLOCKER"].includes(warning.level.toUpperCase()))) {
      return jsonError("The simulated deposit has a blocking provider warning; no transaction data was returned.", 422, {
        warnings: transaction.preview.warnings,
      });
    }
    return Response.json({
      execution: "MANUAL_UNSIGNED",
      simulated: true,
      transactionSubmitted: false,
      chainId: 56,
      decision,
      transaction: {
        dataList: transaction.dataList,
        preview: transaction.preview,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BinanceApiError) {
      console.error("Weekend DeFi deposit build failed:", error.message);
      return jsonError("The simulated Binance DeFi deposit could not be built.", 502);
    }
    if (error instanceof TypeError) return jsonError(error.message, 422);
    console.error("Weekend DeFi deposit request failed:", error);
    return jsonError("Weekend DeFi deposit building is temporarily unavailable.", 503);
  } finally {
    if (store) await store.close();
  }
}
