import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import "server-only";
import { createPublicClient, defineChain, http } from "viem";
import { makeBinanceAuthHeaders } from "../lib/binanceAuth.ts";
import { isSpotEligibleAsset } from "../lib/compliance.ts";
import {
  auditBscCatalogueMetadata,
  BscMetadataAuditError,
} from "../lib/bscMetadataAudit.ts";
import { MAX_AUDIT_CONCURRENCY } from "../lib/bscRpcReliability.ts";
import { redactRpcEndpointIdentity, resolvePublicRpcUrl } from "../lib/publicRpcUrl.ts";
import { isRwaAssetListResponse, parseRwaAssetRecords } from "../lib/rwaAssetResponse.ts";

const CATALOGUE_URL = "https://web3.binance.com/build/api/v1/dex/market/rwa/tokens";
const PUBLIC_BSC_RPC = "https://bsc-dataseed.bnbchain.org";
const ALLOWED_METHODS = [
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_call (decimals())",
];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(path.resolve(__dirname, ".."));

export function createAuditPlan({
  primaryRpcUrl,
  secondaryRpcUrl = null,
  primaryOperator = "",
  secondaryOperator = "",
  concurrency = 1,
}) {
  const canCrossVerify = Boolean(
    secondaryRpcUrl &&
    primaryOperator.trim() &&
    secondaryOperator.trim() &&
    primaryOperator.trim().toLowerCase() !== secondaryOperator.trim().toLowerCase(),
  );
  return {
    mode: "DRY_RUN",
    network: "BNB Smart Chain mainnet",
    chainId: 56,
    catalogueRequest: {
      method: "GET",
      url: CATALOGUE_URL,
      authentication: "Signed Binance Web3 API headers; credential values are not displayed or recorded.",
    },
    eligibleAssetCount: "Unknown until the catalogue GET is explicitly authorized.",
    concurrency,
    maxRetries: 2,
    retryPolicy: "At most 2 retries for classified transient failures; same captured block and provider.",
    primaryRpcIdentity: redactRpcEndpointIdentity(primaryRpcUrl),
    secondaryRpcIdentity: secondaryRpcUrl ? redactRpcEndpointIdentity(secondaryRpcUrl) : null,
    secondaryRpcUse: canCrossVerify
      ? "Configured operator labels differ; cross-verification will be attempted."
      : secondaryRpcUrl
        ? "Not used for cross-verification: independent operator labels are absent or identical."
        : "Not configured; single-RPC verification only.",
    readOnlyRpcMethods: ALLOWED_METHODS,
    guarantees: [
      "No BAW CLI or BAW provider call.",
      "No wallet client, signing, approval, transaction-writing, deployment, or broadcast method.",
      "No arbitrary token addresses; contract reads are limited to unique eligible catalogue addresses and configured BSC USDT.",
      "RPC reads are pinned to one captured BSC block number.",
    ],
  };
}

export function requireExplicitConfirmation(answer, expectedPhrase) {
  return typeof answer === "string" && answer.trim() === expectedPhrase;
}

export function sanitizeCatalogue(response) {
  if (!isRwaAssetListResponse(response, { allowEmpty: true })) {
    throw new BscMetadataAuditError("The RWA catalogue response has an unexpected shape.");
  }
  const scalarKeys = [
    "tokenContractAddress", "underlyingTicker", "platformId", "underlyingName",
    "tokenName", "name", "symbol", "leverage", "leverageFactor",
    "tokenToShareRatio", "referencePrice", "decimals",
  ];
  return {
    data: response.data.map((record) => {
      const clean = {};
      for (const key of scalarKeys) {
        const value = record[key];
        if (typeof value === "string" || typeof value === "number" || value === null) {
          clean[key] = value;
        }
      }
      if (record.statusInfo && typeof record.statusInfo === "object" && !Array.isArray(record.statusInfo)) {
        clean.statusInfo = {
          ...(typeof record.statusInfo.openState === "boolean" ? { openState: record.statusInfo.openState } : {}),
          ...(typeof record.statusInfo.marketStatus === "string" || record.statusInfo.marketStatus === null
            ? { marketStatus: record.statusInfo.marketStatus }
            : {}),
        };
      }
      return clean;
    }),
  };
}

export function formatAuditPlan(plan) {
  return [
    "BSC asset metadata audit — DRY RUN",
    `Network: ${plan.network} (chain ID ${plan.chainId})`,
    `Catalogue request: ${plan.catalogueRequest.method} ${plan.catalogueRequest.url}`,
    `Eligible assets: ${plan.eligibleAssetCount}`,
    `Request concurrency: ${plan.concurrency}; maximum retries: ${plan.maxRetries}`,
    `Retry policy: ${plan.retryPolicy}`,
    `Primary RPC: ${plan.primaryRpcIdentity}`,
    `Secondary RPC: ${plan.secondaryRpcIdentity ?? "not configured"}`,
    `Secondary use: ${plan.secondaryRpcUse}`,
    `Read-only RPC methods: ${plan.readOnlyRpcMethods.join(", ")}`,
    ...plan.guarantees.map((item) => `- ${item}`),
    "No network request was made. Live access requires --live-read-only and interactive typed confirmations.",
  ].join("\n");
}

export async function fetchCatalogue(fetchImplementation = fetch) {
  const headers = makeBinanceAuthHeaders("GET", "/api/v1/dex/market/rwa/tokens");
  let response;
  try {
    response = await fetchImplementation(CATALOGUE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    throw new BscMetadataAuditError("The read-only RWA catalogue request failed.");
  }
  if (!response.ok) {
    throw new BscMetadataAuditError(`The read-only RWA catalogue request returned HTTP ${response.status}.`);
  }
  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    throw new BscMetadataAuditError("The RWA catalogue response was not valid JSON.");
  }
  if (!isRwaAssetListResponse(responseBody, { allowEmpty: true })) {
    throw new BscMetadataAuditError("The RWA catalogue response has an unexpected shape.");
  }
  return sanitizeCatalogue(responseBody);
}

export function countEligibleAssets(catalogue) {
  return parseRwaAssetRecords(catalogue).filter(isSpotEligibleAsset).length;
}

export function formatAuditMarkdown(result) {
  const rows = [...result.assets, result.usdt].map((contract) => [
    escapeMarkdown(contract.symbol ?? "—"),
    `\`${escapeMarkdown(contract.tokenAddress)}\``,
    contract.eligibility,
    contract.contractCodePresent === null ? "unknown" : contract.contractCodePresent ? "yes" : "no",
    contract.decimals === null ? "—" : String(contract.decimals),
    contract.rpcVerificationCount,
    contract.status,
    escapeMarkdown(contract.errorClassification ?? "—"),
  ].join(" | "));
  return [
    "# BSC Asset Metadata Audit",
    "",
    `- Status: **${result.status}**`,
    `- Audit timestamp: ${result.auditTimestamp}`,
    `- Catalogue: ${result.catalogueSource}`,
    `- Sanitized catalogue SHA-256: \`${result.catalogueSnapshotSha256}\``,
    `- Eligible catalogue assets: ${result.eligibleAssetCount}`,
    `- Duplicate eligible addresses: ${result.duplicateEligibleAddressCount}`,
    `- Chain ID: ${result.chainId ?? "unverified"}`,
    `- Block: ${result.blockNumber ?? "unverified"}`,
    `- Block hash: ${result.blockHash ?? "unverified"}`,
    `- RPCs: primary \`${result.primaryRpcId}\`; secondary \`${result.secondaryRpcId ?? "not used"}\``,
    "",
    "| Symbol | Address | Eligibility | Code | Decimals | RPC count | Status | Error classification |",
    "|---|---|---|---|---:|---:|---|---|",
    ...rows,
    "",
    "This audit verifies only read-only contract metadata. It does not establish token legitimacy, share denomination, UI multiplier support, BAW quantity semantics, or provider settlement.",
    "No BAW operation, signature, approval, transaction, or broadcast was performed.",
  ].join("\n");
}

export function parseAuditArgs(args) {
  let liveReadOnly = false;
  let concurrency = 1;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--live-read-only" && !liveReadOnly) {
      liveReadOnly = true;
      continue;
    }
    if (args[index] === "--concurrency" && index + 1 < args.length) {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_AUDIT_CONCURRENCY) {
        throw new BscMetadataAuditError(`Concurrency must be an integer from 1 to ${MAX_AUDIT_CONCURRENCY}.`);
      }
      concurrency = value;
      index += 1;
      continue;
    }
    throw new BscMetadataAuditError("Invalid audit arguments.");
  }
  return { liveReadOnly, concurrency };
}

async function main(args = process.argv.slice(2)) {
  let parsedArgs;
  try {
    parsedArgs = parseAuditArgs(args);
  } catch {
    console.error(`Usage: node --conditions=react-server --experimental-strip-types scripts/bsc-metadata-audit.mjs [--live-read-only] [--concurrency 1-${MAX_AUDIT_CONCURRENCY}]`);
    process.exitCode = 2;
    return;
  }
  const primaryRpcUrl = process.env.BSC_RPC_URL
    ? requireServerRpcUrl(process.env.BSC_RPC_URL)
    : resolvePublicRpcUrl(process.env.NEXT_PUBLIC_BSC_RPC_URL, PUBLIC_BSC_RPC, "NEXT_PUBLIC_BSC_RPC_URL");
  const secondaryRpcUrl = process.env.BSC_RPC_SECONDARY_URL
    ? requireServerRpcUrl(process.env.BSC_RPC_SECONDARY_URL)
    : null;
  const plan = createAuditPlan({
    primaryRpcUrl,
    secondaryRpcUrl,
    primaryOperator: process.env.BSC_RPC_OPERATOR ?? "",
    secondaryOperator: process.env.BSC_RPC_SECONDARY_OPERATOR ?? "",
    concurrency: parsedArgs.concurrency,
  });
  console.log(formatAuditPlan(plan));
  if (!parsedArgs.liveReadOnly) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new BscMetadataAuditError("Live audit requires an interactive terminal for operator confirmations.");
  }
  await confirmInTerminal(
    "Type READ-ONLY CATALOGUE to make only the signed catalogue GET shown above:",
    "READ-ONLY CATALOGUE",
  );
  const catalogue = await fetchCatalogue();
  const eligibleCount = countEligibleAssets(catalogue);
  const rpcPlan = {
    ...plan,
    mode: "LIVE_READ_ONLY",
    eligibleAssetCount: eligibleCount,
  };
  console.log("\nCatalogue received and sanitized. No RPC request has been made yet.");
  console.log(JSON.stringify(rpcPlan, null, 2));
  await confirmInTerminal(
    "Type READ-ONLY BSC RPC to run the listed read methods for eligible catalogue assets and USDT:",
    "READ-ONLY BSC RPC",
  );
  await confirmInTerminal(
    "Type READ-ONLY FULL CATALOGUE AUDIT to inspect every eligible catalogue asset:",
    "READ-ONLY FULL CATALOGUE AUDIT",
  );

  const primary = createRpc("primary", process.env.BSC_RPC_OPERATOR ?? "", primaryRpcUrl);
  const secondary = secondaryRpcUrl && plan.secondaryRpcUse.startsWith("Configured operator labels differ")
    ? createRpc("secondary", process.env.BSC_RPC_SECONDARY_OPERATOR, secondaryRpcUrl)
    : undefined;
  const result = await auditBscCatalogueMetadata(catalogue, {
    primary,
    ...(secondary ? { secondary } : {}),
    evidenceMode: "LIVE",
    concurrency: parsedArgs.concurrency,
    maxRetries: 2,
  });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputDirectory = path.resolve(__dirname, "../docs/audits");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, `bsc-metadata-audit-${timestamp}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(outputDirectory, `bsc-metadata-audit-${timestamp}.md`), `${formatAuditMarkdown(result)}\n`, { mode: 0o600 });
  console.log(`\nSanitized audit files written under ${outputDirectory}.`);
}

async function confirmInTerminal(prompt, expectedPhrase) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`${prompt}\n> `);
    if (!requireExplicitConfirmation(answer, expectedPhrase)) {
      throw new BscMetadataAuditError("Operator confirmation did not match; no further network request was made.");
    }
  } finally {
    terminal.close();
  }
}

function createRpc(id, operator, rpcUrl) {
  const chain = defineChain({
    id: 56,
    name: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return {
    id,
    operator,
    client: createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10_000 }) }),
  };
}

function requireServerRpcUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BscMetadataAuditError("Server-side BSC RPC URL is invalid; its value is redacted.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hash) {
    throw new BscMetadataAuditError("Server-side BSC RPC URL must use HTTP(S) without a fragment.");
  }
  return url.toString();
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof BscMetadataAuditError
      ? error.message
      : "BSC metadata audit failed; sensitive endpoint and credential details were suppressed.");
    process.exitCode = 1;
  });
}
