import "server-only";
import type { Address, PublicClient } from "viem";
import { getAddress } from "viem";
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN } from "./apiValidation.ts";
import {
  markInvalidRpcResponse,
  runRpcRead,
  type RpcRequestDiagnostic,
} from "./bscRpcReliability.ts";

export const RECORDED_METADATA_BLOCK = BigInt(131014770);
export const RECORDED_METADATA_BLOCK_HASH =
  "0x993c869807f1090f1642ef6f9a607770eb051406fcd6d9ab03cc310a676fd36e";
export const RECORDED_PROBE_TOKEN_ADDRESSES = [
  "0xe614e2fc6c787035ff51f452e8e826bfd32d5283",
  "0x282973969118f9fe39bf2ff3d8dd1efee82ccb11",
] as const;

const DECIMALS_ABI = [{
  type: "function",
  name: "decimals",
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint8" }],
}] as const;
const MAX_SUPPORTED_DECIMALS = 18;

export type RecordedProbeTarget = {
  label: "USDT" | "previously-successful" | "previously-failed";
  address: Address;
};

export type RecordedProbeRpcClient = Pick<
  PublicClient,
  "getChainId" | "getBlock" | "getBytecode" | "readContract"
>;

export type RecordedProbeResult = {
  status: "MOCK_VERIFIED" | "LIVE_VERIFIED_SINGLE_RPC" | "UNVERIFIED";
  chainId: number | null;
  blockNumber: string;
  expectedBlockHash: string;
  observedBlockHash: string | null;
  rpcVerificationCount: 1;
  requestDiagnostics: RpcRequestDiagnostic[];
  targets: Array<{
    label: RecordedProbeTarget["label"];
    tokenAddress: string;
    status: "VERIFIED" | "UNSUPPORTED" | "UNVERIFIED";
    contractCodePresent: boolean | null;
    decimals: number | null;
    errorClassification: string | null;
    requestDiagnostics: RpcRequestDiagnostic[];
  }>;
  errorClassification: string | null;
};

export function getRecordedProbeTargets(audit: unknown): RecordedProbeTarget[] {
  if (!isRecord(audit) || !Array.isArray(audit.assets) ||
    audit.blockNumber !== RECORDED_METADATA_BLOCK.toString() ||
    audit.blockHash !== RECORDED_METADATA_BLOCK_HASH) {
    throw new Error("Recorded audit does not match the approved block provenance.");
  }
  const auditedAddresses = new Set(
    audit.assets.flatMap((asset) =>
      isRecord(asset) && typeof asset.tokenAddress === "string"
        ? [asset.tokenAddress.toLowerCase()]
        : [],
    ),
  );
  for (const address of RECORDED_PROBE_TOKEN_ADDRESSES) {
    if (!auditedAddresses.has(address)) {
      throw new Error("A fixed diagnostic token is absent from the recorded audit.");
    }
  }
  if (typeof audit.usdt !== "object" || audit.usdt === null ||
    !isRecord(audit.usdt) ||
    typeof audit.usdt.tokenAddress !== "string" ||
    audit.usdt.tokenAddress.toLowerCase() !== BSC_USDT_ADDRESS.toLowerCase()) {
    throw new Error("Configured USDT does not match the recorded audit target.");
  }
  return [
    { label: "USDT", address: getAddress(BSC_USDT_ADDRESS) },
    ...RECORDED_PROBE_TOKEN_ADDRESSES.map((address, index) => ({
      label: index === 0 ? "previously-successful" as const : "previously-failed" as const,
      address: getAddress(address),
    })),
  ];
}

export async function probeRecordedBlock(input: {
  client: RecordedProbeRpcClient;
  targets: RecordedProbeTarget[];
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}): Promise<RecordedProbeResult> {
  validateTargets(input.targets);
  const requestDiagnostics: RpcRequestDiagnostic[] = [];
  const base = {
    chainId: null as number | null,
    blockNumber: RECORDED_METADATA_BLOCK.toString(),
    expectedBlockHash: RECORDED_METADATA_BLOCK_HASH,
    observedBlockHash: null as string | null,
    rpcVerificationCount: 1 as const,
    requestDiagnostics,
  };
  const retryOptions = {
    maxRetries: input.maxRetries,
    sleep: input.sleep,
    random: input.random,
  };
  const chainRead = await runRpcRead({
    method: "eth_chainId",
    stage: "BLOCK",
    operation: () => input.client.getChainId(),
    ...retryOptions,
  });
  requestDiagnostics.push(...chainRead.diagnostics);
  if (!chainRead.ok) {
    return {
      ...base,
      status: "UNVERIFIED",
      targets: input.targets.map((target) => emptyTarget(target, "UNVERIFIED", chainRead.diagnostic.errorClass)),
      errorClassification: chainRead.diagnostic.errorClass,
    };
  }
  if (chainRead.value !== 56) {
    return {
      ...base,
      status: "UNVERIFIED",
      chainId: chainRead.value,
      targets: input.targets.map((target) => emptyTarget(target, "UNVERIFIED", "CHAIN_ID_MISMATCH")),
      errorClassification: "CHAIN_ID_MISMATCH",
    };
  }

  const blockRead = await runRpcRead({
    method: "eth_getBlockByNumber",
    stage: "BLOCK",
    operation: () => input.client.getBlock({ blockNumber: RECORDED_METADATA_BLOCK }),
    ...retryOptions,
  });
  requestDiagnostics.push(...blockRead.diagnostics);
  if (!blockRead.ok) {
    return {
      ...base,
      status: "UNVERIFIED",
      chainId: 56,
      targets: input.targets.map((target) => emptyTarget(target, "UNVERIFIED", blockRead.diagnostic.errorClass)),
      errorClassification: blockRead.diagnostic.errorClass,
    };
  }
  const observedBlockHash = normalizeBlockHash(blockRead.value.hash);
  if (!observedBlockHash || observedBlockHash !== RECORDED_METADATA_BLOCK_HASH) {
    return {
      ...base,
      status: "UNVERIFIED",
      chainId: 56,
      observedBlockHash,
      targets: input.targets.map((target) => emptyTarget(
        target,
        "UNVERIFIED",
        observedBlockHash ? "BLOCK_HASH_MISMATCH" : "INVALID_RPC_RESPONSE",
      )),
      errorClassification: observedBlockHash ? "BLOCK_HASH_MISMATCH" : "INVALID_RPC_RESPONSE",
    };
  }

  const targets = [];
  for (const target of input.targets) {
    const targetDiagnostics: RpcRequestDiagnostic[] = [];
    const codeRead = await runRpcRead({
      method: "eth_getCode",
      stage: "BYTECODE",
      operation: () => input.client.getBytecode({
        address: target.address,
        blockNumber: RECORDED_METADATA_BLOCK,
      }),
      ...retryOptions,
    });
    targetDiagnostics.push(...codeRead.diagnostics);
    if (!codeRead.ok) {
      targets.push(emptyTarget(target, "UNVERIFIED", codeRead.diagnostic.errorClass, targetDiagnostics));
      continue;
    }
    const code = codeRead.value;
    if (typeof code !== "string" || !/^0x(?:[a-fA-F0-9]{2})*$/.test(code)) {
      targets.push(emptyTarget(
        target,
        "UNVERIFIED",
        "INVALID_RPC_RESPONSE",
        markInvalidRpcResponse(targetDiagnostics),
      ));
      continue;
    }
    if (code === "0x") {
      targets.push(emptyTarget(target, "UNSUPPORTED", "MISSING_CONTRACT_CODE", targetDiagnostics, false));
      continue;
    }
    const decimalsRead = await runRpcRead({
      method: "eth_call",
      stage: "DECIMALS",
      operation: () => input.client.readContract({
        address: target.address,
        abi: DECIMALS_ABI,
        functionName: "decimals",
        blockNumber: RECORDED_METADATA_BLOCK,
      }),
      ...retryOptions,
    });
    targetDiagnostics.push(...decimalsRead.diagnostics);
    if (!decimalsRead.ok) {
      targets.push(emptyTarget(target, "UNVERIFIED", decimalsRead.diagnostic.errorClass, targetDiagnostics, true));
      continue;
    }
    const decimals: unknown = decimalsRead.value;
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      targets.push(emptyTarget(
        target,
        "UNVERIFIED",
        "INVALID_RPC_RESPONSE",
        markInvalidRpcResponse(targetDiagnostics),
        true,
      ));
      continue;
    }
    if (decimals > MAX_SUPPORTED_DECIMALS) {
      targets.push({
        ...emptyTarget(target, "UNSUPPORTED", "DECIMALS_OUTSIDE_WOLV_RANGE", targetDiagnostics, true),
        decimals,
      });
      continue;
    }
    targets.push({
      ...emptyTarget(target, "VERIFIED", null, targetDiagnostics, true),
      decimals,
    });
  }

  return {
    ...base,
    status: targets.every((target) => target.status === "VERIFIED")
      ? "LIVE_VERIFIED_SINGLE_RPC"
      : "UNVERIFIED",
    chainId: 56,
    observedBlockHash,
    targets,
    errorClassification: targets.find((target) => target.errorClassification)?.errorClassification ?? null,
  };
}

function validateTargets(targets: RecordedProbeTarget[]): void {
  const expected = new Map<string, RecordedProbeTarget["label"]>([
    [BSC_USDT_ADDRESS.toLowerCase(), "USDT"],
    [RECORDED_PROBE_TOKEN_ADDRESSES[0], "previously-successful"],
    [RECORDED_PROBE_TOKEN_ADDRESSES[1], "previously-failed"],
  ]);
  if (targets.length !== 3 ||
    new Set(targets.map((target) => target.address.toLowerCase())).size !== 3 ||
    targets.some((target) =>
      !EVM_ADDRESS_PATTERN.test(target.address) ||
      expected.get(target.address.toLowerCase()) !== target.label
    )) {
    throw new Error("Probe targets must be the fixed USDT and two audit-confirmed catalogue assets.");
  }
}

function emptyTarget(
  target: RecordedProbeTarget,
  status: RecordedProbeResult["targets"][number]["status"],
  errorClassification: string | null,
  requestDiagnostics: RpcRequestDiagnostic[] = [],
  contractCodePresent: boolean | null = null,
) {
  return {
    label: target.label,
    tokenAddress: target.address,
    status,
    contractCodePresent,
    decimals: null,
    errorClassification,
    requestDiagnostics,
  };
}

function normalizeBlockHash(value: unknown): string | null {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
