import "server-only";
import { createHash } from "node:crypto";
import { getAddress } from "viem";
import type { Address, PublicClient } from "viem";
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN } from "./apiValidation.ts";
import {
  mapWithConcurrency,
  markInvalidRpcResponse,
  runRpcRead,
  MAX_AUDIT_CONCURRENCY,
  type RpcRequestDiagnostic,
} from "./bscRpcReliability.ts";
import { isSpotEligibleAsset } from "./compliance.ts";
import { isRwaAssetListResponse, parseRwaAssetRecords } from "./rwaAssetResponse.ts";

const MAX_SUPPORTED_DECIMALS = 18;
const DECIMALS_ABI = [{
  type: "function",
  name: "decimals",
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint8" }],
}] as const;

export type BscAuditRpcClient = Pick<
  PublicClient,
  "getChainId" | "getBlockNumber" | "getBlock" | "getBytecode" | "readContract"
>;

export type BscAuditRpc = {
  id: string;
  operator: string;
  client: BscAuditRpcClient;
};

export type BscMetadataAuditStatus =
  | "LIVE_VERIFIED_SINGLE_RPC"
  | "LIVE_VERIFIED_CROSS_RPC"
  | "MOCK_VERIFIED"
  | "UNSUPPORTED"
  | "RPC_DIVERGENCE"
  | "UNVERIFIED";

export type BscMetadataAuditContract = {
  symbol: string | null;
  tokenAddress: string;
  eligibility: "ELIGIBLE" | "USDT_AUDIT_TARGET";
  status: BscMetadataAuditStatus;
  chainId: number | null;
  blockNumber: string | null;
  blockHash: string | null;
  contractCodePresent: boolean | null;
  contractCodeSha256: string | null;
  decimals: number | null;
  rpcVerificationCount: number;
  errorClassification: string | null;
  rpcDiagnostics: RpcRequestDiagnostic[];
  catalogueDecimals: unknown;
};

export type BscMetadataAuditResult = {
  status: BscMetadataAuditStatus;
  auditTimestamp: string;
  catalogueSource: string;
  catalogueSnapshotSha256: string;
  eligibleAssetCount: number;
  duplicateEligibleAddressCount: number;
  chainId: number | null;
  blockNumber: string | null;
  blockHash: string | null;
  primaryRpcId: string;
  secondaryRpcId: string | null;
  rpcVerificationCount: number;
  concurrency: number;
  rpcBlockHashes: Record<string, string | null>;
  assets: BscMetadataAuditContract[];
  usdt: BscMetadataAuditContract;
};

export class BscMetadataAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BscMetadataAuditError";
  }
}

export async function auditBscCatalogueMetadata(
  catalogueResponse: unknown,
  options: {
    primary: BscAuditRpc;
    secondary?: BscAuditRpc;
    now?: () => number;
    evidenceMode?: "LIVE" | "MOCK";
    maxRetries?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    concurrency?: number;
  },
): Promise<BscMetadataAuditResult> {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_AUDIT_CONCURRENCY) {
    throw new BscMetadataAuditError(`Audit concurrency must be between 1 and ${MAX_AUDIT_CONCURRENCY}.`);
  }
  if (!isRwaAssetListResponse(catalogueResponse, { allowEmpty: true })) {
    throw new BscMetadataAuditError("The RWA catalogue response has an unexpected shape.");
  }
  const rawRecords = catalogueResponse.data;
  const records = parseRwaAssetRecords(catalogueResponse);
  const eligible = records.filter(isSpotEligibleAsset);
  const eligibleAddressCounts = new Map<string, number>();
  for (const asset of eligible) {
    const key = asset.tokenContractAddress.toLowerCase();
    eligibleAddressCounts.set(key, (eligibleAddressCounts.get(key) ?? 0) + 1);
  }
  const duplicates = new Set(
    [...eligibleAddressCounts].filter(([, count]) => count > 1).map(([address]) => address),
  );
  const rawByAddress = new Map<string, Record<string, unknown>[]>();
  for (const raw of rawRecords) {
    if (!isRecord(raw) || typeof raw.tokenContractAddress !== "string") continue;
    const key = raw.tokenContractAddress.toLowerCase();
    rawByAddress.set(key, [...(rawByAddress.get(key) ?? []), raw]);
  }
  const snapshot = records.map((asset) => ({
    tokenContractAddress: asset.tokenContractAddress,
    underlyingTicker: asset.underlyingTicker,
    platformId: asset.platformId,
    symbol: asset.symbol ?? null,
    eligible: isSpotEligibleAsset(asset),
    ...(rawCatalogueDecimals(rawByAddress.get(asset.tokenContractAddress.toLowerCase()) ?? []).present
      ? { catalogueDecimals: rawCatalogueDecimals(rawByAddress.get(asset.tokenContractAddress.toLowerCase()) ?? []).value }
      : {}),
  }));
  const catalogueSnapshotSha256 = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  const primary = options.primary;
  const primaryChainId = await primary.client.getChainId();
  if (primaryChainId !== 56) {
    throw new BscMetadataAuditError("The primary RPC did not report BSC mainnet chain ID 56.");
  }
  const blockNumber = await primary.client.getBlockNumber();
  const primaryBlock = await primary.client.getBlock({ blockNumber });
  const primaryBlockHash = normalizeBlockHash(primaryBlock.hash);
  if (!primaryBlockHash) {
    throw new BscMetadataAuditError("The primary RPC did not return a valid hash for the audit block.");
  }

  const secondary = hasIndependentOperator(primary, options.secondary)
    ? options.secondary
    : undefined;
  let secondaryBlockHash: string | null = null;
  let secondaryFailure: string | null = null;
  let networkDivergence = false;
  if (secondary) {
    try {
      if (await secondary.client.getChainId() !== 56) {
        secondaryFailure = "SECONDARY_CHAIN_ID_MISMATCH";
        networkDivergence = true;
      } else {
        const secondaryBlock = await secondary.client.getBlock({ blockNumber });
        secondaryBlockHash = normalizeBlockHash(secondaryBlock.hash);
        if (!secondaryBlockHash) {
          secondaryFailure = "SECONDARY_BLOCK_HASH_MISSING";
          networkDivergence = true;
        } else if (secondaryBlockHash !== primaryBlockHash) {
          secondaryFailure = "BLOCK_HASH_MISMATCH";
          networkDivergence = true;
        }
      }
    } catch {
      secondaryFailure = "SECONDARY_BLOCK_READ_FAILED";
    }
  }

  const sameBlock = Boolean(secondary && !secondaryFailure && !networkDivergence);
  const rpcBlockHashes: Record<string, string | null> = {
    [primary.id]: primaryBlockHash,
    ...(secondary ? { [secondary.id]: secondaryBlockHash } : {}),
  };
  const assets = await mapWithConcurrency(eligible, concurrency, async (asset) => {
    const address = asset.tokenContractAddress;
    const addressKey = address.toLowerCase();
    if (duplicates.has(addressKey)) {
      return emptyContractResult(asset.symbol ?? null, address, "UNSUPPORTED", "DUPLICATE_ELIGIBLE_ADDRESS", 0);
    }
    const catalogueDecimal = rawCatalogueDecimals(rawByAddress.get(addressKey) ?? []);
    let checksummedAddress: Address;
    try {
      if (!EVM_ADDRESS_PATTERN.test(address)) throw new Error("invalid");
      checksummedAddress = getAddress(address);
    } catch {
      return emptyContractResult(asset.symbol ?? null, address, "UNSUPPORTED", "INVALID_CATALOGUE_ADDRESS", 0);
    }
    const primaryResult = await readAtBlock(primary.client, checksummedAddress, blockNumber, {
      maxRetries: options.maxRetries,
      sleep: options.sleep,
      random: options.random,
    });
    if (primaryResult.error) {
      const status = primaryResult.error === "MISSING_CONTRACT_CODE" ||
        primaryResult.error === "DECIMALS_OUTSIDE_WOLV_RANGE"
        ? "UNSUPPORTED"
        : "UNVERIFIED";
      return {
        ...emptyContractResult(asset.symbol ?? null, address, status, primaryResult.error, 1),
        chainId: 56,
        blockNumber: blockNumber.toString(),
        blockHash: primaryBlockHash,
        contractCodePresent: primaryResult.contractCodePresent,
        contractCodeSha256: primaryResult.contractCodeSha256,
        decimals: primaryResult.decimals,
        rpcDiagnostics: primaryResult.diagnostics,
        catalogueDecimals: catalogueDecimal.present ? catalogueDecimal.value : null,
      };
    }
    if (catalogueDecimal.present && !metadataMatchesCatalogue(primaryResult.decimals!, catalogueDecimal.value)) {
      return {
        ...emptyContractResult(asset.symbol ?? null, address, "UNSUPPORTED", "CATALOGUE_DECIMALS_CONFLICT", 1),
        chainId: 56,
        blockNumber: blockNumber.toString(),
        blockHash: primaryBlockHash,
        contractCodePresent: true,
        contractCodeSha256: primaryResult.contractCodeSha256,
        decimals: primaryResult.decimals,
        rpcDiagnostics: primaryResult.diagnostics,
        catalogueDecimals: catalogueDecimal.value,
      };
    }
    if (networkDivergence) {
      return {
        ...emptyContractResult(asset.symbol ?? null, address, "RPC_DIVERGENCE", secondaryFailure, 1),
        chainId: 56,
        blockNumber: blockNumber.toString(),
        blockHash: primaryBlockHash,
        contractCodePresent: true,
        contractCodeSha256: primaryResult.contractCodeSha256,
        decimals: primaryResult.decimals,
        rpcDiagnostics: primaryResult.diagnostics,
        catalogueDecimals: catalogueDecimal.present ? catalogueDecimal.value : null,
      };
    }
    if (sameBlock && secondary) {
      const secondaryResult = await readAtBlock(secondary.client, checksummedAddress, blockNumber, {
        maxRetries: options.maxRetries,
        sleep: options.sleep,
        random: options.random,
      });
      if (secondaryResult.error) {
        return {
          ...emptyContractResult(asset.symbol ?? null, address, "UNVERIFIED", `SECONDARY_${secondaryResult.error}`, 1),
          chainId: 56,
          blockNumber: blockNumber.toString(),
          blockHash: primaryBlockHash,
          contractCodePresent: true,
          contractCodeSha256: primaryResult.contractCodeSha256,
          decimals: primaryResult.decimals,
          rpcDiagnostics: [...primaryResult.diagnostics, ...secondaryResult.diagnostics],
          catalogueDecimals: catalogueDecimal.present ? catalogueDecimal.value : null,
        };
      }
      if (secondaryResult.contractCodeSha256 !== primaryResult.contractCodeSha256 ||
          secondaryResult.decimals !== primaryResult.decimals) {
        return {
          ...emptyContractResult(asset.symbol ?? null, address, "RPC_DIVERGENCE", secondaryResult.error ?? "CONTRACT_RESULT_MISMATCH", 2),
          chainId: 56,
          blockNumber: blockNumber.toString(),
          blockHash: primaryBlockHash,
          contractCodePresent: true,
          contractCodeSha256: primaryResult.contractCodeSha256,
          decimals: primaryResult.decimals,
          rpcDiagnostics: [...primaryResult.diagnostics, ...secondaryResult.diagnostics],
          catalogueDecimals: catalogueDecimal.present ? catalogueDecimal.value : null,
        };
      }
    }
    return {
      symbol: asset.symbol ?? null,
      tokenAddress: address,
      eligibility: "ELIGIBLE" as const,
      status: verifiedStatus(options.evidenceMode, sameBlock),
      chainId: 56,
      blockNumber: blockNumber.toString(),
      blockHash: primaryBlockHash,
      contractCodePresent: true,
      contractCodeSha256: primaryResult.contractCodeSha256,
      decimals: primaryResult.decimals,
      rpcDiagnostics: primaryResult.diagnostics,
      rpcVerificationCount: sameBlock ? 2 : 1,
      errorClassification: secondaryFailure,
      catalogueDecimals: catalogueDecimal.present ? catalogueDecimal.value : null,
    };
  });

  const usdt = await auditUsdt({
    primary,
    secondary,
    sameBlock,
    networkDivergence,
    secondaryFailure,
    blockNumber,
    blockHash: primaryBlockHash,
    evidenceMode: options.evidenceMode,
    maxRetries: options.maxRetries,
    sleep: options.sleep,
    random: options.random,
  });
  const statuses = [...assets.map((asset) => asset.status), usdt.status];
  const resultStatus: BscMetadataAuditResult["status"] = statuses.includes("RPC_DIVERGENCE")
    ? "RPC_DIVERGENCE"
    : statuses.every((status) => status === "MOCK_VERIFIED")
      ? "MOCK_VERIFIED"
      : statuses.every((status) => status === "LIVE_VERIFIED_CROSS_RPC")
        ? "LIVE_VERIFIED_CROSS_RPC"
        : statuses.every((status) => status === "LIVE_VERIFIED_SINGLE_RPC")
          ? "LIVE_VERIFIED_SINGLE_RPC"
          : "UNVERIFIED";

  return {
    status: resultStatus,
    auditTimestamp: new Date((options.now ?? Date.now)()).toISOString(),
    catalogueSource: "Binance Web3 RWA token catalogue GET /build/api/v1/dex/market/rwa/tokens",
    catalogueSnapshotSha256,
    eligibleAssetCount: eligible.length,
    duplicateEligibleAddressCount: duplicates.size,
    chainId: 56,
    blockNumber: blockNumber.toString(),
    blockHash: primaryBlockHash,
    primaryRpcId: primary.id,
    secondaryRpcId: secondary?.id ?? null,
    rpcVerificationCount: secondary ? 2 : 1,
    concurrency,
    rpcBlockHashes,
    assets,
    usdt,
  };
}

async function auditUsdt(options: {
  primary: BscAuditRpc;
  secondary?: BscAuditRpc;
  sameBlock: boolean;
  networkDivergence: boolean;
  secondaryFailure: string | null;
  blockNumber: bigint;
  blockHash: string;
  evidenceMode?: "LIVE" | "MOCK";
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}): Promise<BscMetadataAuditContract> {
  const address = getAddress(BSC_USDT_ADDRESS);
  const primaryResult = await readAtBlock(options.primary.client, address, options.blockNumber, options);
  if (primaryResult.error) {
    const status = primaryResult.error === "MISSING_CONTRACT_CODE" ||
      primaryResult.error === "DECIMALS_OUTSIDE_WOLV_RANGE"
      ? "UNSUPPORTED"
      : "UNVERIFIED";
    return {
      ...emptyContractResult("USDT", BSC_USDT_ADDRESS, status, primaryResult.error, 1, "USDT_AUDIT_TARGET"),
      chainId: 56,
      blockNumber: options.blockNumber.toString(),
      blockHash: options.blockHash,
      contractCodePresent: primaryResult.contractCodePresent,
      contractCodeSha256: primaryResult.contractCodeSha256,
      decimals: primaryResult.decimals,
      rpcDiagnostics: primaryResult.diagnostics,
    };
  }
  if (options.networkDivergence) {
    return {
      ...emptyContractResult("USDT", BSC_USDT_ADDRESS, "RPC_DIVERGENCE", options.secondaryFailure, 1, "USDT_AUDIT_TARGET"),
      chainId: 56,
      blockNumber: options.blockNumber.toString(),
      blockHash: options.blockHash,
      contractCodePresent: true,
      contractCodeSha256: primaryResult.contractCodeSha256,
      decimals: primaryResult.decimals,
      rpcDiagnostics: primaryResult.diagnostics,
    };
  }
  if (options.sameBlock && options.secondary) {
    const second = await readAtBlock(options.secondary.client, address, options.blockNumber, options);
    if (second.error) {
      return {
        ...emptyContractResult("USDT", BSC_USDT_ADDRESS, "UNVERIFIED", `SECONDARY_${second.error}`, 1, "USDT_AUDIT_TARGET"),
        chainId: 56,
        blockNumber: options.blockNumber.toString(),
        blockHash: options.blockHash,
        contractCodePresent: true,
        contractCodeSha256: primaryResult.contractCodeSha256,
        decimals: primaryResult.decimals,
        rpcDiagnostics: [...primaryResult.diagnostics, ...second.diagnostics],
      };
    }
    if (second.contractCodeSha256 !== primaryResult.contractCodeSha256 || second.decimals !== primaryResult.decimals) {
      return {
        ...emptyContractResult("USDT", BSC_USDT_ADDRESS, "RPC_DIVERGENCE", second.error ?? "CONTRACT_RESULT_MISMATCH", 2, "USDT_AUDIT_TARGET"),
        chainId: 56,
        blockNumber: options.blockNumber.toString(),
        blockHash: options.blockHash,
        contractCodePresent: true,
        contractCodeSha256: primaryResult.contractCodeSha256,
        decimals: primaryResult.decimals,
        rpcDiagnostics: [...primaryResult.diagnostics, ...second.diagnostics],
      };
    }
  }
  return {
    symbol: "USDT",
    tokenAddress: BSC_USDT_ADDRESS,
    eligibility: "USDT_AUDIT_TARGET",
    status: verifiedStatus(options.evidenceMode, options.sameBlock),
    chainId: 56,
    blockNumber: options.blockNumber.toString(),
    blockHash: options.blockHash,
    contractCodePresent: true,
    contractCodeSha256: primaryResult.contractCodeSha256,
    decimals: primaryResult.decimals,
    rpcDiagnostics: primaryResult.diagnostics,
    rpcVerificationCount: options.sameBlock ? 2 : 1,
    errorClassification: options.secondaryFailure,
    catalogueDecimals: null,
  };
}

async function readAtBlock(
  client: BscAuditRpcClient,
  address: Address,
  blockNumber: bigint,
  retryOptions: {
    maxRetries?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
  } = {},
) {
  const codeRead = await runRpcRead({
    method: "eth_getCode",
    stage: "BYTECODE",
    operation: () => client.getBytecode({ address, blockNumber }),
    ...retryOptions,
  });
  if (!codeRead.ok) {
    return failedRead(codeRead.diagnostic.errorClass, null, null, null, codeRead.diagnostics);
  }
  const bytecode = codeRead.value;
  if (typeof bytecode !== "string" || !/^0x(?:[a-fA-F0-9]{2})*$/.test(bytecode)) {
    return failedRead("INVALID_RPC_RESPONSE", null, null, null, markInvalidRpcResponse(codeRead.diagnostics));
  }
  if (bytecode === "0x") return failedRead("MISSING_CONTRACT_CODE", false, null, null, codeRead.diagnostics);
  const contractCodeSha256 = createHash("sha256").update(bytecode).digest("hex");
  const decimalRead = await runRpcRead({
    method: "eth_call",
    stage: "DECIMALS",
    operation: () => client.readContract({
      address,
      abi: DECIMALS_ABI,
      functionName: "decimals",
      blockNumber,
    }),
    ...retryOptions,
  });
  if (!decimalRead.ok) {
    return failedRead(decimalRead.diagnostic.errorClass, true, contractCodeSha256, null, [
      ...codeRead.diagnostics,
      ...decimalRead.diagnostics,
    ]);
  }
  const decimals: unknown = decimalRead.value;
  const diagnostics = [...codeRead.diagnostics, ...decimalRead.diagnostics];
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return failedRead("INVALID_RPC_RESPONSE", true, contractCodeSha256, null, markInvalidRpcResponse(diagnostics));
  }
  if (decimals > MAX_SUPPORTED_DECIMALS) {
    return failedRead("DECIMALS_OUTSIDE_WOLV_RANGE", true, contractCodeSha256, decimals, diagnostics);
  }
  return { error: null, contractCodePresent: true, contractCodeSha256, decimals, diagnostics };
}

function failedRead(
  error: string,
  contractCodePresent: boolean | null,
  contractCodeSha256: string | null,
  decimals: number | null = null,
  diagnostics: RpcRequestDiagnostic[] = [],
) {
  return { error, contractCodePresent, contractCodeSha256, decimals, diagnostics };
}

function emptyContractResult(
  symbol: string | null,
  tokenAddress: string,
  status: BscMetadataAuditStatus,
  errorClassification: string | null,
  rpcVerificationCount: number,
  eligibility: "ELIGIBLE" | "USDT_AUDIT_TARGET" = "ELIGIBLE",
): BscMetadataAuditContract {
  return {
    symbol,
    tokenAddress,
    eligibility,
    status,
    chainId: null,
    blockNumber: null,
    blockHash: null,
    contractCodePresent: null,
    contractCodeSha256: null,
    decimals: null,
    rpcVerificationCount,
    errorClassification,
    rpcDiagnostics: [],
    catalogueDecimals: null,
  };
}

function rawCatalogueDecimals(records: Record<string, unknown>[]) {
  const values = records
    .filter((record) => Object.hasOwn(record, "decimals"))
    .map((record) => record.decimals);
  if (values.length === 0) return { present: false, value: null };
  return {
    present: true,
    value: values.length === 1 && values[0] !== undefined
      ? values[0]
      : values,
  };
}

function metadataMatchesCatalogue(chainDecimals: number, catalogueDecimals: unknown): boolean {
  if (typeof catalogueDecimals === "number") {
    return Number.isInteger(catalogueDecimals) && catalogueDecimals === chainDecimals;
  }
  return typeof catalogueDecimals === "string" &&
    /^(?:0|[1-9]\d*)$/.test(catalogueDecimals) &&
    Number(catalogueDecimals) === chainDecimals;
}

function normalizeBlockHash(value: unknown): string | null {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function hasIndependentOperator(primary: BscAuditRpc, secondary?: BscAuditRpc): secondary is BscAuditRpc {
  return Boolean(
    secondary &&
    primary.operator.trim() &&
    secondary.operator.trim() &&
    primary.operator.trim().toLowerCase() !== secondary.operator.trim().toLowerCase(),
  );
}

function verifiedStatus(
  evidenceMode: "LIVE" | "MOCK" | undefined,
  crossRpc: boolean,
): BscMetadataAuditStatus {
  if (evidenceMode === "MOCK") return "MOCK_VERIFIED";
  if (evidenceMode !== "LIVE") return "UNVERIFIED";
  return crossRpc ? "LIVE_VERIFIED_CROSS_RPC" : "LIVE_VERIFIED_SINGLE_RPC";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
