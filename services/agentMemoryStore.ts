import "server-only";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import {
  assertAgentTransition,
  createSnapshotHash,
  type AgentDirection,
  type AgentRunInput,
  type AgentState,
  type AssetVersionInput,
  type MarketObservationInput,
  type PolicyDecision,
  type RiskPolicy,
  type TradeProposalInput,
  validateRiskPolicy,
} from "../lib/agentControlPlane.ts";

const MIGRATIONS = [{
  version: 1,
  statements: [
    `CREATE TABLE wolv_agent_asset_history (
      asset_id uuid PRIMARY KEY,
      chain_id integer NOT NULL CHECK (chain_id > 0),
      token_address text NOT NULL,
      ticker text NOT NULL,
      platform text NOT NULL,
      decimals integer CHECK (decimals BETWEEN 0 AND 255),
      share_denomination jsonb,
      metadata_source text NOT NULL,
      observed_at timestamptz NOT NULL,
      block_number numeric,
      block_hash text,
      metadata jsonb NOT NULL,
      metadata_hash char(64) NOT NULL,
      UNIQUE (chain_id, token_address, metadata_hash)
    )`,
    `CREATE INDEX wolv_agent_asset_lookup
      ON wolv_agent_asset_history (chain_id, lower(token_address), observed_at DESC)`,
    `CREATE TABLE wolv_agent_market_observations (
      observation_id uuid PRIMARY KEY,
      asset_id uuid NOT NULL REFERENCES wolv_agent_asset_history(asset_id),
      price numeric NOT NULL CHECK (price > 0),
      reference_price numeric CHECK (reference_price IS NULL OR reference_price > 0),
      bid numeric CHECK (bid IS NULL OR bid > 0),
      ask numeric CHECK (ask IS NULL OR ask > 0),
      spread_percent numeric,
      currency text NOT NULL,
      price_kind text NOT NULL CHECK (price_kind IN ('INDICATIVE','EXECUTABLE')),
      source text NOT NULL,
      provider_timestamp timestamptz NOT NULL,
      ingested_at timestamptz NOT NULL,
      freshness_ms integer NOT NULL CHECK (freshness_ms > 0),
      verification_status text NOT NULL CHECK (verification_status IN ('VERIFIED','UNVERIFIED','REJECTED')),
      provenance jsonb NOT NULL,
      idempotency_key char(64) NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX wolv_agent_observations_asset_time
      ON wolv_agent_market_observations (asset_id, provider_timestamp DESC, observation_id)`,
    `CREATE INDEX wolv_agent_observations_source_time
      ON wolv_agent_market_observations (source, provider_timestamp DESC)`,
    `CREATE TABLE wolv_agent_market_candles (
      candle_id uuid PRIMARY KEY,
      asset_id uuid NOT NULL REFERENCES wolv_agent_asset_history(asset_id),
      interval text NOT NULL,
      open_price numeric NOT NULL CHECK (open_price > 0),
      high_price numeric NOT NULL CHECK (high_price > 0),
      low_price numeric NOT NULL CHECK (low_price > 0),
      close_price numeric NOT NULL CHECK (close_price > 0),
      volume numeric CHECK (volume IS NULL OR volume >= 0),
      opening_at timestamptz NOT NULL,
      closing_at timestamptz NOT NULL,
      provider text NOT NULL,
      verification_status text NOT NULL CHECK (verification_status IN ('VERIFIED','UNVERIFIED','REJECTED')),
      provenance jsonb NOT NULL,
      CHECK (low_price <= open_price AND low_price <= close_price),
      CHECK (high_price >= open_price AND high_price >= close_price),
      CHECK (closing_at > opening_at),
      UNIQUE (asset_id, interval, opening_at, provider)
    )`,
    `CREATE INDEX wolv_agent_candles_asset_interval_time
      ON wolv_agent_market_candles (asset_id, interval, opening_at DESC)`,
    `CREATE TABLE wolv_agent_runs (
      run_id uuid PRIMARY KEY,
      agent_id text NOT NULL,
      strategy_id text NOT NULL,
      strategy_version text NOT NULL,
      trigger_type text NOT NULL,
      started_at timestamptz NOT NULL,
      ended_at timestamptz,
      run_status text NOT NULL CHECK (run_status IN (
        'IDLE','INITIALIZING','MONITORING','OBSERVATION_RECORDED','OPPORTUNITY_DETECTED',
        'ANALYZING','ANALYSIS_COMPLETED','POLICY_VALIDATION','POLICY_APPROVED',
        'POLICY_REJECTED','PROPOSAL_CREATED','AWAITING_USER_APPROVAL','USER_APPROVED',
        'USER_REJECTED','EXPIRED','EXECUTION_BLOCKED','COMPLETED','FAILED','STOPPED'
      )),
      configuration jsonb NOT NULL,
      termination_reason text
    )`,
    `CREATE INDEX wolv_agent_runs_status_started
      ON wolv_agent_runs (run_status, started_at DESC)`,
    `CREATE UNIQUE INDEX wolv_agent_run_single_flight
      ON wolv_agent_runs (agent_id)
      WHERE run_status IN (
        'INITIALIZING','MONITORING','OBSERVATION_RECORDED','OPPORTUNITY_DETECTED',
        'ANALYZING','ANALYSIS_COMPLETED','POLICY_VALIDATION','POLICY_APPROVED',
        'PROPOSAL_CREATED','AWAITING_USER_APPROVAL','USER_APPROVED'
      )`,
    `CREATE TABLE wolv_agent_events (
      event_id uuid PRIMARY KEY,
      run_id uuid REFERENCES wolv_agent_runs(run_id),
      event_type text NOT NULL,
      occurred_at timestamptz NOT NULL,
      sequence_number bigint NOT NULL,
      correlation_id text NOT NULL,
      event_payload jsonb NOT NULL,
      source_provenance jsonb NOT NULL,
      previous_event_id uuid REFERENCES wolv_agent_events(event_id),
      UNIQUE (run_id, sequence_number)
    )`,
    `CREATE INDEX wolv_agent_events_run_sequence
      ON wolv_agent_events (run_id, sequence_number)`,
    `CREATE OR REPLACE FUNCTION wolv_agent_events_are_append_only()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wolv_agent_events is append-only';
      END;
      $$`,
    `CREATE TRIGGER wolv_agent_events_no_update
      BEFORE UPDATE OR DELETE ON wolv_agent_events
      FOR EACH ROW EXECUTE FUNCTION wolv_agent_events_are_append_only()`,
    `CREATE TABLE wolv_agent_opportunities (
      opportunity_id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES wolv_agent_runs(run_id),
      asset_id uuid NOT NULL REFERENCES wolv_agent_asset_history(asset_id),
      direction text NOT NULL CHECK (direction IN ('BUY','SELL')),
      strategy_id text NOT NULL,
      strategy_version text NOT NULL,
      detected_at timestamptz NOT NULL,
      evidence jsonb NOT NULL,
      reference_prices jsonb NOT NULL,
      spread_percent numeric NOT NULL,
      historical_context jsonb NOT NULL,
      analysis_id uuid,
      opportunity_status text NOT NULL CHECK (opportunity_status IN ('DETECTED','EXPIRED','OUTCOME_RECORDED','REJECTED')),
      expires_at timestamptz NOT NULL,
      outcome jsonb,
      detection_key char(64) NOT NULL UNIQUE
    )`,
    `CREATE INDEX wolv_agent_opportunities_asset_detected
      ON wolv_agent_opportunities (asset_id, detected_at DESC)`,
    `CREATE INDEX wolv_agent_opportunities_status_expiry
      ON wolv_agent_opportunities (opportunity_status, expires_at)`,
    `CREATE TABLE wolv_agent_analyses (
      analysis_id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES wolv_agent_runs(run_id),
      opportunity_id uuid NOT NULL REFERENCES wolv_agent_opportunities(opportunity_id),
      evidence_references jsonb NOT NULL,
      model_identifier text NOT NULL,
      model_version text,
      analyzed_at timestamptz NOT NULL,
      reasoning_summary text NOT NULL,
      recommendation text NOT NULL,
      risks jsonb NOT NULL,
      invalidating_conditions jsonb NOT NULL,
      structured_result jsonb NOT NULL,
      CHECK (length(reasoning_summary) <= 4000)
    )`,
    `CREATE INDEX wolv_agent_analyses_opportunity_time
      ON wolv_agent_analyses (opportunity_id, analyzed_at DESC)`,
    `CREATE TABLE wolv_strategy_evaluations (
      evaluation_id uuid PRIMARY KEY,
      strategy_id text NOT NULL,
      strategy_version text NOT NULL,
      window_start timestamptz NOT NULL,
      window_end timestamptz NOT NULL,
      opportunities_evaluated integer NOT NULL CHECK (opportunities_evaluated >= 0),
      expected_outcome jsonb NOT NULL,
      observed_outcome jsonb NOT NULL,
      evaluated_at timestamptz NOT NULL,
      performance_metrics jsonb NOT NULL,
      methodology text NOT NULL,
      CHECK (window_end > window_start)
    )`,
    `CREATE INDEX wolv_strategy_evaluations_version_time
      ON wolv_strategy_evaluations (strategy_id, strategy_version, evaluated_at DESC)`,
    `CREATE TABLE wolv_agent_risk_policies (
      policy_id uuid PRIMARY KEY,
      policy_name text NOT NULL,
      version text NOT NULL,
      policy_document jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      active boolean NOT NULL DEFAULT false,
      UNIQUE (policy_name, version)
    )`,
    `CREATE UNIQUE INDEX wolv_agent_one_active_policy
      ON wolv_agent_risk_policies (policy_name) WHERE active`,
    `CREATE TABLE wolv_agent_policy_decisions (
      decision_id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES wolv_agent_runs(run_id),
      opportunity_id uuid REFERENCES wolv_agent_opportunities(opportunity_id),
      policy_version text NOT NULL,
      input_snapshot_hash char(64) NOT NULL,
      evaluated_at timestamptz NOT NULL,
      accepted boolean NOT NULL,
      refusal_reasons jsonb NOT NULL
    )`,
    `CREATE INDEX wolv_agent_policy_decisions_run_time
      ON wolv_agent_policy_decisions (run_id, evaluated_at DESC)`,
    `CREATE TABLE wolv_agent_proposals (
      proposal_id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES wolv_agent_runs(run_id),
      opportunity_id uuid NOT NULL REFERENCES wolv_agent_opportunities(opportunity_id),
      asset_id uuid NOT NULL REFERENCES wolv_agent_asset_history(asset_id),
      direction text NOT NULL CHECK (direction IN ('BUY','SELL')),
      intended_amount numeric NOT NULL CHECK (intended_amount > 0),
      quote_reference text,
      expected_input numeric,
      expected_output numeric,
      maximum_slippage_bps integer NOT NULL CHECK (maximum_slippage_bps BETWEEN 0 AND 10000),
      notional_value numeric NOT NULL CHECK (notional_value > 0),
      policy_result jsonb NOT NULL,
      analysis_id uuid NOT NULL REFERENCES wolv_agent_analyses(analysis_id),
      expires_at timestamptz NOT NULL,
      risks jsonb NOT NULL,
      user_explanation text NOT NULL,
      proposal_hash char(64) NOT NULL,
      proposal_status text NOT NULL CHECK (proposal_status IN (
        'AWAITING_USER_APPROVAL','USER_REJECTED','EXPIRED','REVOKED','EXECUTION_BLOCKED'
      )),
      user_decision text,
      decision_at timestamptz,
      approved_proposal_hash char(64),
      created_at timestamptz NOT NULL
    )`,
    `CREATE INDEX wolv_agent_proposals_status_expiry
      ON wolv_agent_proposals (proposal_status, expires_at)`,
    `CREATE TABLE wolv_agent_control (
      control_id boolean PRIMARY KEY DEFAULT true CHECK (control_id),
      emergency_stop boolean NOT NULL DEFAULT true,
      stop_monitoring boolean NOT NULL DEFAULT true,
      reject_new_opportunities boolean NOT NULL DEFAULT true,
      stop_reason text NOT NULL DEFAULT 'Agent control plane is disabled until explicitly configured.',
      permission_expires_at timestamptz,
      updated_at timestamptz NOT NULL
    )`,
    `INSERT INTO wolv_agent_control (control_id, updated_at)
      VALUES (true, now()) ON CONFLICT (control_id) DO NOTHING`,
    `CREATE OR REPLACE FUNCTION wolv_agent_proposals_material_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (to_jsonb(NEW) - ARRAY['proposal_status','user_decision','decision_at','approved_proposal_hash'])
          IS DISTINCT FROM
           (to_jsonb(OLD) - ARRAY['proposal_status','user_decision','decision_at','approved_proposal_hash']) THEN
          RAISE EXCEPTION 'wolv_agent_proposals material fields are immutable';
        END IF;
        RETURN NEW;
      END;
      $$`,
    `CREATE TRIGGER wolv_agent_proposals_immutable_material
      BEFORE UPDATE ON wolv_agent_proposals
      FOR EACH ROW EXECUTE FUNCTION wolv_agent_proposals_material_immutable()`,
  ],
}, {
  version: 2,
  statements: [
    `ALTER TABLE wolv_agent_runs
      ADD COLUMN owner_address text NOT NULL DEFAULT 'legacy'`,
    `DROP INDEX wolv_agent_run_single_flight`,
    `CREATE UNIQUE INDEX wolv_agent_run_single_flight
      ON wolv_agent_runs (owner_address, agent_id)
      WHERE run_status IN (
        'INITIALIZING','MONITORING','OBSERVATION_RECORDED','OPPORTUNITY_DETECTED',
        'ANALYZING','ANALYSIS_COMPLETED','POLICY_VALIDATION','POLICY_APPROVED',
        'PROPOSAL_CREATED','AWAITING_USER_APPROVAL','USER_APPROVED'
      )`,
    `ALTER TABLE wolv_agent_events
      ADD COLUMN owner_address text NOT NULL DEFAULT 'legacy'`,
    `ALTER TABLE wolv_agent_events
      ADD COLUMN idempotency_key text`,
    `ALTER TABLE wolv_agent_market_observations
      ADD COLUMN owner_address text NOT NULL DEFAULT 'legacy'`,
    `ALTER TABLE wolv_agent_market_candles
      ADD COLUMN owner_address text NOT NULL DEFAULT 'legacy'`,
    `DO $$
      DECLARE constraint_name text;
      BEGIN
        SELECT conname INTO constraint_name FROM pg_constraint
        WHERE conrelid = 'wolv_agent_market_observations'::regclass
          AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (idempotency_key)';
        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE wolv_agent_market_observations DROP CONSTRAINT %I', constraint_name);
        END IF;
      END $$`,
    `ALTER TABLE wolv_agent_market_observations
      ADD CONSTRAINT wolv_agent_market_observations_owner_idempotency_key
      UNIQUE (owner_address, idempotency_key)`,
    `DO $$
      DECLARE constraint_name text;
      BEGIN
        SELECT conname INTO constraint_name FROM pg_constraint
        WHERE conrelid = 'wolv_agent_market_candles'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) = 'UNIQUE (asset_id, interval, opening_at, provider)';
        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE wolv_agent_market_candles DROP CONSTRAINT %I', constraint_name);
        END IF;
      END $$`,
    `ALTER TABLE wolv_agent_market_candles
      ADD CONSTRAINT wolv_agent_candle_owner_key
      UNIQUE (owner_address, asset_id, interval, opening_at, provider)`,
    `ALTER TABLE wolv_agent_opportunities
      ADD COLUMN owner_address text NOT NULL DEFAULT 'legacy'`,
    `DO $$
      DECLARE constraint_name text;
      BEGIN
        SELECT conname INTO constraint_name FROM pg_constraint
        WHERE conrelid = 'wolv_agent_opportunities'::regclass
          AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (detection_key)';
        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE wolv_agent_opportunities DROP CONSTRAINT %I', constraint_name);
        END IF;
      END $$`,
    `ALTER TABLE wolv_agent_opportunities
      ADD CONSTRAINT wolv_agent_opportunities_owner_detection_key
      UNIQUE (owner_address, detection_key)`,
    `ALTER TABLE wolv_strategy_evaluations
      ADD COLUMN owner_address text NOT NULL DEFAULT 'legacy'`,
    `ALTER TABLE wolv_agent_risk_policies
      ADD COLUMN owner_address text NOT NULL DEFAULT 'legacy'`,
    `DO $$
      DECLARE constraint_name text;
      BEGIN
        SELECT conname INTO constraint_name FROM pg_constraint
        WHERE conrelid = 'wolv_agent_risk_policies'::regclass
          AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (policy_name, version)';
        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE wolv_agent_risk_policies DROP CONSTRAINT %I', constraint_name);
        END IF;
      END $$`,
    `ALTER TABLE wolv_agent_risk_policies
      ADD CONSTRAINT wolv_agent_risk_policies_owner_name_version_key
      UNIQUE (owner_address, policy_name, version)`,
    `CREATE INDEX wolv_agent_runs_owner_started
      ON wolv_agent_runs (owner_address, started_at DESC)`,
    `CREATE INDEX wolv_agent_observations_owner_asset_time
      ON wolv_agent_market_observations (owner_address, asset_id, provider_timestamp DESC)`,
    `CREATE INDEX wolv_agent_candles_owner_asset_time
      ON wolv_agent_market_candles (owner_address, asset_id, interval, opening_at DESC)`,
    `CREATE INDEX wolv_agent_events_owner_time
      ON wolv_agent_events (owner_address, occurred_at DESC, event_id DESC)`,
    `CREATE UNIQUE INDEX wolv_agent_events_owner_idempotency
      ON wolv_agent_events (owner_address, idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `DROP INDEX wolv_agent_one_active_policy`,
    `CREATE UNIQUE INDEX wolv_agent_one_active_policy
      ON wolv_agent_risk_policies (owner_address, policy_name) WHERE active`,
  ],
}];

const MIGRATION_LOCK_ID = 7_891_230_458;
const MAX_PAGE_SIZE = 100;
const MAX_PERMISSION_TTL_MS = 30 * 60_000;
export type ProposalStatus =
  | "AWAITING_USER_APPROVAL"
  | "USER_REJECTED"
  | "EXPIRED"
  | "REVOKED"
  | "EXECUTION_BLOCKED";

export type AgentEventInput = {
  eventType: string;
  occurredAt: number;
  correlationId: string;
  payload: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  idempotencyKey?: string;
};

export interface AgentMemoryStorePort {
  close(): Promise<void>;
  initialize(): Promise<void>;
  recordAssetVersion(input: AssetVersionInput): Promise<{ assetId: string; created: boolean }>;
  recordObservation(input: MarketObservationInput): Promise<{ observationId: string; created: boolean }>;
  recordCandle(input: {
    ownerAddress: string;
    assetId: string;
    interval: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string | null;
    openingAt: number;
    closingAt: number;
    provider: string;
    verificationStatus: string;
    provenance: Record<string, unknown>;
  }): Promise<{ candleId: string; created: boolean }>;
  createRun(input: AgentRunInput, runId?: string): Promise<string>;
  transitionRun(runId: string, nextState: AgentState, event: AgentEventInput): Promise<void>;
  appendEvent(runId: string | null, event: AgentEventInput, ownerAddress?: string): Promise<string>;
  recordOpportunity(input: {
    ownerAddress: string;
    opportunityId: string;
    runId: string;
    assetId: string;
    direction: AgentDirection;
    strategyId: string;
    strategyVersion: string;
    detectedAt: number;
    evidence: Record<string, unknown>;
    referencePrices: Record<string, unknown>;
    spreadPercent: number;
    historicalContext: Record<string, unknown>;
    status: string;
    expiresAt: number;
    detectionKey: string;
  }): Promise<{ opportunityId: string; created: boolean }>;
  recordAnalysis(input: {
    analysisId: string;
    runId: string;
    opportunityId: string;
    evidenceReferences: string[];
    modelIdentifier: string;
    modelVersion: string | null;
    analyzedAt: number;
    reasoningSummary: string;
    recommendation: string;
    risks: string[];
    invalidatingConditions: string[];
    structuredResult: Record<string, unknown>;
  }): Promise<string>;
  recordStrategyEvaluation(input: {
    ownerAddress: string;
    evaluationId: string;
    strategyId: string;
    strategyVersion: string;
    windowStart: number;
    windowEnd: number;
    opportunitiesEvaluated: number;
    expectedOutcome: Record<string, unknown>;
    observedOutcome: Record<string, unknown>;
    evaluatedAt: number;
    performanceMetrics: Record<string, unknown>;
    methodology: string;
  }): Promise<void>;
  recordPolicyDecision(input: {
    decisionId: string;
    runId: string;
    opportunityId: string | null;
    decision: PolicyDecision;
  }): Promise<void>;
  savePolicy(ownerAddress: string, name: string, policy: RiskPolicy, createdAt: number, active?: boolean): Promise<string>;
  createProposal(input: TradeProposalInput, proposalId: string, createdAt: number): Promise<{ proposalId: string; proposalHash: string }>;
  getProposal(proposalId: string, ownerAddress: string): Promise<Record<string, unknown> | null>;
  decideProposal(proposalId: string, ownerAddress: string, action: "APPROVE" | "REJECT" | "REVOKE", now: number): Promise<{ status: ProposalStatus; decision: string }>;
  expirePendingProposals(now: number, ownerAddress: string): Promise<number>;
  expireOpportunities(now: number, ownerAddress: string): Promise<number>;
  setEmergencyStop(input: {
    ownerAddress: string;
    stopped: boolean;
    reason: string;
    permissionExpiresAt: number | null;
    updatedAt: number;
    correlationId: string;
  }): Promise<void>;
  getControlState(now?: number): Promise<Record<string, unknown>>;
  listActivity(input: {
    ownerAddress: string;
    limit?: number;
    cursor?: string;
    agentId?: string;
    strategyId?: string;
    eventType?: string;
    runStatus?: string;
    assetId?: string;
    since?: number;
    until?: number;
  }): Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>;
  getRun(runId: string, ownerAddress: string): Promise<Record<string, unknown> | null>;
  getActiveRuns(ownerAddress: string): Promise<Array<Record<string, unknown>>>;
  recoverStaleRuns(now: number, staleBefore: number, ownerAddress: string): Promise<number>;
  reconstructRun(runId: string, ownerAddress: string): Promise<{ run: Record<string, unknown>; events: Array<Record<string, unknown>> } | null>;
  getRecentObservations(input: { ownerAddress: string; assetId?: string; since?: number; limit?: number }): Promise<Array<Record<string, unknown>>>;
  getOpportunityEvidence(input: { ownerAddress: string; since?: number; limit?: number }): Promise<Array<Record<string, unknown>>>;
  getCandles(input: { ownerAddress: string; assetId: string; interval: string; since?: number; limit?: number }): Promise<Array<Record<string, unknown>>>;
  getAssetHistory(ownerAddress: string, chainId: number, tokenAddress: string): Promise<Array<Record<string, unknown>>>;
  getPriorOpportunities(ownerAddress: string, assetId: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  getPriorAnalyses(ownerAddress: string, assetId: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  getPolicyRefusals(ownerAddress: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  listProposals(ownerAddress: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  listOpportunities(input: { ownerAddress: string; limit?: number; status?: string; assetId?: string }): Promise<Array<Record<string, unknown>>>;
  listAnalyses(ownerAddress: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  getStrategyEvaluations(input: { ownerAddress: string; strategyId?: string; limit?: number }): Promise<Array<Record<string, unknown>>>;
  updateOpportunityOutcome(opportunityId: string, ownerAddress: string, outcome: Record<string, unknown>): Promise<void>;
  getDailyExposure(ownerAddress: string, since: number): Promise<string>;
  getActivePolicy(ownerAddress: string, name: string): Promise<RiskPolicy | null>;
}

export class AgentMemoryStoreError extends Error {
  readonly code: "NOT_CONFIGURED" | "INVALID_DATABASE_URL" | "NOT_FOUND" | "INVALID_TRANSITION" | "EMERGENCY_STOP" | "DUPLICATE";

  constructor(
    code: AgentMemoryStoreError["code"],
  ) {
    super(`Agent memory store unavailable: ${code}`);
    this.code = code;
    this.name = "AgentMemoryStoreError";
  }
}

export class AgentMemoryStore implements AgentMemoryStorePort {
  private readonly sql: Sql;
  private readonly ready: Promise<void>;

  constructor(databaseUrl = process.env.WOLV_AGENT_DATABASE_URL ?? process.env.WOLV_TRADING_DATABASE_URL) {
    if (!databaseUrl) throw new AgentMemoryStoreError("NOT_CONFIGURED");
    if (!isPostgresUrl(databaseUrl)) throw new AgentMemoryStoreError("INVALID_DATABASE_URL");
    this.sql = postgres(databaseUrl, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 5,
      max_lifetime: 300,
      prepare: false,
      ssl: isLocalDevelopmentUrl(databaseUrl) ? false : "verify-full",
    });
    this.ready = this.runMigrations();
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async initialize(): Promise<void> {
    await this.ready;
  }

  async recordAssetVersion(input: AssetVersionInput): Promise<{ assetId: string; created: boolean }> {
    await this.ready;
    const metadataHash = hashJson({
      chainId: input.chainId,
      tokenAddress: input.tokenAddress.toLowerCase(),
      ticker: input.ticker,
      platform: input.platform,
      decimals: input.decimals,
      shareDenomination: input.shareDenomination,
      metadataSource: input.metadataSource,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      metadata: input.metadata,
    });
    const assetId = randomUUID();
    const rows = await this.sql`
      INSERT INTO wolv_agent_asset_history (
        asset_id, chain_id, token_address, ticker, platform, decimals, share_denomination,
        metadata_source, observed_at, block_number, block_hash, metadata, metadata_hash
      ) VALUES (
        ${assetId}, ${input.chainId}, ${input.tokenAddress.toLowerCase()}, ${input.ticker},
        ${input.platform}, ${input.decimals}, ${input.shareDenomination ? this.sql.json(jsonValue(input.shareDenomination)) : null},
        ${input.metadataSource}, ${new Date(input.observedAt)}, ${input.blockNumber},
        ${input.blockHash}, ${this.sql.json(jsonValue(input.metadata))}, ${metadataHash}
      )
      ON CONFLICT (chain_id, token_address, metadata_hash) DO NOTHING
      RETURNING asset_id
    `;
    if (rows[0]) return { assetId: String(rows[0].asset_id), created: true };
    const existing = await this.sql`
      SELECT asset_id FROM wolv_agent_asset_history
      WHERE chain_id = ${input.chainId} AND token_address = ${input.tokenAddress.toLowerCase()}
        AND metadata_hash = ${metadataHash}
    `;
    if (!existing[0]) throw new Error("Asset version was not returned after an idempotent insert.");
    return { assetId: String(existing[0].asset_id), created: false };
  }

  async recordObservation(input: MarketObservationInput): Promise<{ observationId: string; created: boolean }> {
    await this.ready;
    const ownerAddress = requireOwnerAddress(input.ownerAddress);
    const observationId = randomUUID();
    const rows = await this.sql`
      INSERT INTO wolv_agent_market_observations (
        observation_id, asset_id, price, reference_price, bid, ask, spread_percent, currency,
        price_kind, source, provider_timestamp, ingested_at, freshness_ms, verification_status,
        provenance, idempotency_key, owner_address
      ) VALUES (
        ${observationId}, ${input.assetId}, ${input.price}, ${input.referencePrice}, ${input.bid},
        ${input.ask}, ${input.spreadPercent}, ${input.currency}, ${input.priceKind}, ${input.source},
        ${new Date(input.providerTimestamp)}, ${new Date(input.ingestedAt)}, ${input.freshnessMs},
        ${input.verificationStatus}, ${this.sql.json(jsonValue(input.provenance))}, ${input.idempotencyKey},
        ${ownerAddress}
      )
      ON CONFLICT (owner_address, idempotency_key) DO NOTHING
      RETURNING observation_id
    `;
    if (rows[0]) return { observationId: String(rows[0].observation_id), created: true };
    const existing = await this.sql`
      SELECT observation_id FROM wolv_agent_market_observations       WHERE owner_address = ${ownerAddress} AND idempotency_key = ${input.idempotencyKey}
    `;
    if (!existing[0]) throw new Error("Observation was not returned after an idempotent insert.");
    return { observationId: String(existing[0].observation_id), created: false };
  }

  async recordCandle(input: Parameters<AgentMemoryStorePort["recordCandle"]>[0]): Promise<{ candleId: string; created: boolean }> {
    await this.ready;
    const ownerAddress = requireOwnerAddress(input.ownerAddress);
    const candleId = randomUUID();
    const rows = await this.sql`
      INSERT INTO wolv_agent_market_candles (
        candle_id, asset_id, interval, open_price, high_price, low_price, close_price, volume,
        opening_at, closing_at, provider, verification_status, provenance, owner_address
      ) VALUES (
        ${candleId}, ${input.assetId}, ${input.interval}, ${input.open}, ${input.high}, ${input.low},
        ${input.close}, ${input.volume}, ${new Date(input.openingAt)}, ${new Date(input.closingAt)},
        ${input.provider}, ${input.verificationStatus}, ${this.sql.json(jsonValue(input.provenance))},
        ${ownerAddress}
      )
      ON CONFLICT (owner_address, asset_id, interval, opening_at, provider) DO NOTHING
      RETURNING candle_id
    `;
    if (rows[0]) return { candleId: String(rows[0].candle_id), created: true };
    const existing = await this.sql`
      SELECT candle_id FROM wolv_agent_market_candles
      WHERE owner_address = ${ownerAddress} AND asset_id = ${input.assetId} AND interval = ${input.interval}
        AND opening_at = ${new Date(input.openingAt)} AND provider = ${input.provider}
    `;
    if (!existing[0]) throw new Error("Candle was not returned after an idempotent insert.");
    return { candleId: String(existing[0].candle_id), created: false };
  }

  async createRun(input: AgentRunInput, runId = randomUUID()): Promise<string> {
    await this.ready;
    const ownerAddress = requireOwnerAddress(input.ownerAddress);
    try {
      await this.sql.begin(async (transaction) => {
        const controls = await transaction`
          SELECT emergency_stop, stop_monitoring, reject_new_opportunities, permission_expires_at
          FROM wolv_agent_control WHERE control_id = true FOR UPDATE
        `;
        if (!controls[0] || controls[0].emergency_stop === true ||
          controls[0].stop_monitoring === true || controls[0].reject_new_opportunities === true ||
          !controls[0].permission_expires_at ||
          new Date(String(controls[0].permission_expires_at)).getTime() <= input.startedAt) {
          throw new AgentMemoryStoreError("EMERGENCY_STOP");
        }
        await transaction`
        INSERT INTO wolv_agent_runs (
          run_id, agent_id, strategy_id, strategy_version, trigger_type, started_at,
          run_status, configuration, owner_address
        ) VALUES (
          ${runId}, ${input.agentId}, ${input.strategyId}, ${input.strategyVersion},
          ${input.triggerType}, ${new Date(input.startedAt)}, 'INITIALIZING',
          ${transaction.json(jsonValue(input.configuration))}, ${ownerAddress}
        )
        `;
        await appendEventInTransaction(transaction, runId, {
          eventType: "STATE_CHANGED",
          occurredAt: input.startedAt,
          correlationId: runId,
          payload: { from: "IDLE", to: "INITIALIZING" },
          provenance: { source: "agent-orchestrator" },
        });
      });
    } catch (error) {
      if (error instanceof AgentMemoryStoreError) throw error;
      if (isPostgresConflict(error)) throw new AgentMemoryStoreError("DUPLICATE");
      throw error;
    }
    return runId;
  }

  async transitionRun(runId: string, nextState: AgentState, event: AgentEventInput): Promise<void> {
    await this.ready;
    try {
      await this.sql.begin(async (transaction) => {
        const rows = await transaction`SELECT run_status FROM wolv_agent_runs WHERE run_id = ${runId} FOR UPDATE`;
        if (!rows[0]) throw new AgentMemoryStoreError("NOT_FOUND");
        const current = String(rows[0].run_status) as AgentState;
        assertAgentTransition(current, nextState);
        const terminal = ["COMPLETED", "FAILED", "STOPPED"].includes(nextState);
        await transaction`
          UPDATE wolv_agent_runs
          SET run_status = ${nextState},
              ended_at = CASE WHEN ${terminal} THEN ${new Date(event.occurredAt)} ELSE ended_at END,
              termination_reason = CASE WHEN ${terminal} THEN ${String(event.payload.reason ?? nextState)} ELSE termination_reason END
          WHERE run_id = ${runId}
        `;
        await appendEventInTransaction(transaction, runId, {
          ...event,
          eventType: "STATE_CHANGED",
          payload: { ...event.payload, from: current, to: nextState },
        });
      });
    } catch (error) {
      if (error instanceof AgentMemoryStoreError) throw error;
      if (error instanceof Error && error.name === "AgentControlPlaneError") {
        throw new AgentMemoryStoreError("INVALID_TRANSITION");
      }
      throw error;
    }
  }

  async appendEvent(runId: string | null, event: AgentEventInput, ownerAddress?: string): Promise<string> {
    await this.ready;
    const normalizedOwner = runId === null
      ? requireOwnerAddress(ownerAddress)
      : undefined;
    return this.sql.begin((transaction) => appendEventInTransaction(transaction, runId, event, normalizedOwner));
  }

  async recordOpportunity(input: Parameters<AgentMemoryStorePort["recordOpportunity"]>[0]): Promise<{ opportunityId: string; created: boolean }> {
    await this.ready;
    const owner = requireOwnerAddress(input.ownerAddress);
    return this.sql.begin(async (transaction) => {
      const ownerRows = await transaction`
        SELECT owner_address FROM wolv_agent_runs WHERE run_id = ${input.runId} FOR UPDATE
      `;
      if (!ownerRows[0] || ownerRows[0].owner_address !== owner) throw new AgentMemoryStoreError("NOT_FOUND");
      const rows = await transaction`
        INSERT INTO wolv_agent_opportunities (
          opportunity_id, run_id, asset_id, direction, strategy_id, strategy_version, detected_at,
          evidence, reference_prices, spread_percent, historical_context, opportunity_status,
          expires_at, detection_key, owner_address
        ) VALUES (
          ${input.opportunityId}, ${input.runId}, ${input.assetId}, ${input.direction}, ${input.strategyId},
          ${input.strategyVersion}, ${new Date(input.detectedAt)}, ${transaction.json(jsonValue(input.evidence))},
          ${transaction.json(jsonValue(input.referencePrices))}, ${input.spreadPercent},
          ${transaction.json(jsonValue(input.historicalContext))}, ${input.status}, ${new Date(input.expiresAt)},
          ${input.detectionKey}, ${owner}
        )
        ON CONFLICT (owner_address, detection_key) DO NOTHING
        RETURNING opportunity_id
      `;
      if (rows[0]) {
        await appendEventInTransaction(transaction, input.runId, {
          eventType: "OPPORTUNITY_DETECTED",
          occurredAt: input.detectedAt,
          correlationId: input.runId,
          payload: {
            opportunityId: String(rows[0].opportunity_id),
            detectionKey: input.detectionKey,
            spreadPercent: input.spreadPercent,
            evidence: input.evidence,
            expiresAt: input.expiresAt,
          },
          provenance: { source: "deterministic-opportunity-detector", strategyVersion: input.strategyVersion },
        });
        return { opportunityId: String(rows[0].opportunity_id), created: true };
      }
      const existing = await transaction`
        SELECT opportunity_id FROM wolv_agent_opportunities
        WHERE owner_address = ${owner} AND detection_key = ${input.detectionKey}
      `;
      if (!existing[0]) throw new Error("Opportunity was not returned after an idempotent insert.");
      return { opportunityId: String(existing[0].opportunity_id), created: false };
    });
  }

  async recordAnalysis(input: Parameters<AgentMemoryStorePort["recordAnalysis"]>[0]): Promise<string> {
    await this.ready;
    await this.sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO wolv_agent_analyses (
        analysis_id, run_id, opportunity_id, evidence_references, model_identifier, model_version,
        analyzed_at, reasoning_summary, recommendation, risks, invalidating_conditions, structured_result
        ) VALUES (
        ${input.analysisId}, ${input.runId}, ${input.opportunityId},
        ${this.sql.json(jsonValue(input.evidenceReferences))}, ${input.modelIdentifier}, ${input.modelVersion},
        ${new Date(input.analyzedAt)}, ${input.reasoningSummary}, ${input.recommendation},
        ${this.sql.json(jsonValue(input.risks))}, ${this.sql.json(jsonValue(input.invalidatingConditions))},
        ${this.sql.json(jsonValue(input.structuredResult))}
        )
      `;
      await transaction`
        UPDATE wolv_agent_opportunities SET analysis_id = ${input.analysisId}
        WHERE opportunity_id = ${input.opportunityId}
      `;
      await appendEventInTransaction(transaction, input.runId, {
        eventType: "ANALYSIS_RECORDED",
        occurredAt: input.analyzedAt,
        correlationId: input.runId,
        payload: {
          analysisId: input.analysisId,
          opportunityId: input.opportunityId,
          modelIdentifier: input.modelIdentifier,
          evidenceReferences: input.evidenceReferences,
        },
        provenance: { source: "agent-analysis" },
      });
    });
    return input.analysisId;
  }

  async recordStrategyEvaluation(input: Parameters<AgentMemoryStorePort["recordStrategyEvaluation"]>[0]): Promise<void> {
    await this.ready;
    const owner = requireOwnerAddress(input.ownerAddress);
    await this.sql`
      INSERT INTO wolv_strategy_evaluations (
        evaluation_id, strategy_id, strategy_version, window_start, window_end,
        opportunities_evaluated, expected_outcome, observed_outcome, evaluated_at,
        performance_metrics, methodology, owner_address
      ) VALUES (
        ${input.evaluationId}, ${input.strategyId}, ${input.strategyVersion},
        ${new Date(input.windowStart)}, ${new Date(input.windowEnd)},
        ${input.opportunitiesEvaluated}, ${this.sql.json(jsonValue(input.expectedOutcome))},
        ${this.sql.json(jsonValue(input.observedOutcome))}, ${new Date(input.evaluatedAt)},
        ${this.sql.json(jsonValue(input.performanceMetrics))}, ${input.methodology}, ${owner}
      )
    `;
  }

  async recordPolicyDecision(input: Parameters<AgentMemoryStorePort["recordPolicyDecision"]>[0]): Promise<void> {
    await this.ready;
    const { decision } = input;
    await this.sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO wolv_agent_policy_decisions (
          decision_id, run_id, opportunity_id, policy_version, input_snapshot_hash,
          evaluated_at, accepted, refusal_reasons
        ) VALUES (
          ${input.decisionId}, ${input.runId}, ${input.opportunityId}, ${decision.policyVersion},
          ${decision.inputSnapshotHash}, ${new Date(decision.evaluatedAt)}, ${decision.accepted},
          ${transaction.json(jsonValue(decision.refusalReasons))}
        )
      `;
      await appendEventInTransaction(transaction, input.runId, {
        eventType: decision.accepted ? "POLICY_ACCEPTED" : "POLICY_REJECTED",
        occurredAt: decision.evaluatedAt,
        correlationId: input.runId,
        payload: {
          policyVersion: decision.policyVersion,
          inputSnapshotHash: decision.inputSnapshotHash,
          accepted: decision.accepted,
          refusalReasons: decision.refusalReasons,
        },
        provenance: { source: "deterministic-policy-engine" },
      });
    });
  }

  async savePolicy(ownerAddress: string, name: string, policy: RiskPolicy, createdAt: number, active = false): Promise<string> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name) ||
      validateRiskPolicy(policy).length > 0 ||
      policy.permissionExpiresAt <= createdAt) {
      throw new TypeError("Risk policy name, fields, or permission expiration are invalid.");
    }
    const policyId = randomUUID();
    return this.sql.begin(async (transaction) => {
      if (active) {
        await transaction`UPDATE wolv_agent_risk_policies SET active = false WHERE owner_address = ${owner} AND policy_name = ${name}`;
      }
      const rows = await transaction`
        INSERT INTO wolv_agent_risk_policies (
          policy_id, policy_name, version, policy_document, created_at, active, owner_address
        )
        VALUES (
          ${policyId}, ${name}, ${policy.version}, ${transaction.json(jsonValue(policy))},
          ${new Date(createdAt)}, ${active}, ${owner}
        )
        ON CONFLICT (owner_address, policy_name, version) DO NOTHING
        RETURNING policy_id
      `;
      if (rows[0]) return String(rows[0].policy_id);
      const existing = await transaction`
        SELECT policy_id, policy_document FROM wolv_agent_risk_policies
        WHERE owner_address = ${owner} AND policy_name = ${name} AND version = ${policy.version}
        FOR UPDATE
      `;
      if (!existing[0] || hashJson(parseJson(existing[0].policy_document)) !== hashJson(policy)) {
        throw new Error("A policy version is immutable; create a new version instead.");
      }
      if (active) {
        await transaction`
          UPDATE wolv_agent_risk_policies SET active = true
          WHERE policy_id = ${existing[0].policy_id} AND owner_address = ${owner}
        `;
      }
      return String(existing[0].policy_id);
    });
  }

  async createProposal(input: TradeProposalInput, proposalId: string, createdAt: number): Promise<{ proposalId: string; proposalHash: string }> {
    await this.ready;
    if (!input.policyDecision.accepted) throw new AgentMemoryStoreError("INVALID_TRANSITION");
    const proposalHash = hashJson(input);
    await this.sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO wolv_agent_proposals (
          proposal_id, run_id, opportunity_id, asset_id, direction, intended_amount, quote_reference,
          expected_input, expected_output, maximum_slippage_bps, notional_value, policy_result, analysis_id,
          expires_at, risks, user_explanation, proposal_hash, proposal_status, created_at
        ) VALUES (
          ${proposalId}, ${input.runId}, ${input.opportunityId}, ${input.assetId}, ${input.direction},
          ${input.intendedAmount}, ${input.quoteReference}, ${input.expectedInput}, ${input.expectedOutput},
          ${input.maximumSlippageBps}, ${input.notionalValue}, ${transaction.json(jsonValue(input.policyDecision))}, ${input.analysisId},
          ${new Date(input.expiresAt)}, ${transaction.json(jsonValue(input.risks))}, ${input.explanation},
          ${proposalHash}, 'AWAITING_USER_APPROVAL', ${new Date(createdAt)}
        )
      `;
      await appendEventInTransaction(transaction, input.runId, {
        eventType: "TRADE_PROPOSAL_CREATED",
        occurredAt: createdAt,
        correlationId: input.runId,
        payload: { proposalId, proposalHash, expiresAt: input.expiresAt },
        provenance: { source: "agent-orchestrator" },
      });
      await appendEventInTransaction(transaction, input.runId, {
        eventType: "TRADE_PROPOSAL_HASHED",
        occurredAt: createdAt,
        correlationId: proposalId,
        payload: { proposalId, proposalHash },
        provenance: { source: "approval-manager" },
      });
    });
    return { proposalId, proposalHash };
  }

  async getProposal(proposalId: string, ownerAddress: string): Promise<Record<string, unknown> | null> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT p.* FROM wolv_agent_proposals p
      JOIN wolv_agent_runs r ON r.run_id = p.run_id
      WHERE p.proposal_id = ${proposalId} AND r.owner_address = ${owner}
    `;
    return rows[0] ? normalizeRow(rows[0]) : null;
  }

  async decideProposal(
    proposalId: string,
    ownerAddress: string,
    action: "APPROVE" | "REJECT" | "REVOKE",
    now: number,
  ): Promise<{ status: ProposalStatus; decision: string }> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`
        SELECT p.run_id, p.proposal_status, p.user_decision, p.proposal_hash,
          p.approved_proposal_hash, p.expires_at
        FROM wolv_agent_proposals p
        JOIN wolv_agent_runs r ON r.run_id = p.run_id
        WHERE p.proposal_id = ${proposalId} AND r.owner_address = ${owner}
        FOR UPDATE OF p
      `;
      if (!rows[0]) throw new AgentMemoryStoreError("NOT_FOUND");
      const current = String(rows[0].proposal_status) as ProposalStatus;
      const expiresAt = new Date(String(rows[0].expires_at)).getTime();
      if (current === "AWAITING_USER_APPROVAL" && now >= expiresAt) {
        await transaction`
          UPDATE wolv_agent_proposals
          SET proposal_status = 'EXPIRED', user_decision = 'EXPIRED', decision_at = ${new Date(now)}
          WHERE proposal_id = ${proposalId}
        `;
        await appendEventInTransaction(transaction, String(rows[0].run_id), {
          eventType: "PROPOSAL_EXPIRED",
          occurredAt: now,
          correlationId: proposalId,
          payload: { proposalId, reason: "Proposal expiration reached." },
          provenance: { source: "approval-manager" },
        });
        await transitionRunInTransaction(transaction, String(rows[0].run_id), "AWAITING_USER_APPROVAL", "EXPIRED", now, {
          proposalId,
          reason: "Proposal expiration reached.",
        });
        await transitionRunInTransaction(transaction, String(rows[0].run_id), "EXPIRED", "COMPLETED", now, {
          proposalId,
          reason: "Expired proposal is closed; execution remains blocked.",
        });
        return { status: "EXPIRED", decision: "EXPIRED" };
      }
      let nextStatus: ProposalStatus;
      let decision: string;
      if (action === "APPROVE" && current === "AWAITING_USER_APPROVAL") {
        nextStatus = "EXECUTION_BLOCKED";
        decision = "APPROVED";
        await transaction`
          UPDATE wolv_agent_proposals
          SET proposal_status = ${nextStatus}, user_decision = ${decision}, decision_at = ${new Date(now)},
              approved_proposal_hash = proposal_hash
          WHERE proposal_id = ${proposalId}
        `;
      } else if (action === "REJECT" && current === "AWAITING_USER_APPROVAL") {
        nextStatus = "USER_REJECTED";
        decision = "REJECTED";
        await transaction`
          UPDATE wolv_agent_proposals
          SET proposal_status = ${nextStatus}, user_decision = ${decision}, decision_at = ${new Date(now)}
          WHERE proposal_id = ${proposalId}
        `;
      } else if (action === "REVOKE" && current === "EXECUTION_BLOCKED" && rows[0].user_decision === "APPROVED") {
        nextStatus = "REVOKED";
        decision = "REVOKED";
        await transaction`
          UPDATE wolv_agent_proposals
          SET proposal_status = ${nextStatus}, user_decision = ${decision}, decision_at = ${new Date(now)}
          WHERE proposal_id = ${proposalId}
        `;
      } else {
        throw new AgentMemoryStoreError("INVALID_TRANSITION");
      }
      if (decision === "APPROVED") {
        const binding = await transaction`
          SELECT proposal_hash, approved_proposal_hash FROM wolv_agent_proposals
          WHERE proposal_id = ${proposalId}
        `;
        if (!binding[0] || binding[0].proposal_hash !== binding[0].approved_proposal_hash) {
          throw new AgentMemoryStoreError("INVALID_TRANSITION");
        }
        await transitionRunInTransaction(transaction, String(rows[0].run_id), "AWAITING_USER_APPROVAL", "USER_APPROVED", now, {
          proposalId,
          proposalHash: rows[0].proposal_hash,
        });
        await transitionRunInTransaction(transaction, String(rows[0].run_id), "USER_APPROVED", "EXECUTION_BLOCKED", now, {
          proposalId,
          reason: "Phase 4.0 does not permit transaction execution.",
        });
        await transitionRunInTransaction(transaction, String(rows[0].run_id), "EXECUTION_BLOCKED", "COMPLETED", now, {
          proposalId,
          reason: "User approved the exact proposal; execution remains blocked.",
        });
      } else if (decision === "REJECTED") {
        await transitionRunInTransaction(transaction, String(rows[0].run_id), "AWAITING_USER_APPROVAL", "USER_REJECTED", now, {
          proposalId,
        });
        await transitionRunInTransaction(transaction, String(rows[0].run_id), "USER_REJECTED", "COMPLETED", now, {
          proposalId,
        });
      }
      await appendEventInTransaction(transaction, String(rows[0].run_id), {
        eventType: action === "APPROVE" ? "USER_APPROVAL_RECORDED"
          : action === "REJECT" ? "USER_REJECTION_RECORDED"
            : "PROPOSAL_REVOKED",
        occurredAt: now,
        correlationId: proposalId,
        payload: {
          proposalId,
          proposalHash: rows[0].proposal_hash,
          decision,
          executionStatus: decision === "APPROVED" ? "EXECUTION_BLOCKED" : nextStatus,
        },
        provenance: { source: "approval-manager" },
      });
      return { status: nextStatus, decision };
    });
  }

  async expirePendingProposals(now: number, ownerAddress: string): Promise<number> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    return this.sql.begin(async (transaction) => {
      const expired = await transaction`
        SELECT p.proposal_id, p.run_id, p.expires_at
        FROM wolv_agent_proposals p
        JOIN wolv_agent_runs r ON r.run_id = p.run_id
        WHERE r.owner_address = ${owner}
          AND p.proposal_status = 'AWAITING_USER_APPROVAL' AND p.expires_at <= ${new Date(now)}
        ORDER BY p.expires_at ASC
        FOR UPDATE OF p SKIP LOCKED
      `;
      for (const proposal of expired) {
        await transaction`
          UPDATE wolv_agent_proposals
          SET proposal_status = 'EXPIRED', user_decision = 'EXPIRED', decision_at = ${new Date(now)}
          WHERE proposal_id = ${String(proposal.proposal_id)}
        `;
        await appendEventInTransaction(transaction, String(proposal.run_id), {
          eventType: "PROPOSAL_EXPIRED",
          occurredAt: now,
          correlationId: String(proposal.proposal_id),
          payload: { proposalId: String(proposal.proposal_id), reason: "Proposal expiration reached." },
          provenance: { source: "approval-manager" },
        });
        await transitionRunInTransaction(transaction, String(proposal.run_id), "AWAITING_USER_APPROVAL", "EXPIRED", now, {
          proposalId: String(proposal.proposal_id),
          reason: "Proposal expiration reached.",
        });
        await transitionRunInTransaction(transaction, String(proposal.run_id), "EXPIRED", "COMPLETED", now, {
          proposalId: String(proposal.proposal_id),
          reason: "Expired proposal is closed; execution remains blocked.",
        });
      }
      return expired.length;
    });
  }

  async expireOpportunities(now: number, ownerAddress: string): Promise<number> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    return this.sql.begin(async (transaction) => {
      const expired = await transaction`
        SELECT o.opportunity_id, o.run_id
        FROM wolv_agent_opportunities o
        JOIN wolv_agent_runs r ON r.run_id = o.run_id
        WHERE r.owner_address = ${owner}
          AND o.opportunity_status = 'DETECTED' AND o.expires_at <= ${new Date(now)}
        ORDER BY o.expires_at ASC
        FOR UPDATE OF o SKIP LOCKED
      `;
      for (const opportunity of expired) {
        await transaction`
          UPDATE wolv_agent_opportunities
          SET opportunity_status = 'EXPIRED'
          WHERE opportunity_id = ${String(opportunity.opportunity_id)}
        `;
        await appendEventInTransaction(transaction, String(opportunity.run_id), {
          eventType: "OPPORTUNITY_EXPIRED",
          occurredAt: now,
          correlationId: String(opportunity.opportunity_id),
          payload: { opportunityId: String(opportunity.opportunity_id), reason: "Opportunity TTL elapsed." },
          provenance: { source: "opportunity-lifecycle" },
        });
      }
      return expired.length;
    });
  }

  async setEmergencyStop(input: Parameters<AgentMemoryStorePort["setEmergencyStop"]>[0]): Promise<void> {
    await this.ready;
    const owner = requireOwnerAddress(input.ownerAddress);
    if (!input.stopped &&
      (input.permissionExpiresAt === null ||
        input.permissionExpiresAt <= input.updatedAt ||
        input.permissionExpiresAt > input.updatedAt + MAX_PERMISSION_TTL_MS)) {
      throw new AgentMemoryStoreError("INVALID_TRANSITION");
    }
    await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE wolv_agent_control
        SET emergency_stop = ${input.stopped},
            stop_monitoring = ${input.stopped},
            reject_new_opportunities = ${input.stopped},
            stop_reason = ${input.reason},
            permission_expires_at = ${input.permissionExpiresAt === null ? null : new Date(input.permissionExpiresAt)},
            updated_at = ${new Date(input.updatedAt)}
        WHERE control_id = true
      `;
      await appendEventInTransaction(transaction, null, {
        eventType: input.stopped ? "EMERGENCY_STOP_ACTIVATED" : "EMERGENCY_STOP_CLEARED",
        occurredAt: input.updatedAt,
        correlationId: input.correlationId,
        payload: { reason: input.reason, permissionExpiresAt: input.permissionExpiresAt },
        provenance: { source: "operator-control" },
      }, owner);
      if (input.stopped) {
        const pending = await transaction`
          SELECT proposal_id, run_id FROM wolv_agent_proposals
          WHERE proposal_status = 'AWAITING_USER_APPROVAL' FOR UPDATE
        `;
        await transaction`
          UPDATE wolv_agent_proposals
          SET proposal_status = 'EXPIRED', user_decision = 'EXPIRED', decision_at = ${new Date(input.updatedAt)}
          WHERE proposal_status = 'AWAITING_USER_APPROVAL'
        `;
        for (const proposal of pending) {
          await appendEventInTransaction(transaction, String(proposal.run_id), {
            eventType: "PROPOSAL_EXPIRED",
            occurredAt: input.updatedAt,
            correlationId: String(proposal.proposal_id),
            payload: { proposalId: String(proposal.proposal_id), reason: "Emergency stop expired pending proposal." },
            provenance: { source: "emergency-control" },
          });
        }
        const activeRuns = await transaction`
          SELECT run_id, run_status FROM wolv_agent_runs
          WHERE ended_at IS NULL
          ORDER BY started_at ASC
          FOR UPDATE
        `;
        for (const run of activeRuns) {
          const current = String(run.run_status) as AgentState;
          if (current === "COMPLETED" || current === "FAILED" || current === "STOPPED") continue;
          await transitionRunInTransaction(
            transaction,
            String(run.run_id),
            current,
            "STOPPED",
            input.updatedAt,
            { reason: "Emergency stop activated; unfinished run was stopped." },
          );
        }
      }
    });
  }

  async getControlState(now = Date.now()): Promise<Record<string, unknown>> {
    await this.ready;
    const rows = await this.sql`SELECT emergency_stop, stop_monitoring, reject_new_opportunities, stop_reason, permission_expires_at, updated_at FROM wolv_agent_control WHERE control_id = true`;
    if (!rows[0]) throw new Error("Agent control state is missing.");
    const state = normalizeRow(rows[0]);
    const permissionExpiresAt = state.permission_expires_at === null
      ? null
      : Date.parse(String(state.permission_expires_at));
    return {
      ...state,
      permission_expires_at: permissionExpiresAt,
      permission_active: state.emergency_stop === false &&
        state.stop_monitoring === false &&
        state.reject_new_opportunities === false &&
        permissionExpiresAt !== null &&
        Number.isFinite(permissionExpiresAt) &&
        permissionExpiresAt > now,
    };
  }

  async listActivity(input: Parameters<AgentMemoryStorePort["listActivity"]>[0]): Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null }> {
    await this.ready;
    const owner = requireOwnerAddress(input.ownerAddress);
    const limit = boundedLimit(input.limit);
    const cursor = input.cursor ? parseCursor(input.cursor) : null;
    const since = input.since === undefined ? null : new Date(input.since);
    const until = input.until === undefined ? null : new Date(input.until);
    const rows = await this.sql`
      SELECT e.event_id, e.run_id, e.event_type, e.occurred_at, e.sequence_number,
        e.correlation_id, e.event_payload, e.source_provenance,
        r.agent_id, r.strategy_id, r.strategy_version, r.run_status
      FROM wolv_agent_events e
      LEFT JOIN wolv_agent_runs r ON r.run_id = e.run_id
      WHERE e.owner_address = ${owner}
        AND (${input.agentId ?? null}::text IS NULL OR r.agent_id = ${input.agentId ?? null})
        AND (${input.strategyId ?? null}::text IS NULL OR r.strategy_id = ${input.strategyId ?? null})
        AND (${input.eventType ?? null}::text IS NULL OR e.event_type = ${input.eventType ?? null})
        AND (${input.runStatus ?? null}::text IS NULL OR r.run_status = ${input.runStatus ?? null})
        AND (${since}::timestamptz IS NULL OR e.occurred_at >= ${since})
        AND (${until}::timestamptz IS NULL OR e.occurred_at <= ${until})
        AND (${input.assetId ?? null}::uuid IS NULL OR EXISTS (
          SELECT 1 FROM wolv_agent_opportunities o
          WHERE o.run_id = e.run_id AND o.asset_id = ${input.assetId ?? null}::uuid
        ))
        AND (${cursor?.timestamp ?? null}::timestamptz IS NULL OR
          (e.occurred_at, e.event_id) < (${cursor?.timestamp ?? null}::timestamptz, ${cursor?.eventId ?? null}::uuid))
      ORDER BY e.occurred_at DESC, e.event_id DESC
      LIMIT ${limit + 1}
    `;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(normalizeRow);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last
        ? encodeCursor(new Date(String(last.occurred_at)).toISOString(), String(last.event_id))
        : null,
    };
  }

  async getRun(runId: string, ownerAddress: string): Promise<Record<string, unknown> | null> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`SELECT * FROM wolv_agent_runs WHERE run_id = ${runId} AND owner_address = ${owner}`;
    return rows[0] ? normalizeRow(rows[0]) : null;
  }

  async getActiveRuns(ownerAddress: string): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT * FROM wolv_agent_runs
      WHERE owner_address = ${owner} AND ended_at IS NULL
      ORDER BY started_at ASC
      LIMIT ${MAX_PAGE_SIZE}
    `;
    return rows.map(normalizeRow);
  }

  async recoverStaleRuns(now: number, staleBefore: number, ownerAddress: string): Promise<number> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const staleRuns = await this.sql`
      SELECT run_id, run_status FROM wolv_agent_runs
      WHERE owner_address = ${owner} AND ended_at IS NULL AND started_at <= ${new Date(staleBefore)}
      ORDER BY started_at ASC
      LIMIT ${MAX_PAGE_SIZE}
    `;
    let recovered = 0;
    for (const run of staleRuns) {
      const state = String(run.run_status) as AgentState;
      if (!["INITIALIZING", "MONITORING", "OBSERVATION_RECORDED", "OPPORTUNITY_DETECTED",
        "ANALYZING", "ANALYSIS_COMPLETED", "POLICY_VALIDATION", "POLICY_APPROVED",
        "PROPOSAL_CREATED"].includes(state)) continue;
      await this.transitionRun(String(run.run_id), "FAILED", {
        eventType: "RUN_RECOVERED_AS_INTERRUPTED",
        occurredAt: now,
        correlationId: String(run.run_id),
        payload: { reason: "Run was unfinished beyond the recovery age and was closed fail-safe." },
        provenance: { source: "run-recovery" },
      });
      recovered += 1;
    }
    return recovered;
  }

  async reconstructRun(
    runId: string,
    ownerAddress: string,
  ): Promise<{ run: Record<string, unknown>; events: Array<Record<string, unknown>> } | null> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT * FROM wolv_agent_runs WHERE run_id = ${runId} AND owner_address = ${owner}
    `;
    if (!rows[0]) return null;
    const events = await this.sql`
      SELECT event_id, run_id, event_type, occurred_at, sequence_number, correlation_id,
        event_payload, source_provenance, previous_event_id
      FROM wolv_agent_events WHERE run_id = ${runId}
      ORDER BY sequence_number ASC
    `;
    const reconstructedEvents = events.map(normalizeRow);
    let previousEventId: string | null = null;
    for (let index = 0; index < reconstructedEvents.length; index += 1) {
      const event = reconstructedEvents[index];
      if (Number(event.sequence_number) !== index + 1 ||
        (event.previous_event_id === null ? null : String(event.previous_event_id)) !== previousEventId) {
        throw new AgentMemoryStoreError("INVALID_TRANSITION");
      }
      previousEventId = String(event.event_id);
    }
    const run = normalizeRow(rows[0]);
    const lastStateEvent = reconstructedEvents.filter((event) => event.event_type === "STATE_CHANGED").at(-1);
    if (!lastStateEvent ||
      !isRecord(lastStateEvent.event_payload) ||
      lastStateEvent.event_payload.to !== run.run_status) {
      throw new AgentMemoryStoreError("INVALID_TRANSITION");
    }
    return { run, events: reconstructedEvents };
  }

  async getRecentObservations(input: Parameters<AgentMemoryStorePort["getRecentObservations"]>[0]): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(input.ownerAddress);
    const limit = boundedLimit(input.limit);
    const since = input.since === undefined ? null : new Date(input.since);
    const rows = await this.sql`
      SELECT o.observation_id, o.asset_id, o.price, o.reference_price, o.bid, o.ask,
        o.spread_percent, o.currency, o.price_kind, o.source, o.provider_timestamp,
        o.ingested_at, o.freshness_ms, o.verification_status, o.provenance,
        a.ticker, a.platform, a.token_address, a.chain_id
      FROM wolv_agent_market_observations o
      JOIN wolv_agent_asset_history a ON a.asset_id = o.asset_id
      WHERE o.owner_address = ${owner}
        AND (${input.assetId ?? null}::uuid IS NULL OR o.asset_id = ${input.assetId ?? null}::uuid)
        AND (${since}::timestamptz IS NULL OR o.provider_timestamp >= ${since})
      ORDER BY o.provider_timestamp DESC, o.observation_id DESC LIMIT ${limit}
    `;
    return rows.map(normalizeRow);
  }

  async getOpportunityEvidence(input: Parameters<AgentMemoryStorePort["getOpportunityEvidence"]>[0]): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(input.ownerAddress);
    const limit = boundedLimit(input.limit);
    const since = input.since ? new Date(input.since) : null;
    const rows = await this.sql`
      SELECT o.observation_id, o.asset_id, a.token_address, a.ticker, a.platform, o.currency, o.price,
        o.reference_price, o.provider_timestamp, o.ingested_at, o.freshness_ms,
        o.verification_status, o.price_kind,
        CASE
          WHEN a.share_denomination ? 'tokenToShareRatio'
            AND (a.share_denomination->>'tokenToShareRatio') ~ '^[0-9]+(\\.[0-9]+)?$'
            AND (a.share_denomination->>'tokenToShareRatio')::numeric > 0
          THEN (o.price / (a.share_denomination->>'tokenToShareRatio')::numeric)::text
          ELSE NULL
        END AS normalized_share_price
      FROM wolv_agent_market_observations o
      JOIN wolv_agent_asset_history a ON a.asset_id = o.asset_id
      WHERE o.owner_address = ${owner}
        AND (${since}::timestamptz IS NULL OR o.provider_timestamp >= ${since})
      ORDER BY o.provider_timestamp DESC, o.observation_id DESC
      LIMIT ${limit}
    `;
    return rows.map(normalizeRow);
  }

  async getCandles(input: Parameters<AgentMemoryStorePort["getCandles"]>[0]): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(input.ownerAddress);
    const since = input.since === undefined ? null : new Date(input.since);
    const rows = await this.sql`
      SELECT * FROM wolv_agent_market_candles
      WHERE owner_address = ${owner} AND asset_id = ${input.assetId} AND interval = ${input.interval}
        AND (${since}::timestamptz IS NULL OR opening_at >= ${since})
      ORDER BY opening_at DESC
      LIMIT ${boundedLimit(input.limit)}
    `;
    return rows.map(normalizeRow);
  }

  async getAssetHistory(ownerAddress: string, chainId: number, tokenAddress: string): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT * FROM wolv_agent_asset_history
      WHERE chain_id = ${chainId} AND lower(token_address) = lower(${tokenAddress})
      ORDER BY observed_at DESC, asset_id DESC
    `;
    return rows.map(normalizeRow);
  }

  async getPriorOpportunities(ownerAddress: string, assetId: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT o.* FROM wolv_agent_opportunities o
      JOIN wolv_agent_runs r ON r.run_id = o.run_id
      WHERE r.owner_address = ${owner} AND o.asset_id = ${assetId}
      ORDER BY o.detected_at DESC, o.opportunity_id DESC
      LIMIT ${boundedLimit(limit)}
    `;
    return rows.map(normalizeRow);
  }

  async getPriorAnalyses(ownerAddress: string, assetId: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT a.* FROM wolv_agent_analyses a
      JOIN wolv_agent_opportunities o ON o.opportunity_id = a.opportunity_id
      JOIN wolv_agent_runs r ON r.run_id = o.run_id
      WHERE r.owner_address = ${owner} AND o.asset_id = ${assetId}
      ORDER BY a.analyzed_at DESC, a.analysis_id DESC
      LIMIT ${boundedLimit(limit)}
    `;
    return rows.map(normalizeRow);
  }

  async getPolicyRefusals(ownerAddress: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT d.* FROM wolv_agent_policy_decisions d
      JOIN wolv_agent_runs r ON r.run_id = d.run_id
      WHERE r.owner_address = ${owner} AND d.accepted = false
      ORDER BY d.evaluated_at DESC, d.decision_id DESC
      LIMIT ${boundedLimit(limit)}
    `;
    return rows.map(normalizeRow);
  }

  async listProposals(ownerAddress: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT p.proposal_id, p.run_id, p.opportunity_id, p.asset_id, p.direction, p.intended_amount, p.notional_value,
        p.quote_reference, p.expected_input, p.expected_output, p.maximum_slippage_bps, p.policy_result,
        p.analysis_id, p.expires_at, p.risks, p.user_explanation, p.proposal_hash, p.proposal_status,
        p.user_decision, p.decision_at, p.created_at
      FROM wolv_agent_proposals p
      JOIN wolv_agent_runs r ON r.run_id = p.run_id
      WHERE r.owner_address = ${owner}
      ORDER BY p.created_at DESC, p.proposal_id DESC
      LIMIT ${boundedLimit(limit)}
    `;
    return rows.map(normalizeRow);
  }

  async listOpportunities(input: Parameters<AgentMemoryStorePort["listOpportunities"]>[0]): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(input.ownerAddress);
    const rows = await this.sql`
      SELECT o.*, a.ticker, a.platform, a.token_address, r.agent_id, r.run_status
      FROM wolv_agent_opportunities o
      JOIN wolv_agent_asset_history a ON a.asset_id = o.asset_id
      JOIN wolv_agent_runs r ON r.run_id = o.run_id
      WHERE r.owner_address = ${owner}
        AND (${input.status ?? null}::text IS NULL OR o.opportunity_status = ${input.status ?? null})
        AND (${input.assetId ?? null}::uuid IS NULL OR o.asset_id = ${input.assetId ?? null}::uuid)
      ORDER BY o.detected_at DESC, o.opportunity_id DESC
      LIMIT ${boundedLimit(input.limit)}
    `;
    return rows.map(normalizeRow);
  }

  async listAnalyses(ownerAddress: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT a.*, o.asset_id, s.ticker, s.platform
      FROM wolv_agent_analyses a
      JOIN wolv_agent_opportunities o ON o.opportunity_id = a.opportunity_id
      JOIN wolv_agent_asset_history s ON s.asset_id = o.asset_id
      JOIN wolv_agent_runs r ON r.run_id = a.run_id
      WHERE r.owner_address = ${owner}
      ORDER BY a.analyzed_at DESC, a.analysis_id DESC
      LIMIT ${boundedLimit(limit)}
    `;
    return rows.map(normalizeRow);
  }

  async getStrategyEvaluations(input: Parameters<AgentMemoryStorePort["getStrategyEvaluations"]>[0]): Promise<Array<Record<string, unknown>>> {
    await this.ready;
    const owner = requireOwnerAddress(input.ownerAddress);
    const rows = await this.sql`
      SELECT * FROM wolv_strategy_evaluations
      WHERE owner_address = ${owner}
        AND (${input.strategyId ?? null}::text IS NULL OR strategy_id = ${input.strategyId ?? null})
      ORDER BY evaluated_at DESC, evaluation_id DESC
      LIMIT ${boundedLimit(input.limit)}
    `;
    return rows.map(normalizeRow);
  }

  async updateOpportunityOutcome(opportunityId: string, ownerAddress: string, outcome: Record<string, unknown>): Promise<void> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    await this.sql.begin(async (transaction) => {
      const rows = await transaction`
        UPDATE wolv_agent_opportunities
        SET outcome = ${transaction.json(jsonValue(outcome))}, opportunity_status = 'OUTCOME_RECORDED'
        WHERE opportunity_id = ${opportunityId} AND EXISTS (
          SELECT 1 FROM wolv_agent_runs r
          WHERE r.run_id = wolv_agent_opportunities.run_id AND r.owner_address = ${owner}
        )
        RETURNING run_id
      `;
      if (!rows[0]) throw new AgentMemoryStoreError("NOT_FOUND");
      await appendEventInTransaction(transaction, String(rows[0].run_id), {
        eventType: "OPPORTUNITY_OUTCOME_RECORDED",
        occurredAt: Date.now(),
        correlationId: opportunityId,
        payload: { opportunityId, outcome },
        provenance: { source: "historical-evaluation" },
      });
    });
  }

  async getDailyExposure(ownerAddress: string, since: number): Promise<string> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT COALESCE(SUM(p.notional_value), 0)::text AS exposure
      FROM wolv_agent_proposals p
      JOIN wolv_agent_runs r ON r.run_id = p.run_id
      WHERE r.owner_address = ${owner}
        AND p.proposal_status IN ('AWAITING_USER_APPROVAL','EXECUTION_BLOCKED')
        AND p.created_at >= ${new Date(since)}
    `;
    return String(rows[0]?.exposure ?? "0");
  }

  async getActivePolicy(ownerAddress: string, name: string): Promise<RiskPolicy | null> {
    await this.ready;
    const owner = requireOwnerAddress(ownerAddress);
    const rows = await this.sql`
      SELECT policy_document FROM wolv_agent_risk_policies
      WHERE owner_address = ${owner} AND policy_name = ${name} AND active = true
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0] ? parseJson<RiskPolicy>(rows[0].policy_document) : null;
  }

  private async runMigrations(): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
      await transaction`
        CREATE TABLE IF NOT EXISTS wolv_agent_memory_migrations (
          version integer PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      const existing = await transaction`SELECT version FROM wolv_agent_memory_migrations`;
      const applied = new Set(existing.map((row) => Number(row.version)));
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        for (const statement of migration.statements) await transaction.unsafe(statement);
        await transaction`INSERT INTO wolv_agent_memory_migrations (version) VALUES (${migration.version})`;
      }
    });
  }
}

export function getDefaultAgentMemoryStore(): AgentMemoryStore {
  return new AgentMemoryStore();
}

async function appendEventInTransaction(
  sql: Sql | postgres.TransactionSql,
  runId: string | null,
  event: AgentEventInput,
  explicitOwnerAddress?: string,
): Promise<string> {
  const runRows = runId === null
    ? []
    : await sql`SELECT owner_address FROM wolv_agent_runs WHERE run_id = ${runId} FOR UPDATE`;
  if (runId !== null && !runRows[0]) throw new AgentMemoryStoreError("NOT_FOUND");
  const ownerAddress = runRows[0]
    ? String(runRows[0].owner_address)
    : requireOwnerAddress(explicitOwnerAddress);
  if (event.idempotencyKey) {
    const existing = await sql`
      SELECT event_id FROM wolv_agent_events
      WHERE owner_address = ${ownerAddress} AND idempotency_key = ${event.idempotencyKey}
    `;
    if (existing[0]) return String(existing[0].event_id);
  }
  if (runId === null) {
    const rows = await sql`
      INSERT INTO wolv_agent_events (
        event_id, run_id, event_type, occurred_at, sequence_number, correlation_id,
        event_payload, source_provenance, previous_event_id, owner_address, idempotency_key
      ) VALUES (
        ${randomUUID()}, NULL, ${event.eventType}, ${new Date(event.occurredAt)}, 0,
        ${event.correlationId}, ${sql.json(jsonValue(event.payload))}, ${sql.json(jsonValue(event.provenance ?? {}))},
        NULL, ${ownerAddress}, ${event.idempotencyKey ?? null}
      ) RETURNING event_id
    `
    return String(rows[0].event_id);
  }
  const previous = await sql`
    SELECT event_id, sequence_number FROM wolv_agent_events
    WHERE run_id = ${runId} ORDER BY sequence_number DESC LIMIT 1
  `;
  const sequence = previous[0] ? Number(previous[0].sequence_number) + 1 : 1;
  const eventId = randomUUID();
  await sql`
    INSERT INTO wolv_agent_events (
      event_id, run_id, event_type, occurred_at, sequence_number, correlation_id,
      event_payload, source_provenance, previous_event_id, owner_address, idempotency_key
    ) VALUES (
      ${eventId}, ${runId}, ${event.eventType}, ${new Date(event.occurredAt)}, ${sequence},
      ${event.correlationId}, ${sql.json(jsonValue(event.payload))}, ${sql.json(jsonValue(event.provenance ?? {}))},
      ${previous[0]?.event_id ?? null}, ${ownerAddress}, ${event.idempotencyKey ?? null}
    )
  `;
  return eventId;
}

async function transitionRunInTransaction(
  sql: Sql | postgres.TransactionSql,
  runId: string,
  expectedState: AgentState,
  nextState: AgentState,
  occurredAt: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const rows = await sql`SELECT run_status FROM wolv_agent_runs WHERE run_id = ${runId} FOR UPDATE`;
  if (!rows[0]) throw new AgentMemoryStoreError("NOT_FOUND");
  const current = String(rows[0].run_status) as AgentState;
  if (current !== expectedState) throw new AgentMemoryStoreError("INVALID_TRANSITION");
  assertAgentTransition(current, nextState);
  const terminal = nextState === "COMPLETED" || nextState === "FAILED" || nextState === "STOPPED";
  await sql`
    UPDATE wolv_agent_runs
    SET run_status = ${nextState},
        ended_at = CASE WHEN ${terminal} THEN ${new Date(occurredAt)} ELSE ended_at END,
        termination_reason = CASE WHEN ${terminal} THEN ${String(payload.reason ?? nextState)} ELSE termination_reason END
    WHERE run_id = ${runId}
  `;
  await appendEventInTransaction(sql, runId, {
    eventType: "STATE_CHANGED",
    occurredAt,
    correlationId: runId,
    payload: { ...payload, from: current, to: nextState },
    provenance: { source: "agent-orchestrator" },
  });
}

function jsonValue(value: unknown): postgres.JSONValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Persisted JSON value is not serializable.");
  return JSON.parse(serialized) as postgres.JSONValue;
}

function hashJson(value: unknown): string {
  return createSnapshotHash(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOwnerAddress(value: string | undefined): string {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new TypeError("A valid wallet owner is required to access agent memory.");
  }
  return value.toLowerCase();
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      Boolean(url.hostname) && Boolean(url.pathname.slice(1));
  } catch {
    return false;
  }
}

function isLocalDevelopmentUrl(value: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return value;
}

function encodeCursor(timestamp: string, eventId: string): string {
  return Buffer.from(`${timestamp}\n${eventId}`).toString("base64url");
}

function parseCursor(value: string): { timestamp: string; eventId: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new TypeError("Activity cursor is invalid.");
  }
  const [timestamp, eventId, extra] = decoded.split("\n");
  if (extra !== undefined || !Number.isFinite(Date.parse(timestamp)) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) {
    throw new TypeError("Activity cursor is invalid.");
  }
  return { timestamp, eventId };
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ]));
}

function parseJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  if (typeof value === "object" && value !== null) return value as T;
  throw new Error("Persisted JSON value is invalid.");
}

function isPostgresConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "23505" || error.code === "23514");
}
