import { randomUUID, createHash } from "node:crypto";
import { AgentMemoryStore } from "@/services/agentMemoryStore";
import { processDcaCandidate } from "@/services/dcaExecutor";
import { evaluateDueRecurringIntents } from "@/services/recurringIntentService";
import { fetchVerifiedUsMarketCalendar, UsMarketCalendarError } from "@/services/usMarketCalendar";
import {
  fetchWeekendDefiCalendarTransition,
  readMarketPulseGuard,
} from "@/services/weekendDefiRoutes";
import {
  BINANCE_DELEGATED_CUSTODY_CHAIN_ID,
  BSC_MAINNET_CHAIN_ID,
  evaluateWeekendDefiPlan,
  isMainnetAutonomousDefiBlocked,
  parseWeekendDefiConfig,
} from "@/services/weekendDefiRebalancer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const secret = process.env.WOLV_AGENT_WORKER_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || authorization !== `Bearer ${secret}`) {
    return Response.json({ error: "Worker authorization is invalid or unconfigured." }, { status: 401, headers: HEADERS });
  }
  if (process.env.WOLV_AGENT_CONTROL_PLANE_ENABLED !== "true") {
    return Response.json({ error: "The agent control plane is disabled." }, { status: 503, headers: HEADERS });
  }
  const now = Date.now();
  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    const owner = request.headers.get("x-wolv-owner");
    if (!owner || !/^0x[a-fA-F0-9]{40}$/.test(owner)) {
      return Response.json({ error: "A valid x-wolv-owner header is required." }, { status: 400, headers: HEADERS });
    }
    const due = await store.claimDueSchedules(owner, now, 20);
    const results: Array<Record<string, unknown>> = [];
    for (const schedule of due) {
      const scheduleId = String(schedule.scheduleId);
      if (schedule.strategyType === "WEEKEND_DEFI") {
        const runKey = createHash("sha256")
          .update(`${owner.toLowerCase()}:${scheduleId}:${Number(schedule.lastRunAt)}`)
          .digest("hex");
        const claimId = randomUUID();
        const claim = await store.claimExecution({
          claimId,
          scheduleId,
          ownerAddress: owner,
          runKey,
          policyHash: String(schedule.policyHash),
          createdAt: now,
        });
        if (!claim.claimId) {
          results.push({ scheduleId, status: "DUPLICATE", transactionSubmitted: false });
          continue;
        }

        try {
          const config = parseWeekendDefiConfig(schedule.strategyConfig);
          const { current, previous } = await fetchWeekendDefiCalendarTransition(now);
          const pulseGuard = await readMarketPulseGuard(config.guardTicker);
          const depositDecision = evaluateWeekendDefiPlan({
            config,
            action: "DEPOSIT",
            currentCalendar: current,
            previousCalendar: previous,
            now,
            sessionMismatch: pulseGuard.sessionMismatch,
          });
          const redeemDecision = evaluateWeekendDefiPlan({
            config,
            action: "REDEEM",
            currentCalendar: current,
            previousCalendar: previous,
            now,
            sessionMismatch: pulseGuard.sessionMismatch,
          });
          const autonomousMainnetBlocked = schedule.executionMode === "AUTONOMOUS" &&
            isMainnetAutonomousDefiBlocked({
              chainId: BSC_MAINNET_CHAIN_ID,
              delegatedPolicyChainId: BINANCE_DELEGATED_CUSTODY_CHAIN_ID,
            });
          const manualActionAvailable = depositDecision.allowed
            ? "DEPOSIT"
            : redeemDecision.allowed
              ? "REDEEM"
              : null;
          const detail = autonomousMainnetBlocked
            ? "Autonomous Weekend DeFi on BSC mainnet (chain 56) is hard-blocked; delegated custody is testnet-only (chain 97)."
            : manualActionAvailable
              ? `Verified ${manualActionAvailable.toLowerCase()} calendar conditions are present; explicit owner action is required to build unsigned transaction data.`
              : [...depositDecision.blockers, ...redeemDecision.blockers].join(" ");
          await store.updateExecutionClaim(claimId, owner, {
            status: "STOPPED",
            at: now,
            failureCode: autonomousMainnetBlocked ? "AUTONOMOUS_MAINNET_BLOCKED" : "MONITORING_ONLY",
            failureDetail: detail,
          });
          if (pulseGuard.sessionMismatch || pulseGuard.stale) {
            await store.recordAlert({
              ownerAddress: owner,
              claimId,
              severity: "WARNING",
              kind: pulseGuard.sessionMismatch
                ? "WEEKEND_DEFI_SESSION_MISMATCH"
                : "WEEKEND_DEFI_MARKET_PULSE_STALE",
              message: pulseGuard.sessionMismatch
                ? "Market-pulse session mismatch observed; no capital deployment was triggered."
                : "Market-pulse status is stale and was not used as market-closure evidence.",
              createdAt: now,
            });
          }
          await store.recordAlert({
            ownerAddress: owner,
            claimId,
            severity: autonomousMainnetBlocked ? "WARNING" : "INFO",
            kind: autonomousMainnetBlocked
              ? "WEEKEND_DEFI_AUTONOMOUS_BLOCKED"
              : "WEEKEND_DEFI_MONITORING_ONLY",
            message: detail,
            createdAt: now,
          });
          results.push({
            scheduleId,
            claimId,
            status: autonomousMainnetBlocked ? "BLOCKED" : "STOPPED",
            manualActionAvailable,
            blockers: manualActionAvailable ? [] : [...depositDecision.blockers, ...redeemDecision.blockers],
            warnings: [...depositDecision.warnings, ...redeemDecision.warnings],
            transactionSubmitted: false,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Weekend DeFi monitoring failed.";
          await store.updateExecutionClaim(claimId, owner, {
            status: "FAILED",
            at: Date.now(),
            failureCode: "WEEKEND_DEFI_MONITOR_FAILED",
            failureDetail: detail,
          });
          await store.recordAlert({
            ownerAddress: owner,
            claimId,
            severity: "WARNING",
            kind: "WEEKEND_DEFI_MONITOR_FAILED",
            message: detail,
            createdAt: Date.now(),
          });
          results.push({ scheduleId, claimId, status: "FAILED", detail, transactionSubmitted: false });
        }
        continue;
      }

      if (schedule.strategyType === "DCA") {
        let calendarError: string | null = null;
        try {
          await fetchVerifiedUsMarketCalendar(new Date(now).toISOString().slice(0, 10), now);
        } catch (error) {
          calendarError = error instanceof UsMarketCalendarError
            ? error.message
            : "Calendar verification failed.";
        }

        if (calendarError) {
          const runKey = createHash("sha256")
            .update(`${owner.toLowerCase()}:${scheduleId}:${Number(schedule.lastRunAt)}`)
            .digest("hex");
          const claimId = randomUUID();
          const claim = await store.claimExecution({
            claimId,
            scheduleId,
            ownerAddress: owner,
            runKey,
            policyHash: String(schedule.policyHash),
            createdAt: now,
          });
          if (claim.claimId) {
            await store.updateExecutionClaim(claimId, owner, {
              status: "FAILED",
              at: now,
              failureCode: "CALENDAR_REJECTED",
              failureDetail: calendarError,
            });
            await store.recordAlert({
              ownerAddress: owner,
              claimId,
              severity: "WARNING",
              kind: "DCA_CALENDAR_REJECTED",
              message: calendarError,
              createdAt: now,
            });
          }
          results.push({ scheduleId, claimId: claim.claimId, status: "FAILED", detail: calendarError, transactionSubmitted: false });
          continue;
        }

        try {
          const evaluations = await evaluateDueRecurringIntents({
            ownerAddress: owner,
            store,
            schedules: [schedule],
            now,
          });
          const evaluation = evaluations[0];
          if (!evaluation) {
            results.push({
              scheduleId,
              status: "STOPPED",
              detail: "No due DCA evaluation was produced.",
              transactionSubmitted: false,
            });
            continue;
          }
          if (evaluation.status === "REJECTED") {
            const claimId = randomUUID();
            const claim = await store.claimExecution({
              claimId,
              scheduleId,
              ownerAddress: owner,
              runKey: evaluation.runKey,
              policyHash: String(schedule.policyHash),
              createdAt: now,
            });
            if (claim.claimId) {
              await store.updateExecutionClaim(claimId, owner, {
                status: "STOPPED",
                at: now,
                failureCode: "DCA_VALIDATION_REJECTED",
                failureDetail: evaluation.reason,
              });
              await store.recordAlert({
                ownerAddress: owner,
                claimId,
                severity: "WARNING",
                kind: "DCA_VALIDATION_REJECTED",
                message: evaluation.reason,
                createdAt: now,
              });
            }
            results.push({
              scheduleId,
              claimId: claim.claimId,
              status: "STOPPED",
              detail: evaluation.reason,
              transactionSubmitted: false,
            });
            continue;
          }

          const execution = await processDcaCandidate({
            store,
            ownerAddress: owner,
            candidate: evaluation.candidate,
            now: Date.now(),
            delegatedPolicy: null,
            persistentWorkerHeartbeat: null,
          });
          results.push({
            scheduleId,
            claimId: execution.claimId,
            alertId: execution.alertId,
            status: execution.status,
            blockers: execution.blockers,
            transactionSubmitted: false,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "DCA worker processing failed.";
          console.error("DCA schedule processing failed:", detail);
          await store.recordAlert({
            ownerAddress: owner,
            severity: "WARNING",
            kind: "DCA_WORKER_FAILED",
            message: detail,
            createdAt: Date.now(),
          });
          results.push({
            scheduleId,
            status: "FAILED",
            detail,
            transactionSubmitted: false,
          });
        }
        continue;
      }

      const claimId = randomUUID();
      const runKey = createHash("sha256").update(`${scheduleId}:${Number(schedule.lastRunAt)}`).digest("hex");
      const claim = await store.claimExecution({
        claimId, scheduleId, ownerAddress: owner, runKey,
        policyHash: String(schedule.policyHash), createdAt: now,
      });
      if (!claim.claimId) continue;
      let status = "STOPPED";
      let detail = "Execution remains blocked; monitoring-only cycle completed.";
      try {
        const date = new Date(now).toISOString().slice(0, 10);
        await fetchVerifiedUsMarketCalendar(date, now);
      } catch (error) {
        status = "FAILED";
        detail = error instanceof UsMarketCalendarError ? error.message : "Calendar verification failed.";
      }
      await store.updateExecutionClaim(claimId, owner, {
        status: status === "FAILED" ? "FAILED" : "STOPPED",
        at: now,
        failureCode: status === "FAILED" ? "CALENDAR_REJECTED" : "MONITORING_ONLY",
        failureDetail: detail,
      });
      await store.recordAlert({ ownerAddress: owner, claimId, severity: status === "FAILED" ? "WARNING" : "INFO", kind: "MONITOR_CYCLE", message: detail, createdAt: now });
      results.push({ scheduleId, claimId, status, detail, transactionSubmitted: false });
    }
    return Response.json({ processed: results.length, results, execution: "BLOCKED" }, { headers: HEADERS });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Worker execution failed." }, { status: 503, headers: HEADERS });
  } finally { await store.close(); }
}
