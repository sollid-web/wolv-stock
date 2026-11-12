import { createBscRpcClient } from "../services/autonomy/bsc-rpc.ts";
import { binanceRfqExecutionProvider } from "../services/autonomy/binance-rfq-execution-provider.ts";
import {
  listRecoverableLiveExecutionAttempts,
  listSettledLiveExecutionAttempts,
  transitionLiveExecutionAttempt,
  commitLiveExecutionFill,
  releaseLiveExecutionBudget,
} from "../services/autonomy/supabase-live-execution-repository.ts";
import { createLiveRfqSettlementAdapter } from "../services/autonomy/live-rfq-settlement-adapter.ts";
import { loadLiveExecutionPolicy } from "../services/autonomy/supabase-live-portfolio-policy.ts";
import { createLiveExecutionRecovery } from "../services/autonomy/live-execution-recovery.ts";
import type { LiveExecutionEvidence } from "../services/autonomy/live-execution-domain.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required for live execution recovery");
  return value;
}

const ownerId = required("WOLV_AUTONOMY_OWNER_ID");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
  throw new Error("WOLV_AUTONOMY_OWNER_ID must be a UUID");
}

const intervalMs = Math.max(5_000, Math.min(60_000, Number(process.env.WOLV_LIVE_RECOVERY_POLL_MS ?? 10_000)));
const limit = Math.max(1, Math.min(200, Math.floor(Number(process.env.WOLV_LIVE_RECOVERY_BATCH_SIZE ?? 50))));

const rpc = createBscRpcClient({});
const settlement = createLiveRfqSettlementAdapter({
  client: rpc,
  requiredConfirmations: Number(process.env.WOLV_LIVE_SETTLEMENT_CONFIRMATIONS ?? 12),
});

const recovery = createLiveExecutionRecovery({
  repository: {
    listRecoverable: listRecoverableLiveExecutionAttempts,
    listSettled: listSettledLiveExecutionAttempts,
    transition(input) {
      return transitionLiveExecutionAttempt({
        ...input,
        evidence: input.evidence as LiveExecutionEvidence | undefined,
      });
    },
    commitFill: commitLiveExecutionFill,
    releaseBudget: releaseLiveExecutionBudget,
  },
  provider: binanceRfqExecutionProvider,
  settlement,
  async isNewEntryAllowed(owner) {
    try {
      const policy = await loadLiveExecutionPolicy(owner);
      return !!policy && policy.enabled && !policy.emergencyStop && !policy.globalKillSwitch;
    } catch {
      return false;
    }
  },
});

async function main() {
  console.info("[live-recovery-worker] started; mode=RECONCILIATION_ONLY; owner=" + ownerId);
  for (;;) {
    const started = Date.now();
    try {
      const report = await recovery.run(ownerId, limit);
      if (report.scanned || report.errors) {
        console.info("[live-recovery-worker] cycle " + JSON.stringify(report));
      }
    } catch (error) {
      console.error("[live-recovery-worker] cycle failed: " +
        (error instanceof Error ? error.message : "unknown error"));
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, intervalMs - (Date.now() - started))));
  }
}

main().catch((error) => {
  console.error("[live-recovery-worker] fatal: " + (error instanceof Error ? error.message : "unknown error"));
  process.exitCode = 1;
});
