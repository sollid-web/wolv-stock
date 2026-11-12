import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { getAddress, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashAgentPolicy } from "@/lib/agentPolicyHash";
import { createAgentPublicClient, getAgentSmartAccountConfig } from "@/lib/smartAccount";
import { createViemValidatorReader } from "@/services/agentWorker";
import { resolveAgentExecutionNetwork } from "@/services/agentExecutor";
import { authorizeBawWalletRequest, getBawWalletSession } from "@/services/bawWalletAuth";
import { AgentMemoryStore } from "@/services/agentMemoryStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store" };

function getWorkerReadiness() {
  const missing = [
    !/^0x[0-9a-f]{64}$/i.test(process.env.AGENT_PRIVATE_KEY ?? "") ? "AGENT_PRIVATE_KEY" : null,
    !process.env.AGENT_MARKET_DATA_MODULE ? "AGENT_MARKET_DATA_MODULE" : null,
    !process.env.AGENT_OWNER_VALIDATOR_MODULE ? "AGENT_OWNER_VALIDATOR_MODULE" : null,
    !process.env.REDIS_URL ? "REDIS_URL" : null,
  ].filter((value): value is string => Boolean(value));
  try {
    const network = resolveAgentExecutionNetwork(getAgentSmartAccountConfig().chain.id);
    return {
      workerReady: missing.length === 0,
      workerConfigIssues: missing,
      executionGateEnabled: network.allowed,
      executionGateReason: network.allowed ? null : network.reason,
    };
  } catch (error) {
    return {
      workerReady: false,
      workerConfigIssues: [...missing, error instanceof Error ? error.message : "Smart-account worker configuration is incomplete."],
      executionGateEnabled: false,
      executionGateReason: "Smart-account execution configuration is incomplete.",
    };
  }
}

export async function GET(request: Request) {
  const token = process.env.BAW_WALLET_API_TOKEN;
  const auth = await authorizeBawWalletRequest(request, token);
  if (auth !== "authorized") return authError(auth);
  const session = await getBawWalletSession(request, token);
  if (!session) return Response.json({ error: "A connected wallet session is required." }, { status: 401, headers: HEADERS });
  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    return Response.json({ schedules: await store.listSchedules(session.address) }, { headers: HEADERS });
  } catch {
    return Response.json({ error: "Schedule storage is unavailable." }, { status: 503, headers: HEADERS });
  } finally { await store.close(); }
}

export async function POST(request: Request) {
  const token = process.env.BAW_WALLET_API_TOKEN;
  const auth = await authorizeBawWalletRequest(request, token);
  if (auth !== "authorized") return authError(auth);
  const session = await getBawWalletSession(request, token);
  if (!session) return Response.json({ error: "A connected wallet session is required." }, { status: 401, headers: HEADERS });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON." }, { status: 400, headers: HEADERS }); }
  if (!isRecord(body)) return Response.json({ error: "Schedule request must be an object." }, { status: 422, headers: HEADERS });
  const value = body as Record<string, unknown>;
  const requiredKeys = ["name", "intervalSeconds", "policyVersion", "policy"];
  const allowedKeys = new Set([...requiredKeys, "strategyType", "executionMode", "strategyConfig"]);
  if (!requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    typeof value.name !== "string" ||
    typeof value.intervalSeconds !== "number" || typeof value.policyVersion !== "string" ||
    typeof value.policy !== "object" || value.policy === null || Array.isArray(value.policy)) {
    return Response.json({ error: "Schedule request is invalid." }, { status: 422, headers: HEADERS });
  }
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(value.name) || !Number.isSafeInteger(value.intervalSeconds) ||
    value.intervalSeconds < 60 || value.intervalSeconds > 86400) {
    return Response.json({ error: "Schedule name or interval is invalid." }, { status: 422, headers: HEADERS });
  }
  const strategyType = value.strategyType === undefined ? "MONITORING" : value.strategyType;
  const executionMode = value.executionMode === undefined ? "MANUAL" : value.executionMode;
  const strategyConfig = value.strategyConfig === undefined ? {} : value.strategyConfig;
  if (typeof strategyType !== "string" || !/^[A-Z][A-Z0-9_]{0,49}$/.test(strategyType) ||
    (executionMode !== "MANUAL" && executionMode !== "AUTONOMOUS") ||
    !isRecord(strategyConfig) || new TextEncoder().encode(JSON.stringify(strategyConfig)).byteLength > 16_384) {
    return Response.json({ error: "Strategy configuration is invalid or exceeds the 16 KB limit." }, { status: 422, headers: HEADERS });
  }
  const now = Date.now();
  let policyHash: string;
  let normalizedStrategyConfig: Record<string, unknown> = strategyConfig;
  if (strategyType === "BSC_AGENT_TRADE") {
    if (executionMode !== "AUTONOMOUS" || value.policyVersion !== "WOLV_AGENT_POLICY_V4" ||
      value.name !== strategyConfig.id ||
      typeof strategyConfig.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(strategyConfig.id) ||
      typeof strategyConfig.ownerAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(strategyConfig.ownerAddress) ||
      typeof strategyConfig.account !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(strategyConfig.account) ||
      typeof strategyConfig.targetToken !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(strategyConfig.targetToken) ||
      typeof strategyConfig.amountBnb !== "string" || typeof strategyConfig.entryPriceMicros !== "string" ||
      !/^[0-9]+$/.test(strategyConfig.entryPriceMicros) ||
      typeof strategyConfig.slippageBps !== "number" || typeof strategyConfig.maxPriceImpactBps !== "number" ||
      !isRecord(value.policy) || typeof value.policy.maxTradeValueWei !== "string" ||
      !/^[0-9]+$/.test(value.policy.maxTradeValueWei) || typeof value.policy.expiresAt !== "string" ||
      !/^[0-9]+$/.test(value.policy.expiresAt) || typeof value.policy.intentSigner !== "string" ||
      typeof value.policy.targetToken !== "string") {
      return Response.json({ error: "Autonomous BSC strategy configuration is incomplete or invalid." }, { status: 422, headers: HEADERS });
    }
    try {
      const config = getAgentSmartAccountConfig();
      const account = getAddress(strategyConfig.account);
      const targetToken = getAddress(strategyConfig.targetToken);
      const policyTargetToken = getAddress(value.policy.targetToken);
      const intentSigner = getAddress(value.policy.intentSigner);
      const amountBnb = parseEther(strategyConfig.amountBnb);
      const entryPriceMicros = BigInt(strategyConfig.entryPriceMicros);
      const maxTradeValue = BigInt(value.policy.maxTradeValueWei);
      const expiresAt = BigInt(value.policy.expiresAt);
      const expectedPolicyHash = hashAgentPolicy({
        strategyId: strategyConfig.id,
        ownerAddress,
        account,
        targetToken,
        maxTradeValue,
        expiresAt,
        intentSigner,
        amountBnb,
        entryPriceMicros,
        slippageBps: strategyConfig.slippageBps,
        maxPriceImpactBps: strategyConfig.maxPriceImpactBps,
      });
      if (config.chain.id !== 56 && config.chain.id !== 97) throw new Error("Only BSC mainnet and testnet are supported.");
      if (targetToken !== config.targetTokenAddress || policyTargetToken !== targetToken) {
        throw new Error("Strategy token does not match the configured BSC agent token.");
      }
      const privateKey = process.env.AGENT_PRIVATE_KEY;
      if (!privateKey || !/^0x[0-9a-f]{64}$/i.test(privateKey)) {
        throw new Error("The autonomous delegated signer is not configured on the worker host.");
      }
      const configuredSigner = getAddress(privateKeyToAccount(privateKey as Hex).address);
      if (configuredSigner !== intentSigner) throw new Error("On-chain policy signer does not match the worker's delegated signer.");
      const strategy = {
        id: strategyConfig.id,
        ownerAddress,
        account,
        targetToken,
        amountBnb,
        entryPriceMicros,
        slippageBps: strategyConfig.slippageBps,
        maxPriceImpactBps: strategyConfig.maxPriceImpactBps,
      };
      const validator = await createViemValidatorReader(
        createAgentPublicClient(config),
        config.policyHookAddress,
      )(strategy);
      if (!validator.installed || validator.revoked || validator.paused || !validator.policyConfigured) {
        throw new Error("The smart account must have an installed, active, unpaused on-chain policy.");
      }
      if (validator.policyExpiresAt * BigInt(1000) <= BigInt(now) ||
        validator.maxTradeValue !== maxTradeValue || validator.policyExpiresAt !== expiresAt ||
        getAddress(validator.intentSigner) !== intentSigner ||
        validator.policyHash.toLowerCase() !== expectedPolicyHash.toLowerCase()) {
        throw new Error("Stored strategy does not exactly match the active on-chain policy.");
      }
      policyHash = expectedPolicyHash.slice(2).toLowerCase();
      normalizedStrategyConfig = {
        id: strategy.id,
        ownerAddress: strategy.ownerAddress,
        account: strategy.account,
        targetToken: strategy.targetToken,
        amountBnb: strategyConfig.amountBnb,
        entryPriceMicros: strategy.entryPriceMicros.toString(),
        slippageBps: strategy.slippageBps,
        maxPriceImpactBps: strategy.maxPriceImpactBps,
      };
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "On-chain strategy policy verification failed." }, { status: 409, headers: HEADERS });
    }
  } else {
    policyHash = createHash("sha256").update(JSON.stringify({
      policy: value.policy,
      strategyType,
      executionMode,
      strategyConfig,
    })).digest("hex");
  }

  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    if (strategyType === "BSC_AGENT_TRADE" && isRecord(normalizedStrategyConfig)) {
      const existingSchedules = await store.listSchedules(session.address, 100);
      for (const existing of existingSchedules) {
        if (existing.enabled === true && existing.strategyType === "BSC_AGENT_TRADE" &&
          isRecord(existing.strategyConfig) &&
          typeof existing.strategyConfig.account === "string" &&
          existing.strategyConfig.account.toLowerCase() === String(normalizedStrategyConfig.account).toLowerCase() &&
          existing.name !== value.name) {
          await store.setScheduleEnabled(session.address, String(existing.scheduleId), false, now);
        }
      }
    }
    const result = await store.saveSchedule({
      ownerAddress: session.address,
      scheduleId: randomUUID(),
      name: value.name,
      intervalSeconds: value.intervalSeconds,
      policyVersion: value.policyVersion.slice(0, 64),
      policyHash,
      nextRunAt: now + Number(value.intervalSeconds) * 1000,
      strategyType,
      executionMode,
      strategyConfig: normalizedStrategyConfig,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    return Response.json({
      scheduleId: result.scheduleId,
      strategyType,
      executionMode,
      execution: strategyType === "BSC_AGENT_TRADE" ? "AUTONOMOUS_SCHEDULED" : "BLOCKED",
      policyHash,
      ...getWorkerReadiness(),
    }, { status: 201, headers: HEADERS });
  } catch {
    return Response.json({ error: "Schedule could not be persisted." }, { status: 503, headers: HEADERS });
  } finally { await store.close(); }
}

export async function PATCH(request: Request) {
  const token = process.env.BAW_WALLET_API_TOKEN;
  const auth = await authorizeBawWalletRequest(request, token);
  if (auth !== "authorized") return authError(auth);
  const session = await getBawWalletSession(request, token);
  if (!session) return Response.json({ error: "A connected wallet session is required." }, { status: 401, headers: HEADERS });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Request body must be valid JSON." }, { status: 400, headers: HEADERS }); }
  if (!isRecord(body) || Object.keys(body).length !== 2 ||
    typeof body.scheduleId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.scheduleId) ||
    typeof body.enabled !== "boolean") {
    return Response.json({ error: "Schedule update is invalid." }, { status: 422, headers: HEADERS });
  }
  const store = new AgentMemoryStore();
  try {
    await store.initialize();
    await store.setScheduleEnabled(session.address, body.scheduleId, body.enabled, Date.now());
    return Response.json({ scheduleId: body.scheduleId, enabled: body.enabled }, { headers: HEADERS });
  } catch {
    return Response.json({ error: "Schedule could not be updated." }, { status: 503, headers: HEADERS });
  } finally { await store.close(); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authError(status: string) {
  if (status === "not_configured") return Response.json({ error: "Operator wallet access is not configured." }, { status: 503, headers: HEADERS });
  return Response.json({ error: "A valid operator authorization is required." }, { status: 401, headers: HEADERS });
}
