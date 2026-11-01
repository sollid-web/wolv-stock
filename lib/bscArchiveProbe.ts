import "server-only";
import { createHash } from "node:crypto";
import type { PublicClient } from "viem";
import {
  RECORDED_METADATA_BLOCK,
  RECORDED_METADATA_BLOCK_HASH,
  type RecordedProbeTarget,
} from "./bscMetadataProbe.ts";
import {
  markInvalidRpcResponse,
  runRpcRead,
  type RpcRequestDiagnostic,
} from "./bscRpcReliability.ts";

const DECIMALS_ABI = [{
  type: "function",
  name: "decimals",
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint8" }],
}] as const;
const MAX_SUPPORTED_DECIMALS = 18;

export type ArchiveProbeRpcClient = Pick<
  PublicClient,
  "getChainId" | "getBlockNumber" | "getBlock" | "getBytecode" | "readContract"
>;

type EndpointProbe = {
  chainId: number | null;
  latestBlockNumber: string | null;
  latestBlockHash: string | null;
  historicalBlockHash: string | null;
  requestDiagnostics: RpcRequestDiagnostic[];
  targets: Array<{
    label: RecordedProbeTarget["label"];
    tokenAddress: string;
    current: ProbeRead;
    historical: ProbeRead;
  }>;
  errorClassification: string | null;
};

type ProbeRead = {
  contractCodePresent: boolean | null;
  contractCodeSha256: string | null;
  decimals: number | null;
  status: "VERIFIED" | "UNSUPPORTED" | "UNVERIFIED";
  errorClassification: string | null;
  requestDiagnostics: RpcRequestDiagnostic[];
};

export type ArchiveStateProbeResult = {
  status: "HISTORICAL_STATE_ACCESS_VERIFIED_FOR_PROBE_TARGETS" |
    "HISTORICAL_STATE_CROSS_VERIFIED_FOR_PROBE_TARGETS" |
    "ARCHIVE_STATE_ACCESS_NOT_ESTABLISHED";
  targetBlockNumber: string;
  targetBlockHash: string;
  primaryRpcIdentity: string;
  archiveRpcIdentity: string | null;
  providerIndependence: "OPERATOR_ATTESTED_INDEPENDENT" | "NOT_ESTABLISHED";
  primary: EndpointProbe;
  archive: EndpointProbe | null;
  targetComparisons: Array<{
    label: RecordedProbeTarget["label"];
    tokenAddress: string;
    currentState: ProbeRead;
    primaryHistorical: ProbeRead;
    archiveHistorical: ProbeRead | null;
    providersAgree: boolean | null;
  }>;
};

export async function diagnoseArchiveState(input: {
  primary: {
    client: ArchiveProbeRpcClient;
    identity: string;
    operator: string;
  };
  archive?: {
    client: ArchiveProbeRpcClient;
    identity: string;
    operator: string;
    independenceAttested?: boolean;
  };
  targets: RecordedProbeTarget[];
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}): Promise<ArchiveStateProbeResult> {
  validateTargets(input.targets);
  const retryOptions = { maxRetries: 0, sleep: input.sleep, random: input.random };
  const primary = await probeEndpoint(input.primary.client, input.targets, true, retryOptions);
  const archive = input.archive
    ? await probeEndpoint(input.archive.client, input.targets, false, retryOptions)
    : null;
  const independent = Boolean(
    input.archive?.operator.trim() &&
    input.primary.operator.trim() &&
    input.archive.operator.trim().toLowerCase() !== input.primary.operator.trim().toLowerCase() &&
    input.archive.independenceAttested === true,
  );
  const blockConsistent = Boolean(
    archive &&
    primary.historicalBlockHash === RECORDED_METADATA_BLOCK_HASH &&
    archive.historicalBlockHash === RECORDED_METADATA_BLOCK_HASH,
  );
  const targetComparisons = input.targets.map((target, index) => {
    const currentState = primary.targets[index].current;
    const primaryHistorical = primary.targets[index].historical;
    const archiveHistorical = archive?.targets[index].historical ?? null;
    const providersAgree = archiveHistorical && independent && blockConsistent
      ? readsAgree(primaryHistorical, archiveHistorical)
      : null;
    return {
      label: target.label,
      tokenAddress: target.address,
      currentState,
      primaryHistorical,
      archiveHistorical,
      providersAgree,
    };
  });
  const allPrimaryHistoricalVerified = primary.historicalBlockHash === RECORDED_METADATA_BLOCK_HASH &&
    primary.targets.every((target) => stateReadEstablished(target.historical));
  const allArchiveHistoricalVerified = Boolean(
    archive &&
    archive.historicalBlockHash === RECORDED_METADATA_BLOCK_HASH &&
    archive.targets.every((target) => stateReadEstablished(target.historical)),
  );
  const status = allPrimaryHistoricalVerified
    ? "HISTORICAL_STATE_ACCESS_VERIFIED_FOR_PROBE_TARGETS"
    : allArchiveHistoricalVerified
      ? "HISTORICAL_STATE_ACCESS_VERIFIED_FOR_PROBE_TARGETS"
      : "ARCHIVE_STATE_ACCESS_NOT_ESTABLISHED";
  const crossVerified = independent && blockConsistent && targetComparisons.every((target) =>
    target.providersAgree === true
  );
  return {
    status: crossVerified
      ? "HISTORICAL_STATE_CROSS_VERIFIED_FOR_PROBE_TARGETS"
      : status,
    targetBlockNumber: RECORDED_METADATA_BLOCK.toString(),
    targetBlockHash: RECORDED_METADATA_BLOCK_HASH,
    primaryRpcIdentity: input.primary.identity,
    archiveRpcIdentity: input.archive?.identity ?? null,
    providerIndependence: independent ? "OPERATOR_ATTESTED_INDEPENDENT" : "NOT_ESTABLISHED",
    primary,
    archive,
    targetComparisons,
  };
}

async function probeEndpoint(
  client: ArchiveProbeRpcClient,
  targets: RecordedProbeTarget[],
  includeLatest: boolean,
  retryOptions: {
    maxRetries: number;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
  },
): Promise<EndpointProbe> {
  const requestDiagnostics: RpcRequestDiagnostic[] = [];
  const chainRead = await runRpcRead({
    method: "eth_chainId",
    stage: "BLOCK",
    operation: () => client.getChainId(),
    ...retryOptions,
  });
  requestDiagnostics.push(...chainRead.diagnostics);
  if (!chainRead.ok || chainRead.value !== 56) {
    const error = chainRead.ok ? "CHAIN_ID_MISMATCH" : chainRead.diagnostic.errorClass;
    return failedEndpoint(targets, error, chainRead.ok ? chainRead.value : null, requestDiagnostics);
  }

  let latestBlockNumber: bigint | null = null;
  let latestBlockHash: string | null = null;
  if (includeLatest) {
    const latestRead = await runRpcRead({
      method: "eth_blockNumber",
      stage: "BLOCK",
      operation: () => client.getBlockNumber(),
      ...retryOptions,
    });
    requestDiagnostics.push(...latestRead.diagnostics);
    if (!latestRead.ok) {
      return failedEndpoint(targets, latestRead.diagnostic.errorClass, 56, requestDiagnostics);
    }
    latestBlockNumber = latestRead.value;
    const latestHeader = await readBlock(client, latestBlockNumber, requestDiagnostics, retryOptions);
    if (!latestHeader.ok) {
      return failedEndpoint(targets, latestHeader.error, 56, requestDiagnostics);
    }
    latestBlockHash = latestHeader.hash;
  }

  const historicHeader = await readBlock(
    client,
    RECORDED_METADATA_BLOCK,
    requestDiagnostics,
    retryOptions,
  );
  const historicalBlockHash = historicHeader.hash;
  const targetsResult = [];
  for (const target of targets) {
    const current = includeLatest && latestBlockNumber !== null
      ? await readCodeAndDecimals(client, target, latestBlockNumber, false, retryOptions)
      : emptyRead("UNVERIFIED", "NOT_REQUESTED");
    const historical = historicHeader.ok
      ? await readCodeAndDecimals(client, target, RECORDED_METADATA_BLOCK, true, retryOptions)
      : emptyRead("UNVERIFIED", historicHeader.error);
    targetsResult.push({ label: target.label, tokenAddress: target.address, current, historical });
  }
  return {
    chainId: 56,
    latestBlockNumber: latestBlockNumber?.toString() ?? null,
    latestBlockHash,
    historicalBlockHash,
    requestDiagnostics,
    targets: targetsResult,
    errorClassification: historicHeader.ok ? null : historicHeader.error,
  };
}

async function readBlock(
  client: ArchiveProbeRpcClient,
  blockNumber: bigint,
  diagnostics: RpcRequestDiagnostic[],
  retryOptions: {
    maxRetries: number;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
  },
): Promise<{ ok: true; hash: string } | { ok: false; error: string; hash: string | null }> {
  const blockRead = await runRpcRead({
    method: "eth_getBlockByNumber",
    stage: "BLOCK",
    operation: () => client.getBlock({ blockNumber }),
    ...retryOptions,
  });
  diagnostics.push(...blockRead.diagnostics);
  if (!blockRead.ok) return { ok: false, error: blockRead.diagnostic.errorClass, hash: null };
  const hash = normalizeBlockHash(blockRead.value.hash);
  if (!hash) {
    const invalid = markInvalidRpcResponse([blockRead.diagnostics.at(-1)!])[0];
    diagnostics[diagnostics.length - 1] = invalid;
    return { ok: false, error: "INVALID_RPC_RESPONSE", hash: null };
  }
  if (blockNumber === RECORDED_METADATA_BLOCK && hash !== RECORDED_METADATA_BLOCK_HASH) {
    return { ok: false, error: "BLOCK_HASH_MISMATCH", hash };
  }
  return { ok: true, hash };
}

async function readCodeAndDecimals(
  client: ArchiveProbeRpcClient,
  target: RecordedProbeTarget,
  blockNumber: bigint,
  readDecimals: boolean,
  retryOptions: {
    maxRetries: number;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
  },
): Promise<ProbeRead> {
  const diagnostics: RpcRequestDiagnostic[] = [];
  const codeRead = await runRpcRead({
    method: "eth_getCode",
    stage: "BYTECODE",
    operation: () => client.getBytecode({ address: target.address, blockNumber }),
    ...retryOptions,
  });
  diagnostics.push(...codeRead.diagnostics);
  if (!codeRead.ok) return emptyRead("UNVERIFIED", codeRead.diagnostic.errorClass, diagnostics);
  const code = codeRead.value;
  if (typeof code !== "string" || !/^0x(?:[a-fA-F0-9]{2})*$/.test(code)) {
    return emptyRead(
      "UNVERIFIED",
      "INVALID_RPC_RESPONSE",
      markInvalidRpcResponse(diagnostics),
    );
  }
  if (code === "0x") {
    return {
      ...emptyRead("UNSUPPORTED", "MISSING_CONTRACT_CODE", diagnostics),
      contractCodePresent: false,
    };
  }
  const contractCodeSha256 = createHash("sha256").update(code).digest("hex");
  if (!readDecimals) {
    return {
      contractCodePresent: true,
      contractCodeSha256,
      decimals: null,
      status: "VERIFIED",
      errorClassification: null,
      requestDiagnostics: diagnostics,
    };
  }
  const decimalRead = await runRpcRead({
    method: "eth_call",
    stage: "DECIMALS",
    operation: () => client.readContract({
      address: target.address,
      abi: DECIMALS_ABI,
      functionName: "decimals",
      blockNumber,
    }),
    ...retryOptions,
  });
  diagnostics.push(...decimalRead.diagnostics);
  if (!decimalRead.ok) {
    return {
      ...emptyRead("UNVERIFIED", decimalRead.diagnostic.errorClass, diagnostics),
      contractCodePresent: true,
      contractCodeSha256,
    };
  }
  const decimals: unknown = decimalRead.value;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return {
      ...emptyRead("UNVERIFIED", "INVALID_RPC_RESPONSE", markInvalidRpcResponse(diagnostics)),
      contractCodePresent: true,
      contractCodeSha256,
    };
  }
  if (decimals > MAX_SUPPORTED_DECIMALS) {
    return {
      ...emptyRead("UNSUPPORTED", "DECIMALS_OUTSIDE_WOLV_RANGE", diagnostics),
      contractCodePresent: true,
      contractCodeSha256,
      decimals,
    };
  }
  return {
    contractCodePresent: true,
    contractCodeSha256,
    decimals,
    status: "VERIFIED",
    errorClassification: null,
    requestDiagnostics: diagnostics,
  };
}

function failedEndpoint(
  targets: RecordedProbeTarget[],
  error: string,
  chainId: number | null,
  requestDiagnostics: RpcRequestDiagnostic[],
): EndpointProbe {
  return {
    chainId,
    latestBlockNumber: null,
    latestBlockHash: null,
    historicalBlockHash: null,
    requestDiagnostics,
    targets: targets.map((target) => ({
      label: target.label,
      tokenAddress: target.address,
      current: emptyRead("UNVERIFIED", error),
      historical: emptyRead("UNVERIFIED", error),
    })),
    errorClassification: error,
  };
}

function emptyRead(
  status: ProbeRead["status"],
  errorClassification: string,
  requestDiagnostics: RpcRequestDiagnostic[] = [],
): ProbeRead {
  return {
    contractCodePresent: null,
    contractCodeSha256: null,
    decimals: null,
    status,
    errorClassification,
    requestDiagnostics,
  };
}

function readsAgree(first: ProbeRead, second: ProbeRead): boolean {
  return stateReadEstablished(first) &&
    stateReadEstablished(second) &&
    first.contractCodeSha256 === second.contractCodeSha256 &&
    first.contractCodePresent === second.contractCodePresent &&
    first.decimals === second.decimals;
}

function stateReadEstablished(read: ProbeRead): boolean {
  return read.status === "VERIFIED" ||
    (read.status === "UNSUPPORTED" &&
      (read.errorClassification === "MISSING_CONTRACT_CODE" ||
        read.errorClassification === "DECIMALS_OUTSIDE_WOLV_RANGE"));
}

function validateTargets(targets: RecordedProbeTarget[]): void {
  const allowed = new Set([
    "0x55d398326f99059ff775485246999027b3197955",
    "0xe614e2fc6c787035ff51f452e8e826bfd32d5283",
    "0x282973969118f9fe39bf2ff3d8dd1efee82ccb11",
  ]);
  if (targets.length !== 3 || new Set(targets.map((target) => target.address.toLowerCase())).size !== 3 ||
    targets.some((target) => !allowed.has(target.address.toLowerCase()))) {
    throw new Error("Archive probe accepts only the three fixed Phase 3.15 addresses.");
  }
}

function normalizeBlockHash(value: unknown): string | null {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}
