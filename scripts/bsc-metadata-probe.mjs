import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import "server-only";
import { createPublicClient, defineChain, http } from "viem";
import {
  getRecordedProbeTargets,
  probeRecordedBlock,
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
export const PROBE_CONFIRMATION = "READ-ONLY RECORDED-BLOCK PROBE";
const EXPECTED_TOKEN_ADDRESSES = [
  "0xe614e2fc6c787035ff51f452e8e826bfd32d5283",
  "0x282973969118f9fe39bf2ff3d8dd1efee82ccb11",
];

export function formatProbePlan(rpcIdentity) {
  return [
    "BSC recorded-block metadata probe — DRY RUN",
    "Network: BNB Smart Chain mainnet (chain ID 56)",
    `Block: ${RECORDED_METADATA_BLOCK} (${RECORDED_METADATA_BLOCK_HASH})`,
    `RPC endpoint: ${rpcIdentity}`,
    "Targets: configured BSC USDT and two fixed addresses verified in the prior audit JSON.",
    `Addresses: ${[BSC_USDT_ADDRESS, ...EXPECTED_TOKEN_ADDRESSES].join(", ")}`,
    "Planned RPC methods: eth_chainId, eth_getBlockByNumber, eth_getCode, eth_call (decimals() only after non-empty valid code).",
    "No Binance catalogue or BAW call; no signing, approval, transaction, deployment, or broadcast.",
    `Live probe requires --live-read-only and exact confirmation: ${PROBE_CONFIRMATION}.`,
    "No network request was made.",
  ].join("\n");
}

export function requireProbeConfirmation(answer) {
  return typeof answer === "string" && answer.trim() === PROBE_CONFIRMATION;
}

export async function readRecordedProbeTargets(auditPath = AUDIT_PATH) {
  let audit;
  try {
    audit = JSON.parse(await readFile(auditPath, "utf8"));
  } catch {
    throw new Error("The recorded audit JSON could not be loaded or parsed.");
  }
  return getRecordedProbeTargets(audit);
}

async function main(args = process.argv.slice(2)) {
  if (args.some((argument) => argument !== "--live-read-only") || args.length > 1) {
    console.error("Usage: node --conditions=react-server --experimental-strip-types scripts/bsc-metadata-probe.mjs [--live-read-only]");
    process.exitCode = 2;
    return;
  }
  const rpcUrl = process.env.BSC_RPC_URL
    ? requireServerRpcUrl(process.env.BSC_RPC_URL)
    : resolvePublicRpcUrl(
      process.env.NEXT_PUBLIC_BSC_RPC_URL,
      PUBLIC_BSC_RPC,
      "NEXT_PUBLIC_BSC_RPC_URL",
    );
  console.log(formatProbePlan(redactRpcEndpointIdentity(rpcUrl)));
  if (!args.includes("--live-read-only")) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Live probe requires an interactive terminal for typed confirmation.");
  }
  const targets = await readRecordedProbeTargets();
  await confirmProbe();

  const chain = defineChain({
    id: 56,
    name: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const result = await probeRecordedBlock({
    client: createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10_000 }) }),
    targets,
  });
  const output = {
    auditTimestamp: new Date().toISOString(),
    rpcIdentity: redactRpcEndpointIdentity(rpcUrl),
    ...result,
  };
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputDirectory = path.resolve(__dirname, "../docs/audits");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, `bsc-metadata-probe-${timestamp}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Probe status: ${result.status}; sanitized results written under ${outputDirectory}.`);
}

async function confirmProbe() {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Type ${PROBE_CONFIRMATION} to issue only the listed read-only requests:\n> `);
    if (!requireProbeConfirmation(answer)) {
      throw new Error("Probe confirmation did not match; no RPC request was made.");
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
      error.message.startsWith("Probe confirmation") ||
      error.message.startsWith("Live probe requires")
    )
      ? error.message
      : "BSC metadata probe failed; sensitive endpoint and credential details were suppressed.");
    process.exitCode = 1;
  });
}
