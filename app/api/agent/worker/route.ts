import { randomUUID, createHash } from "node:crypto";
import { AgentMemoryStore } from "@/services/agentMemoryStore";
import { fetchVerifiedUsMarketCalendar, UsMarketCalendarError } from "@/services/usMarketCalendar";

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
