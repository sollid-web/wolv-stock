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
import { createRpcWireRecorder } from "../lib/bscRpcWireRecorder.ts";
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
export const RPC_SEMANTICS_CONFIRMATION = "READ-ONLY RPC SEMANTICS PROBE";
const TARGET_ADDRESSES = [
  BSC_USDT_ADDRESS,
  "0xe614e2fc6c787035ff51f452e8e826bfd32d5283",
  "0x282973969118f9fe39bf2ff3d8dd1efee82ccb11",
];

export function formatRpcSemanticsPlan(rpcIdentity, { liveRequested = false } = {}) {
  return [
    liveRequested
      ? "BSC historical RPC request-semantics probe — READ-ONLY PLAN, CONFIRMATION REQUIRED"
      : "BSC historical RPC request-semantics probe — DRY RUN",
    "Network: BNB Smart Chain mainnet (chain ID 56)",
    `Primary RPC: ${rpcIdentity}`,
    `Recorded block: ${RECORDED_METADATA_BLOCK} (${RECORDED_METADATA_BLOCK_HASH})`,
    `Permitted targets: ${TARGET_ADDRESSES.join(", ")}`,
    "Requests after confirmation: eth_chainId; eth_blockNumber; eth_getBlockByNumber at latest and recorded blocks; eth_getCode for each target at latest and recorded blocks.",
    "eth_call(decimals()) is limited to valid non-empty bytecode at the recorded block.",
    "No retries; no endpoint switching; no archive endpoint; no Binance or BAW call; no transaction method.",
    `Live requests require --live-read-only and exact confirmation: ${RPC_SEMANTICS_CONFIRMATION}.`,
    liveRequested
      ? "No request will be sent unless the exact confirmation is entered."
      : "No network request was made.",
  ].join("\n");
}

export function requireRpcSemanticsConfirmation(answer) {
  return typeof answer === "string" && answer.trim() === RPC_SEMANTICS_CONFIRMATION;
}

export function createInstrumentedArchiveClient(client, recorder) {
  return {
    getChainId: (...args) => client.getChainId(...args),
    getBlockNumber: (...args) => client.getBlockNumber(...args),
    getBlock: (parameters) => {
      recorder.noteBlockInput(
        "eth_getBlockByNumber",
        null,
        parameters.blockNumber ?? parameters.blockTag,
      );
      return client.getBlock(parameters);
    },
    getBytecode: (parameters) => {
      recorder.noteBlockInput(
        "eth_getCode",
        parameters.address,
        parameters.blockNumber ?? parameters.blockTag,
      );
      return client.getBytecode(parameters);
    },
    readContract: (parameters) => {
      recorder.noteBlockInput(
        "eth_call",
        parameters.address,
        parameters.blockNumber ?? parameters.blockTag,
      );
      return client.readContract(parameters);
    },
  };
}

export async function readRpcSemanticsTargets(auditPath = AUDIT_PATH) {
  let audit;
  try {
    audit = JSON.parse(await readFile(auditPath, "utf8"));
  } catch {
    throw new Error("The recorded audit JSON could not be loaded or parsed.");
  }
  return getRecordedProbeTargets(audit);
}

export function resolveRpcSemanticsUrl(environment = process.env) {
  const url = environment.BSC_RPC_URL
    ? requireServerRpcUrl(environment.BSC_RPC_URL)
    : resolvePublicRpcUrl(
      environment.NEXT_PUBLIC_BSC_RPC_URL,
      PUBLIC_BSC_RPC,
      "NEXT_PUBLIC_BSC_RPC_URL",
    );
  return { url, identity: redactRpcEndpointIdentity(url) };
}

async function main(args = process.argv.slice(2)) {
  if (args.some((argument) => argument !== "--live-read-only") || args.length > 1) {
    console.error("Usage: node --conditions=react-server --experimental-strip-types scripts/bsc-rpc-semantics-probe.mjs [--live-read-only]");
    process.exitCode = 2;
    return;
  }
  const endpoint = resolveRpcSemanticsUrl();
  const liveRequested = args.includes("--live-read-only");
  console.log(formatRpcSemanticsPlan(endpoint.identity, { liveRequested }));
  if (!liveRequested) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Live request-semantics probe requires an interactive terminal for typed confirmation.");
  }
  const targets = await readRpcSemanticsTargets();
  await confirmRpcSemanticsProbe();

  const recorder = createRpcWireRecorder();
  const chain = defineChain({
    id: 56,
    name: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [endpoint.url] } },
  });
  const client = createInstrumentedArchiveClient(createPublicClient({
    chain,
    transport: http(endpoint.url, {
      timeout: 10_000,
      retryCount: 0,
      fetchFn: recorder.fetchFn,
    }),
  }), recorder);
  const result = await diagnoseArchiveState({
    primary: {
      client,
      identity: endpoint.identity,
      operator: "primary",
    },
    targets,
  });
  const output = {
    auditTimestamp: new Date().toISOString(),
    ...result,
    wireRequests: recorder.snapshot(),
  };
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputDirectory = path.resolve(__dirname, "../docs/audits");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, `bsc-rpc-semantics-probe-${timestamp}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Probe status: ${result.status}; sanitized results written under ${outputDirectory}.`);
}

async function confirmRpcSemanticsProbe() {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      `Type ${RPC_SEMANTICS_CONFIRMATION} to issue only the displayed read-only requests:\n> `,
    );
    if (!requireRpcSemanticsConfirmation(answer)) {
      throw new Error("Request-semantics confirmation did not match; no RPC request was made.");
    }
  } finally {
    terminal.close();
  }
}

function requireServerRpcUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Server-side BSC RPC URL is invalid; its value is redacted.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hash) {
    throw new Error("Server-side BSC RPC URL must use HTTP(S) without a fragment.");
  }
  return url.toString();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error && (
      error.message.startsWith("Request-semantics confirmation") ||
      error.message.startsWith("Live request-semantics probe requires")
    )
      ? error.message
      : "BSC request-semantics probe failed; sensitive endpoint and credential details were suppressed.");
    process.exitCode = 1;
  });
}
