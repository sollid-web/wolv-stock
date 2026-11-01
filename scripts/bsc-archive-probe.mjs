import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import "server-only";
import { createPublicClient, defineChain, http } from "viem";
import { diagnoseArchiveState } from "../lib/bscArchiveProbe.ts";
import {
  getRecordedProbeTargets,
  RECORDED_METADATA_BLOCK,
  RECORDED_METADATA_BLOCK_HASH,
} from "../lib/bscMetadataProbe.ts";
import { BSC_USDT_ADDRESS } from "../lib/apiValidation.ts";
import { redactRpcEndpointIdentity, resolvePublicRpcUrl } from "../lib/publicRpcUrl.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(path.resolve(__dirname, ".."));

const AUDIT_PATH = path.resolve(
  __dirname,
  "../docs/audits/bsc-metadata-audit-2026-11-01T08-14-16.554Z.json",
);
const PUBLIC_BSC_RPC = "https://bsc-dataseed.bnbchain.org";
export const ARCHIVE_PROBE_CONFIRMATION = "READ-ONLY ARCHIVE STATE PROBE";
export const ARCHIVE_INDEPENDENCE_CONFIRMATION = "I_CONFIRM_SEPARATE_OPERATORS";
const TOKEN_ADDRESSES = [
  "0xe614e2fc6c787035ff51f452e8e826bfd32d5283",
  "0x282973969118f9fe39bf2ff3d8dd1efee82ccb11",
];

export function formatArchiveProbePlan({
  primaryIdentity,
  archiveIdentity,
  operatorIndependence,
  primaryOnly = false,
}) {
  const methods = archiveIdentity && !primaryOnly
    ? "eth_chainId, eth_blockNumber (primary only), eth_getBlockByNumber, eth_getCode, eth_call (decimals() only after non-empty valid code)"
    : "eth_chainId, eth_blockNumber, eth_getBlockByNumber, eth_getCode, eth_call (decimals() only after non-empty valid code)";
  return [
    "BSC archive state verification — DRY RUN",
    "Network: BNB Smart Chain mainnet (chain ID 56)",
    `Primary RPC identity: ${primaryIdentity}`,
    `Archive RPC identity: ${primaryOnly
      ? "excluded by --primary-only"
      : archiveIdentity ?? "not configured (BSC_RPC_ARCHIVE_URL is unset)"}`,
    `Provider independence: ${operatorIndependence}`,
    `Target block: ${RECORDED_METADATA_BLOCK} (${RECORDED_METADATA_BLOCK_HASH})`,
    `Permitted addresses: ${[BSC_USDT_ADDRESS, ...TOKEN_ADDRESSES].join(", ")}`,
    `Read-only methods: ${methods}`,
    "No Binance catalogue or BAW call; no wallet operation or transaction method.",
    `Live requests require --live-read-only and exact confirmation: ${ARCHIVE_PROBE_CONFIRMATION}.`,
    "No network request was made.",
  ].join("\n");
}

export function requireArchiveProbeConfirmation(answer) {
  return typeof answer === "string" && answer.trim() === ARCHIVE_PROBE_CONFIRMATION;
}

export async function readArchiveProbeTargets(auditPath = AUDIT_PATH) {
  let audit;
  try {
    audit = JSON.parse(await readFile(auditPath, "utf8"));
  } catch {
    throw new Error("The recorded audit JSON could not be loaded or parsed.");
  }
  return getRecordedProbeTargets(audit);
}

export function resolveArchiveProbeConfig(environment = process.env) {
  const primaryUrl = environment.BSC_RPC_URL
    ? requireServerRpcUrl(environment.BSC_RPC_URL, "BSC_RPC_URL")
    : resolvePublicRpcUrl(
      environment.NEXT_PUBLIC_BSC_RPC_URL,
      PUBLIC_BSC_RPC,
      "NEXT_PUBLIC_BSC_RPC_URL",
    );
  const archiveUrl = environment.BSC_RPC_ARCHIVE_URL
    ? requireServerRpcUrl(environment.BSC_RPC_ARCHIVE_URL, "BSC_RPC_ARCHIVE_URL")
    : null;
  const primaryOperator = environment.BSC_RPC_OPERATOR ?? "";
  const archiveOperator = environment.BSC_RPC_ARCHIVE_OPERATOR ?? "";
  const distinctOperators = Boolean(
    primaryOperator.trim() &&
    archiveOperator.trim() &&
    primaryOperator.trim().toLowerCase() !== archiveOperator.trim().toLowerCase(),
  );
  const operatorIndependenceConfirmed =
    environment.BSC_RPC_ARCHIVE_INDEPENDENCE_CONFIRMED === ARCHIVE_INDEPENDENCE_CONFIRMATION;
  return {
    primaryUrl,
    archiveUrl,
    primaryIdentity: redactRpcEndpointIdentity(primaryUrl),
    archiveIdentity: archiveUrl ? redactRpcEndpointIdentity(archiveUrl) : null,
    primaryOperator,
    archiveOperator,
    operatorIndependenceConfirmed,
    operatorIndependence: distinctOperators && operatorIndependenceConfirmed
      ? "operator attestation configured; not independently verified"
      : "not established (operator labels missing or identical)",
  };
}

async function main(args = process.argv.slice(2)) {
  const allowedArgs = new Set(["--live-read-only", "--primary-only"]);
  if (args.some((argument) => !allowedArgs.has(argument)) ||
    new Set(args).size !== args.length ||
    (args.includes("--primary-only") && !args.includes("--live-read-only"))) {
    console.error("Usage: node --conditions=react-server --experimental-strip-types scripts/bsc-archive-probe.mjs [--live-read-only [--primary-only]]");
    process.exitCode = 2;
    return;
  }
  const config = resolveArchiveProbeConfig();
  const primaryOnly = args.includes("--primary-only");
  const activeConfig = primaryOnly
    ? {
      ...config,
      archiveUrl: null,
      archiveIdentity: null,
      archiveOperator: "",
      operatorIndependenceConfirmed: false,
      operatorIndependence: "not established (primary-only diagnostic)",
      primaryOnly: true,
    }
    : { ...config, primaryOnly: false };
  console.log(formatArchiveProbePlan(activeConfig));
  if (!args.includes("--live-read-only")) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Live archive probe requires an interactive terminal for typed confirmation.");
  }
  const targets = await readArchiveProbeTargets();
  await confirmArchiveProbe();

  const chain = defineChain({
    id: 56,
    name: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [activeConfig.primaryUrl] } },
  });
  const result = await diagnoseArchiveState({
    primary: {
      client: createPublicClient({ chain, transport: http(activeConfig.primaryUrl, { timeout: 10_000 }) }),
      identity: activeConfig.primaryIdentity,
      operator: activeConfig.primaryOperator,
    },
    ...(activeConfig.archiveUrl
      ? {
        archive: {
          client: createPublicClient({
            chain: defineChain({
              id: 56,
              name: "BNB Smart Chain",
              nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
              rpcUrls: { default: { http: [activeConfig.archiveUrl] } },
            }),
            transport: http(activeConfig.archiveUrl, { timeout: 10_000 }),
          }),
          identity: activeConfig.archiveIdentity,
          operator: activeConfig.archiveOperator,
          independenceAttested: activeConfig.operatorIndependenceConfirmed,
        },
      }
      : {}),
    targets,
  });
  const output = { auditTimestamp: new Date().toISOString(), ...result };
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputDirectory = path.resolve(__dirname, "../docs/audits");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, `bsc-archive-probe-${timestamp}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Probe status: ${result.status}; sanitized results written under ${outputDirectory}.`);
}

async function confirmArchiveProbe() {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      `Type ${ARCHIVE_PROBE_CONFIRMATION} to issue only the displayed read-only requests:\n> `,
    );
    if (!requireArchiveProbeConfirmation(answer)) {
      throw new Error("Archive probe confirmation did not match; no RPC request was made.");
    }
  } finally {
    terminal.close();
  }
}

function requireServerRpcUrl(value, variableName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} is invalid; its value is redacted.`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hash) {
    throw new Error(`${variableName} must use HTTP(S) without a fragment.`);
  }
  return url.toString();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error && (
      error.message.startsWith("Archive probe confirmation") ||
      error.message.startsWith("Live archive probe requires")
    )
      ? error.message
      : "BSC archive probe failed; sensitive endpoint and credential details were suppressed.");
    process.exitCode = 1;
  });
}
