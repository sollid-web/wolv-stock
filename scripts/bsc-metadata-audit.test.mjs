import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicClient, defineChain, http } from "viem";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditBscCatalogueMetadata,
  BscMetadataAuditError,
} from "../lib/bscMetadataAudit.ts";
import {
  countEligibleAssets,
  createAuditPlan,
  fetchCatalogue,
  formatAuditPlan,
  parseAuditArgs,
  requireExplicitConfirmation,
  sanitizeCatalogue,
} from "./bsc-metadata-audit.mjs";
import { redactRpcEndpointIdentity, resolvePublicRpcUrl } from "../lib/publicRpcUrl.ts";
import { BSC_USDT_ADDRESS } from "../lib/apiValidation.ts";
import {
  classifyRpcFailure,
  mapWithConcurrency,
  runRpcRead,
} from "../lib/bscRpcReliability.ts";
import { diagnoseArchiveState } from "../lib/bscArchiveProbe.ts";
import { createRpcWireRecorder, requireRpcBlockNumber } from "../lib/bscRpcWireRecorder.ts";
import {
  getRecordedProbeTargets,
  probeRecordedBlock,
  RECORDED_METADATA_BLOCK,
  RECORDED_METADATA_BLOCK_HASH,
  RECORDED_PROBE_TOKEN_ADDRESSES,
} from "../lib/bscMetadataProbe.ts";
import {
  formatProbePlan,
  requireProbeConfirmation,
  PROBE_CONFIRMATION,
} from "./bsc-metadata-probe.mjs";
import {
  formatArchiveProbePlan,
  requireArchiveProbeConfirmation,
  resolveArchiveProbeConfig,
  ARCHIVE_PROBE_CONFIRMATION,
} from "./bsc-archive-probe.mjs";
import {
  createInstrumentedArchiveClient,
  formatRpcSemanticsPlan,
  requireRpcSemanticsConfirmation,
  resolveRpcSemanticsUrl,
  RPC_SEMANTICS_CONFIRMATION,
} from "./bsc-rpc-semantics-probe.mjs";

const TOKEN = "0x1111111111111111111111111111111111111111";
const OTHER_TOKEN = "0x2222222222222222222222222222222222222222";
const BLOCK_HASH = `0x${"a".repeat(64)}`;
const OTHER_BLOCK_HASH = `0x${"b".repeat(64)}`;
const ARCHIVE_TARGETS = [
  { label: "USDT", address: BSC_USDT_ADDRESS },
  { label: "previously-successful", address: RECORDED_PROBE_TOKEN_ADDRESSES[0] },
  { label: "previously-failed", address: RECORDED_PROBE_TOKEN_ADDRESSES[1] },
];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function catalogue(records = [{ tokenContractAddress: TOKEN, underlyingTicker: "ABC", platformId: "test" }]) {
  return { data: records };
}

function asset(address = TOKEN, overrides = {}) {
  return {
    tokenContractAddress: address,
    underlyingTicker: "ABC",
    platformId: "test",
    ...overrides,
  };
}

function rpc({
  id = "primary",
  operator = "operator-a",
  chainId = 56,
  blockHash = BLOCK_HASH,
  code = "0x60006000",
  decimals = new Map([[TOKEN.toLowerCase(), 8], [BSC_USDT_ADDRESS.toLowerCase(), 18]]),
  readErrors = new Set(),
  codeErrors = new Set(),
  calls = [],
} = {}) {
  return {
    id,
    operator,
    calls,
    client: {
      async getChainId() {
        calls.push(["eth_chainId"]);
        return chainId;
      },
      async getBlockNumber() {
        calls.push(["eth_blockNumber"]);
        return 123456n;
      },
      async getBlock({ blockNumber }) {
        calls.push(["eth_getBlockByNumber", blockNumber]);
        return { hash: blockHash };
      },
      async getBytecode({ address, blockNumber }) {
        calls.push(["eth_getCode", address.toLowerCase(), blockNumber]);
        if (codeErrors.has(address.toLowerCase())) throw new Error("mock read failure");
        return typeof code === "function" ? code(address) : code;
      },
      async readContract({ address, functionName, blockNumber }) {
        calls.push(["eth_call", functionName, address.toLowerCase(), blockNumber]);
        if (readErrors.has(address.toLowerCase())) {
          throw Object.assign(new Error("execution reverted"), { code: -32000 });
        }
        return typeof decimals === "function"
          ? decimals(address)
          : decimals.get(address.toLowerCase());
      },
    },
  };
}

function mockOptions(primary = rpc(), secondary) {
  return {
    primary,
    ...(secondary ? { secondary } : {}),
    evidenceMode: "MOCK",
    now: () => Date.UTC(2026, 0, 1),
  };
}

function archiveRpc({
  id = "primary",
  chainId = 56,
  latestBlockNumber = 20000000n,
  blockHash = RECORDED_METADATA_BLOCK_HASH,
  code = "0x60006000",
  decimals = 18,
  historicalFailure = false,
  blockCalls = [],
} = {}) {
  return {
    id,
    blockCalls,
    client: {
      async getChainId() {
        blockCalls.push(["eth_chainId"]);
        return chainId;
      },
      async getBlockNumber() {
        blockCalls.push(["eth_blockNumber"]);
        return latestBlockNumber;
      },
      async getBlock({ blockNumber }) {
        blockCalls.push(["eth_getBlockByNumber", blockNumber]);
        return { hash: blockHash };
      },
      async getBytecode({ address, blockNumber }) {
        blockCalls.push(["eth_getCode", address.toLowerCase(), blockNumber]);
        if (historicalFailure && blockNumber === RECORDED_METADATA_BLOCK) {
          throw Object.assign(new Error("historical state unavailable; api_key=secret"), {
            code: -32000,
          });
        }
        return typeof code === "function" ? code(address, blockNumber) : code;
      },
      async readContract({ address, functionName, blockNumber }) {
        blockCalls.push(["eth_call", functionName, address.toLowerCase(), blockNumber]);
        return typeof decimals === "function" ? decimals(address, blockNumber) : decimals;
      },
    },
  };
}

test("catalogue parser and eligibility filtering only audit eligible catalogue records", async () => {
  const response = catalogue([
    asset(TOKEN),
    asset(OTHER_TOKEN, { underlyingTicker: "SOXL" }),
  ]);
  assert.equal(countEligibleAssets(response), 1);
  const result = await auditBscCatalogueMetadata(response, mockOptions());
  assert.equal(result.eligibleAssetCount, 1);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].status, "MOCK_VERIFIED");
});

test("previous audit has an initial success run followed by 380 unclassified RPC failures", async () => {
  const previous = JSON.parse(await readFile(path.join(
    projectRoot,
    "docs/audits/bsc-metadata-audit-2026-11-01T08-14-16.554Z.json",
  ), "utf8"));
  const records = previous.assets;
  assert.equal(records.length, 480);
  assert.equal(records.filter((entry) => entry.contractCodePresent === true).length, 100);
  assert.equal(records.filter((entry) => entry.decimals !== null).length, 100);
  assert.equal(records.filter((entry) => entry.status === "UNSUPPORTED").length, 380);
  assert.deepEqual(
    new Set(records.map((entry) => entry.errorClassification).filter(Boolean)),
    new Set(["BYTECODE_READ_FAILED"]),
  );
  assert.ok(records.slice(0, 100).every((entry) => entry.errorClassification === null));
  assert.ok(records.slice(100).every((entry) => entry.errorClassification === "BYTECODE_READ_FAILED"));
  assert.equal(previous.usdt.errorClassification, "BYTECODE_READ_FAILED");
  assert.equal(previous.usdt.contractCodePresent, null);
  assert.equal(records.some((entry) => entry.errorClassification === "CATALOGUE_DECIMALS_CONFLICT"), false);
  assert.ok(records.every((entry) =>
    entry.blockNumber === "131014770" &&
    entry.blockHash === "0x993c869807f1090f1642ef6f9a607770eb051406fcd6d9ab03cc310a676fd36e"
  ));
  assert.equal("requestDiagnostics" in previous, false);
  assert.equal("durationMs" in records[0], false);
});

test("probe targets are derived only from the original audit and configured USDT", async () => {
  const previous = JSON.parse(await readFile(path.join(
    projectRoot,
    "docs/audits/bsc-metadata-audit-2026-11-01T08-14-16.554Z.json",
  ), "utf8"));
  const targets = getRecordedProbeTargets(previous);
  assert.deepEqual(targets.map((target) => target.address.toLowerCase()), [
    BSC_USDT_ADDRESS.toLowerCase(),
    ...RECORDED_PROBE_TOKEN_ADDRESSES,
  ]);
  assert.throws(
    () => getRecordedProbeTargets({ ...previous, blockHash: OTHER_BLOCK_HASH }),
    /block provenance/,
  );
  assert.throws(
    () => getRecordedProbeTargets({
      ...previous,
      assets: previous.assets.filter((entry) => entry.tokenAddress.toLowerCase() !== RECORDED_PROBE_TOKEN_ADDRESSES[1]),
    }),
    /fixed diagnostic token is absent/,
  );
});

test("recorded block probe verifies provenance and only calls decimals after valid code", async () => {
  const calls = [];
  const client = {
    async getChainId() {
      calls.push(["eth_chainId"]);
      return 56;
    },
    async getBlock({ blockNumber }) {
      calls.push(["eth_getBlockByNumber", blockNumber]);
      return { hash: RECORDED_METADATA_BLOCK_HASH };
    },
    async getBytecode({ address, blockNumber }) {
      calls.push(["eth_getCode", address.toLowerCase(), blockNumber]);
      if (address.toLowerCase() === RECORDED_PROBE_TOKEN_ADDRESSES[1]) {
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      }
      return "0x6000";
    },
    async readContract({ address, functionName, blockNumber }) {
      calls.push(["eth_call", functionName, address.toLowerCase(), blockNumber]);
      return address.toLowerCase() === BSC_USDT_ADDRESS.toLowerCase() ? 18 : 8;
    },
  };
  const previous = JSON.parse(await readFile(path.join(
    projectRoot,
    "docs/audits/bsc-metadata-audit-2026-11-01T08-14-16.554Z.json",
  ), "utf8"));
  const targets = getRecordedProbeTargets(previous);
  const result = await probeRecordedBlock({
    client,
    targets,
    maxRetries: 0,
  });
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.chainId, 56);
  assert.equal(result.blockNumber, String(RECORDED_METADATA_BLOCK));
  assert.equal(result.observedBlockHash, RECORDED_METADATA_BLOCK_HASH);
  assert.deepEqual(result.targets.map((target) => target.status), ["VERIFIED", "VERIFIED", "UNVERIFIED"]);
  assert.equal(result.targets[0].decimals, 18);
  assert.equal(result.targets[2].errorClassification, "TRANSPORT_TIMEOUT");
  assert.equal(calls.filter(([method]) => method === "eth_call").length, 2);
  assert.ok(calls.filter(([method]) => method === "eth_getCode" || method === "eth_call")
    .every((call) => call[call[0] === "eth_getCode" ? 2 : 3] === RECORDED_METADATA_BLOCK));
});

test("public endpoint current state can succeed while recorded historical reads fail", async () => {
  const primary = archiveRpc({ historicalFailure: true });
  const result = await diagnoseArchiveState({
    primary: { ...primary, identity: "https://public.example/<redacted>", operator: "public-a" },
    targets: ARCHIVE_TARGETS,
  });
  assert.equal(result.status, "ARCHIVE_STATE_ACCESS_NOT_ESTABLISHED");
  assert.equal(result.primary.chainId, 56);
  assert.equal(result.primary.historicalBlockHash, RECORDED_METADATA_BLOCK_HASH);
  assert.equal(result.targetComparisons.length, 3);
  assert.ok(result.targetComparisons.every((target) =>
    target.currentState.status === "VERIFIED" &&
    target.currentState.contractCodePresent === true &&
    target.primaryHistorical.errorClassification === "RPC_HISTORICAL_STATE_UNAVAILABLE"
  ));
  assert.equal(primary.blockCalls.filter(([method]) => method === "eth_call").length, 0);
  assert.equal(primary.blockCalls.filter(([method]) => method === "eth_getCode").length, 6);
});

test("archive endpoint verifies historical metadata only at the recorded block", async () => {
  const primary = archiveRpc({ historicalFailure: true });
  const archive = archiveRpc({ id: "archive", decimals: 8 });
  const result = await diagnoseArchiveState({
    primary: { ...primary, identity: "https://public.example/<redacted>", operator: "public-a" },
    archive: {
      ...archive,
      identity: "https://archive.example/<redacted>",
      operator: "archive-b",
      independenceAttested: true,
    },
    targets: ARCHIVE_TARGETS,
  });
  assert.equal(result.status, "HISTORICAL_STATE_ACCESS_VERIFIED_FOR_PROBE_TARGETS");
  assert.equal(result.providerIndependence, "OPERATOR_ATTESTED_INDEPENDENT");
  assert.equal(result.targetComparisons.every((target) =>
    target.archiveHistorical?.status === "VERIFIED" &&
    target.archiveHistorical.decimals === 8 &&
    target.providersAgree === false
  ), true);
  assert.ok(archive.blockCalls.filter(([method]) => method === "eth_getCode" || method === "eth_call")
    .every((call) => call[call[0] === "eth_getCode" ? 2 : 3] === RECORDED_METADATA_BLOCK));
  assert.equal(archive.blockCalls.filter(([method]) => method === "eth_call").length, 3);
  assert.equal(primary.blockCalls.filter(([method, , blockNumber]) =>
    method === "eth_getCode" && blockNumber === RECORDED_METADATA_BLOCK
  ).length, 3);
  assert.equal(archive.blockCalls.filter(([method, , blockNumber]) =>
    method === "eth_getCode" && blockNumber === RECORDED_METADATA_BLOCK
  ).length, 3);
});

test("matching independent historical providers cross-verify; divergence does not", async () => {
  const primary = archiveRpc({ decimals: 8 });
  const archive = archiveRpc({ id: "archive", decimals: 8 });
  const matching = await diagnoseArchiveState({
    primary: { ...primary, identity: "https://primary.example/<redacted>", operator: "operator-a" },
    archive: {
      ...archive,
      identity: "https://archive.example/<redacted>",
      operator: "operator-b",
      independenceAttested: true,
    },
    targets: ARCHIVE_TARGETS,
  });
  assert.equal(matching.status, "HISTORICAL_STATE_CROSS_VERIFIED_FOR_PROBE_TARGETS");
  assert.ok(matching.targetComparisons.every((target) => target.providersAgree === true));

  const diverging = await diagnoseArchiveState({
    primary: { ...archiveRpc({ decimals: 8 }), identity: "https://primary.example/<redacted>", operator: "operator-a" },
    archive: {
      ...archiveRpc({
        id: "archive",
        decimals: 6,
        code: (address) => address.toLowerCase() === BSC_USDT_ADDRESS.toLowerCase() ? "0x6001" : "0x6000",
      }),
      identity: "https://archive.example/<redacted>",
      operator: "operator-b",
      independenceAttested: true,
    },
    targets: ARCHIVE_TARGETS,
  });
  assert.equal(diverging.status, "HISTORICAL_STATE_ACCESS_VERIFIED_FOR_PROBE_TARGETS");
  assert.equal(diverging.targetComparisons.every((target) => target.providersAgree === false), true);
});

test("archive block mismatch, empty code, failed reads, and same-operator endpoints fail closed", async () => {
  const primary = archiveRpc({ historicalFailure: true });
  const archive = archiveRpc({
    id: "archive",
    blockHash: OTHER_BLOCK_HASH,
    code: (address, blockNumber) => {
      if (blockNumber === RECORDED_METADATA_BLOCK && address.toLowerCase() === BSC_USDT_ADDRESS.toLowerCase()) {
        return "0x";
      }
      return "0x6000";
    },
  });
  const mismatch = await diagnoseArchiveState({
    primary: { ...primary, identity: "https://same.example/<redacted>", operator: "same" },
    archive: { ...archive, identity: "https://same.example/<redacted>", operator: "same" },
    targets: ARCHIVE_TARGETS,
  });
  assert.equal(mismatch.archive.errorClassification, "BLOCK_HASH_MISMATCH");
  assert.equal(mismatch.providerIndependence, "NOT_ESTABLISHED");
  assert.equal(mismatch.targetComparisons[0].archiveHistorical.errorClassification, "BLOCK_HASH_MISMATCH");
  assert.equal(archive.blockCalls.some(([method]) => method === "eth_getCode"), false);

  const failed = archiveRpc({
    code: (address, blockNumber) => {
      if (blockNumber === RECORDED_METADATA_BLOCK && address.toLowerCase() === BSC_USDT_ADDRESS.toLowerCase()) {
        throw Object.assign(new Error("historical state unavailable; api_key=secret"), { code: -32000 });
      }
      if (blockNumber === RECORDED_METADATA_BLOCK && address.toLowerCase() === ARCHIVE_TARGETS[1].address.toLowerCase()) {
        return "0x";
      }
      return "0x6000";
    },
  });
  const outcomes = await diagnoseArchiveState({
    primary: { ...failed, identity: "https://public.example/<redacted>", operator: "public-a" },
    targets: ARCHIVE_TARGETS,
  });
  const historic = outcomes.targetComparisons.map((target) => target.primaryHistorical);
  assert.equal(historic[0].errorClassification, "RPC_HISTORICAL_STATE_UNAVAILABLE");
  assert.equal(historic[0].requestDiagnostics[0].providerMessage, "historical state unavailable; api_key=[redacted]");
  assert.equal(historic[1].errorClassification, "MISSING_CONTRACT_CODE");
  assert.equal(historic[1].contractCodePresent, false);
  assert.equal(historic[2].status, "VERIFIED");
  assert.equal(outcomes.archive, null);
});

test("archive probe plan redacts endpoints, defaults to dry-run, and requires exact confirmation", () => {
  const config = resolveArchiveProbeConfig({
    BSC_RPC_URL: "https://primary.example/secure/path?key=not-for-output",
    BSC_RPC_ARCHIVE_URL: "https://archive.example/rpc?token=also-secret",
    BSC_RPC_OPERATOR: "provider-primary",
    BSC_RPC_ARCHIVE_OPERATOR: "provider-archive",
    BSC_RPC_ARCHIVE_INDEPENDENCE_CONFIRMED: "I_CONFIRM_SEPARATE_OPERATORS",
  });
  const plan = formatArchiveProbePlan(config);
  assert.match(plan, /DRY RUN/);
  assert.match(plan, /https:\/\/primary\.example\/<redacted>/);
  assert.match(plan, /https:\/\/archive\.example\/<redacted>/);
  assert.match(plan, /131014770/);
  assert.match(plan, /0x993c869807f1090f1642ef6f9a607770eb051406fcd6d9ab03cc310a676fd36e/);
  assert.match(plan, /operator attestation configured/);
  assert.doesNotMatch(plan, /not-for-output|also-secret|secure\/path/);
  assert.equal(requireArchiveProbeConfirmation(ARCHIVE_PROBE_CONFIRMATION), true);
  assert.equal(requireArchiveProbeConfirmation("yes"), false);
  assert.equal(resolveArchiveProbeConfig({}).archiveUrl, null);
  assert.match(formatArchiveProbePlan({ ...config, primaryOnly: true }), /excluded by --primary-only/);
  assert.equal(resolveArchiveProbeConfig({
    BSC_RPC_OPERATOR: "one",
    BSC_RPC_ARCHIVE_OPERATOR: "two",
    BSC_RPC_ARCHIVE_INDEPENDENCE_CONFIRMED: "I_CONFIRM_SEPARATE_OPERATORS",
  }).operatorIndependenceConfirmed, true);
});

test("archive probe CLI makes no default requests and refuses live mode without typed terminal", () => {
  const script = path.resolve("scripts/bsc-archive-probe.mjs");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    BSC_RPC_URL: "",
    BSC_RPC_ARCHIVE_URL: "",
    NEXT_PUBLIC_BSC_RPC_URL: "https://archive-dry-run.example/",
  };
  delete env.__NEXT_PROCESSED_ENV;
  const dryRun = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--experimental-strip-types",
    script,
  ], { encoding: "utf8", env });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /DRY RUN/);
  assert.match(dryRun.stdout, /No network request was made/);
  assert.match(dryRun.stdout, /archive-dry-run\.example/);

  const notConfirmed = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--experimental-strip-types",
    script,
    "--live-read-only",
  ], { encoding: "utf8", env });
  assert.equal(notConfirmed.status, 1);
  assert.match(notConfirmed.stderr, /interactive terminal for typed confirmation/);
  assert.match(notConfirmed.stdout, /No network request was made/);

  const primaryOnly = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--experimental-strip-types",
    script,
    "--live-read-only",
    "--primary-only",
  ], {
    encoding: "utf8",
    env: { ...env, BSC_RPC_ARCHIVE_URL: "https://archive.example/rpc?secret=hidden" },
  });
  assert.equal(primaryOnly.status, 1);
  assert.match(primaryOnly.stdout, /excluded by --primary-only/);
  assert.doesNotMatch(primaryOnly.stdout, /archive\.example|hidden/);
});

test("viem serializes latest and numeric eth_getCode block selectors canonically", async () => {
  const recorder = createRpcWireRecorder(async (_input, init) => {
    const request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: "0x6000",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const chain = defineChain({
    id: 56,
    name: "test",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.test"] } },
  });
  const client = createPublicClient({
    chain,
    transport: http("https://rpc.test", {
      fetchFn: recorder.fetchFn,
      retryCount: 0,
    }),
  });
  const instrumented = createInstrumentedArchiveClient(client, recorder);
  assert.equal(await instrumented.getBytecode({ address: BSC_USDT_ADDRESS }), "0x6000");
  assert.equal(await instrumented.getBytecode({
    address: BSC_USDT_ADDRESS,
    blockNumber: RECORDED_METADATA_BLOCK,
  }), "0x6000");
  const requests = recorder.snapshot();
  assert.deepEqual(requests.map((request) => ({
    method: request.method,
    parameterCount: request.parameterCount,
    targetAddress: request.targetAddress,
    blockParameterType: request.blockParameterType,
    serializedBlockParameter: request.serializedBlockParameter,
    inputBlockNumberType: request.inputBlockNumberType,
    attempt: request.attempt,
    httpStatus: request.httpStatus,
    validJsonRpcResponse: request.validJsonRpcResponse,
  })), [
    {
      method: "eth_getCode",
      parameterCount: 2,
      targetAddress: BSC_USDT_ADDRESS.toLowerCase(),
      blockParameterType: "block-tag",
      serializedBlockParameter: "latest",
      inputBlockNumberType: "undefined",
      attempt: 1,
      httpStatus: 200,
      validJsonRpcResponse: true,
    },
    {
      method: "eth_getCode",
      parameterCount: 2,
      targetAddress: BSC_USDT_ADDRESS.toLowerCase(),
      blockParameterType: "hex-quantity",
      serializedBlockParameter: "0x7cf2072",
      inputBlockNumberType: "bigint",
      attempt: 1,
      httpStatus: 200,
      validJsonRpcResponse: true,
    },
  ]);
  assert.ok(requests.every((request) => request.responseDurationMs >= 0));
  assert.equal(requests[0].serializedBlockParameter, "latest");
});

test("wire recorder captures provider errors, empty code, and sanitized request details", async () => {
  const recorder = createRpcWireRecorder(async (_input, init) => {
    const request = JSON.parse(String(init.body));
    const response = request.params[1] === "0x7cf2072"
      ? {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: "Missing or invalid parameters. api_key=must-not-leak",
        },
      }
      : { jsonrpc: "2.0", id: request.id, result: "0x" };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const chain = defineChain({
    id: 56,
    name: "test",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.test"] } },
  });
  const client = createPublicClient({
    chain,
    transport: http("https://rpc.test", { fetchFn: recorder.fetchFn, retryCount: 0 }),
  });
  assert.equal(await client.getBytecode({ address: BSC_USDT_ADDRESS }), undefined);
  await assert.rejects(client.getBytecode({
    address: BSC_USDT_ADDRESS,
    blockNumber: RECORDED_METADATA_BLOCK,
  }));
  const [latest, historical] = recorder.snapshot();
  assert.equal(latest.serializedBlockParameter, "latest");
  assert.equal(latest.providerMessage, null);
  assert.equal(historical.method, "eth_getCode");
  assert.equal(historical.parameterCount, 2);
  assert.equal(historical.targetAddress, BSC_USDT_ADDRESS.toLowerCase());
  assert.equal(historical.blockParameterType, "hex-quantity");
  assert.equal(historical.serializedBlockParameter, "0x7cf2072");
  assert.equal(historical.jsonRpcErrorCode, -32000);
  assert.equal(historical.errorClass, "RPC_INVALID_PARAMETERS");
  assert.equal(historical.retryable, false);
  assert.equal(
    historical.providerMessage,
    "Missing or invalid parameters. api_key=[redacted]",
  );
  assert.doesNotMatch(JSON.stringify(recorder.snapshot()), /must-not-leak|rpc\.test/);
});

test("wire recorder distinguishes historical-state errors from malformed JSON-RPC responses", async () => {
  const recorder = createRpcWireRecorder(async (_input, init) => {
    const request = JSON.parse(String(init.body));
    const isHistorical = request.params[1] === "0x7cf2072";
    return new Response(JSON.stringify(isHistorical
      ? {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "Historical state unavailable" },
      }
      : { jsonrpc: "2.0", id: request.id + 1, result: "0x6000" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const chain = defineChain({
    id: 56,
    name: "test",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.test"] } },
  });
  const client = createPublicClient({
    chain,
    transport: http("https://rpc.test", { fetchFn: recorder.fetchFn, retryCount: 0 }),
  });
  await assert.rejects(client.getBytecode({ address: BSC_USDT_ADDRESS }));
  await assert.rejects(client.getBytecode({
    address: BSC_USDT_ADDRESS,
    blockNumber: RECORDED_METADATA_BLOCK,
  }));
  const [latest, historical] = recorder.snapshot();
  assert.equal(latest.validJsonRpcResponse, false);
  assert.equal(latest.errorClass, "INVALID_RPC_RESPONSE");
  assert.equal(historical.validJsonRpcResponse, true);
  assert.equal(historical.errorClass, "RPC_HISTORICAL_STATE_UNAVAILABLE");
  assert.equal(historical.retryable, true);
  assert.equal(historical.attempt, 1);
});

test("wire recorder classifies fetch aborts as timeouts, not provider error codes", async () => {
  const recorder = createRpcWireRecorder(async () => {
    throw Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
      code: 20,
    });
  });
  const chain = defineChain({
    id: 56,
    name: "test",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.test"] } },
  });
  const client = createPublicClient({
    chain,
    transport: http("https://rpc.test", {
      fetchFn: recorder.fetchFn,
      retryCount: 0,
    }),
  });
  await assert.rejects(client.getChainId());
  const [request] = recorder.snapshot();
  assert.equal(request.method, "eth_chainId");
  assert.equal(request.parameterCount, 0);
  assert.equal(request.errorClass, "TRANSPORT_TIMEOUT");
  assert.equal(request.retryable, true);
  assert.equal(request.jsonRpcErrorCode, null);
});

test("strict block validation rejects missing, invalid, and unsupported object selectors", () => {
  assert.equal(requireRpcBlockNumber(RECORDED_METADATA_BLOCK), undefined);
  assert.throws(() => requireRpcBlockNumber(undefined), /non-negative bigint/);
  assert.throws(() => requireRpcBlockNumber("131014770"), /non-negative bigint/);
  assert.throws(() => requireRpcBlockNumber(-1n), /non-negative bigint/);
  assert.throws(() => requireRpcBlockNumber({ blockNumber: RECORDED_METADATA_BLOCK }), /non-negative bigint/);
});

test("request-semantics dry-run plan and explicit live confirmation are enforced", () => {
  const endpoint = resolveRpcSemanticsUrl({
    BSC_RPC_URL: "https://rpc.example/private/path?token=hidden",
  });
  const plan = formatRpcSemanticsPlan(endpoint.identity);
  assert.match(plan, /DRY RUN/);
  assert.match(plan, /eth_getCode/);
  assert.match(plan, /131014770/);
  assert.match(plan, /No network request was made/);
  assert.doesNotMatch(plan, /private\/path|hidden/);
  assert.equal(requireRpcSemanticsConfirmation(RPC_SEMANTICS_CONFIRMATION), true);
  assert.equal(requireRpcSemanticsConfirmation("READ-ONLY ARCHIVE STATE PROBE"), false);
  assert.throws(() => resolveRpcSemanticsUrl({
    NEXT_PUBLIC_BSC_RPC_URL: "https://rpc.example/path/token",
  }), /without credentials, path tokens/);
});

test("probe refuses unexpected addresses and stops on chain or block mismatch", async () => {
  const previous = JSON.parse(await readFile(path.join(
    projectRoot,
    "docs/audits/bsc-metadata-audit-2026-11-01T08-14-16.554Z.json",
  ), "utf8"));
  const targets = getRecordedProbeTargets(previous);
  await assert.rejects(
    probeRecordedBlock({
      client: rpc().client,
      targets: [...targets.slice(0, 2), { ...targets[2], address: TOKEN }],
    }),
    /fixed USDT and two audit-confirmed/,
  );
  await assert.rejects(
    probeRecordedBlock({
      client: rpc().client,
      targets: [...targets.slice(0, 2), { ...targets[2], label: "previously-successful" }],
    }),
    /fixed USDT and two audit-confirmed/,
  );

  let contractCalls = 0;
  const chainMismatch = await probeRecordedBlock({
    client: { ...rpc({ chainId: 97 }).client, getBlock: async () => ({ hash: RECORDED_METADATA_BLOCK_HASH }), getBytecode: async () => { contractCalls += 1; return "0x6000"; }, readContract: async () => 18 },
    targets,
    maxRetries: 0,
  });
  assert.equal(chainMismatch.errorClassification, "CHAIN_ID_MISMATCH");
  assert.equal(contractCalls, 0);

  const blockMismatch = await probeRecordedBlock({
    client: { ...rpc().client, getChainId: async () => 56, getBlock: async () => ({ hash: OTHER_BLOCK_HASH }), getBytecode: async () => { contractCalls += 1; return "0x6000"; }, readContract: async () => 18 },
    targets,
    maxRetries: 0,
  });
  assert.equal(blockMismatch.errorClassification, "BLOCK_HASH_MISMATCH");
  assert.equal(contractCalls, 0);
});

test("successful empty-code response differs from RPC failure in probe and audit", async () => {
  const previous = JSON.parse(await readFile(path.join(
    projectRoot,
    "docs/audits/bsc-metadata-audit-2026-11-01T08-14-16.554Z.json",
  ), "utf8"));
  const targets = getRecordedProbeTargets(previous);
  const probeClient = {
    async getChainId() { return 56; },
    async getBlock() { return { hash: RECORDED_METADATA_BLOCK_HASH }; },
    async getBytecode({ address }) {
      return address.toLowerCase() === RECORDED_PROBE_TOKEN_ADDRESSES[1] ? "0x" : "0x6000";
    },
    async readContract() { return 6; },
  };
  const result = await probeRecordedBlock({ client: probeClient, targets, maxRetries: 0 });
  assert.equal(result.targets[2].status, "UNSUPPORTED");
  assert.equal(result.targets[2].contractCodePresent, false);
  assert.equal(result.targets[2].errorClassification, "MISSING_CONTRACT_CODE");

  const failed = await auditBscCatalogueMetadata(
    catalogue(),
    mockOptions(rpc({ codeErrors: new Set([TOKEN.toLowerCase()]) })),
  );
  assert.equal(failed.assets[0].status, "UNVERIFIED");
  assert.equal(failed.assets[0].contractCodePresent, null);
});

test("duplicate eligible addresses are rejected before contract reads", async () => {
  const primary = rpc();
  const result = await auditBscCatalogueMetadata(
    catalogue([asset(TOKEN), asset(TOKEN.toUpperCase())]),
    mockOptions(primary),
  );
  assert.equal(result.duplicateEligibleAddressCount, 1);
  assert.ok(result.assets.every((entry) => entry.errorClassification === "DUPLICATE_ELIGIBLE_ADDRESS"));
  assert.equal(primary.calls.some(([method, address]) =>
    method === "eth_getCode" && address === TOKEN.toLowerCase()
  ), false);
});

test("audit pins bytecode and decimals reads to the captured BSC block", async () => {
  const primary = rpc();
  const result = await auditBscCatalogueMetadata(catalogue(), mockOptions(primary));
  assert.equal(result.status, "MOCK_VERIFIED");
  assert.equal(result.chainId, 56);
  assert.equal(result.blockNumber, "123456");
  assert.equal(result.assets[0].decimals, 8);
  assert.equal(result.usdt.decimals, 18);
  assert.equal(result.usdt.eligibility, "USDT_AUDIT_TARGET");
  for (const call of primary.calls.filter((call) =>
    call[0] === "eth_getCode" || call[0] === "eth_call"
  )) {
    const blockNumber = call[0] === "eth_getCode" ? call[2] : call[3];
    assert.equal(blockNumber, 123456n);
  }
  assert.deepEqual(new Set(primary.calls.map(([method]) => method)), new Set([
    "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_call",
  ]));
});

test("audit request sequence is sequential by default and concurrency is validated", async () => {
  const primary = rpc();
  await auditBscCatalogueMetadata(
    catalogue([asset(TOKEN), asset(OTHER_TOKEN, { underlyingTicker: "XYZ" })]),
    mockOptions(primary),
  );
  const calls = primary.calls;
  const tokenFirstCode = calls.findIndex(([method, address]) => method === "eth_getCode" && address === TOKEN);
  const tokenDecimals = calls.findIndex(([method, , address]) => method === "eth_call" && address === TOKEN);
  const secondCode = calls.findIndex(([method, address]) => method === "eth_getCode" && address === OTHER_TOKEN);
  assert.ok(tokenFirstCode < tokenDecimals && tokenDecimals < secondCode);
  await assert.rejects(
    auditBscCatalogueMetadata(catalogue(), { ...mockOptions(), concurrency: 5 }),
    /concurrency must be between 1 and 4/i,
  );
});

test("wrong chain and invalid block hash fail closed", async () => {
  await assert.rejects(
    auditBscCatalogueMetadata(catalogue(), mockOptions(rpc({ chainId: 97 }))),
    BscMetadataAuditError,
  );
  await assert.rejects(
    auditBscCatalogueMetadata(catalogue(), mockOptions(rpc({ blockHash: "0x1234" }))),
    /valid hash/,
  );
});

test("malformed catalogue addresses are rejected without requesting them", async () => {
  const primary = rpc();
  const result = await auditBscCatalogueMetadata(
    catalogue([asset("not-an-address")]),
    mockOptions(primary),
  );
  assert.equal(result.assets[0].status, "UNSUPPORTED");
  assert.equal(result.assets[0].errorClassification, "INVALID_CATALOGUE_ADDRESS");
  assert.equal(primary.calls.some(([method, address]) =>
    (method === "eth_getCode" || method === "eth_call") && address === "not-an-address"
  ), false);
});

test("secondary RPC is used only when operator labels establish independence", async () => {
  const primary = rpc({ operator: "" });
  const secondary = rpc({ id: "secondary", operator: "operator-b" });
  const result = await auditBscCatalogueMetadata(catalogue(), {
    ...mockOptions(primary, secondary),
    evidenceMode: "MOCK",
  });
  assert.equal(result.secondaryRpcId, null);
  assert.equal(secondary.calls.length, 0);
});

test("matching independent RPC results are cross-verified at the same block", async () => {
  const primary = rpc();
  const secondary = rpc({ id: "secondary", operator: "operator-b" });
  const result = await auditBscCatalogueMetadata(catalogue(), mockOptions(primary, secondary));
  assert.equal(result.status, "MOCK_VERIFIED");
  assert.equal(result.rpcVerificationCount, 2);
  assert.equal(result.assets[0].rpcVerificationCount, 2);
  assert.equal(result.usdt.rpcVerificationCount, 2);
  assert.equal(result.rpcBlockHashes.primary, result.rpcBlockHashes.secondary);
});

test("different block hashes and differing contract results are reported as RPC divergence", async () => {
  const primary = rpc();
  const differentBlock = rpc({
    id: "secondary",
    operator: "operator-b",
    blockHash: OTHER_BLOCK_HASH,
  });
  const blockResult = await auditBscCatalogueMetadata(
    catalogue(),
    mockOptions(primary, differentBlock),
  );
  assert.equal(blockResult.status, "RPC_DIVERGENCE");
  assert.equal(blockResult.assets[0].errorClassification, "BLOCK_HASH_MISMATCH");
  assert.equal(differentBlock.calls.some(([method]) => method === "eth_getCode"), false);

  const differentDecimals = rpc({
    id: "secondary",
    operator: "operator-b",
    decimals: new Map([[TOKEN.toLowerCase(), 6], [BSC_USDT_ADDRESS.toLowerCase(), 18]]),
  });
  const decimalResult = await auditBscCatalogueMetadata(
    catalogue(),
    mockOptions(rpc(), differentDecimals),
  );
  assert.equal(decimalResult.status, "RPC_DIVERGENCE");
  assert.equal(decimalResult.assets[0].errorClassification, "CONTRACT_RESULT_MISMATCH");

  const differentCode = rpc({
    id: "secondary",
    operator: "operator-b",
    code: (address) => address.toLowerCase() === TOKEN.toLowerCase() ? "0x6001" : "0x6000",
  });
  const codeResult = await auditBscCatalogueMetadata(catalogue(), mockOptions(rpc(), differentCode));
  assert.equal(codeResult.assets[0].errorClassification, "CONTRACT_RESULT_MISMATCH");
});

test("secondary chain mismatch is reported without combining RPC evidence", async () => {
  const result = await auditBscCatalogueMetadata(
    catalogue(),
    mockOptions(rpc(), rpc({ id: "secondary", operator: "operator-b", chainId: 97 })),
  );
  assert.equal(result.status, "RPC_DIVERGENCE");
  assert.equal(result.assets[0].errorClassification, "SECONDARY_CHAIN_ID_MISMATCH");
  assert.equal(result.assets[0].rpcVerificationCount, 1);
});

test("missing bytecode, reverted calls, malformed ABI values, and unsupported decimals are rejected", async () => {
  const missingCode = await auditBscCatalogueMetadata(
    catalogue(),
    mockOptions(rpc({ code: (address) => address.toLowerCase() === TOKEN.toLowerCase() ? "0x" : "0x6000" })),
  );
  assert.equal(missingCode.assets[0].errorClassification, "MISSING_CONTRACT_CODE");
  assert.equal(missingCode.assets[0].contractCodePresent, false);

  const reverted = await auditBscCatalogueMetadata(
    catalogue(),
    mockOptions(rpc({ readErrors: new Set([TOKEN.toLowerCase()]) })),
  );
  assert.equal(reverted.assets[0].status, "UNVERIFIED");
  assert.equal(reverted.assets[0].errorClassification, "RPC_PROVIDER_ERROR");
  assert.equal(reverted.assets[0].rpcDiagnostics[1].method, "eth_call");
  assert.equal(reverted.assets[0].rpcDiagnostics[1].validRpcResponse, true);

  for (const value of [undefined, null, "8", 8n, 1.5, 256, -1]) {
    const malformed = await auditBscCatalogueMetadata(
      catalogue(),
      mockOptions(rpc({
        decimals: (address) => address.toLowerCase() === TOKEN.toLowerCase() ? value : 18,
      })),
    );
    assert.equal(malformed.assets[0].errorClassification, "INVALID_RPC_RESPONSE");
    assert.equal(malformed.assets[0].rpcDiagnostics.at(-1).validRpcResponse, false);
    assert.equal(malformed.assets[0].rpcDiagnostics.at(-1).succeeded, false);
  }

  const unsupported = await auditBscCatalogueMetadata(
    catalogue(),
    mockOptions(rpc({
      decimals: (address) => address.toLowerCase() === TOKEN.toLowerCase() ? 19 : 18,
    })),
  );
  assert.equal(unsupported.assets[0].errorClassification, "DECIMALS_OUTSIDE_WOLV_RANGE");
  assert.equal(unsupported.assets[0].decimals, 19);
});

test("RPC errors distinguish HTTP, transport, JSON-RPC, and historical-state failures", () => {
  const diagnostic = (error) => classifyRpcFailure(error, {
    method: "eth_getCode",
    stage: "BYTECODE",
    attempt: 1,
    requestDurationMs: 17,
  });
  const rateLimit = diagnostic(Object.assign(new Error("limited"), {
    status: 429,
    headers: new Headers({ "retry-after": "2" }),
  }));
  assert.equal(rateLimit.errorClass, "HTTP_RATE_LIMIT");
  assert.equal(rateLimit.httpStatus, 429);
  assert.equal(rateLimit.retryAfterMs, 2_000);
  assert.equal(rateLimit.retryable, true);

  assert.equal(diagnostic(Object.assign(new Error("server"), { status: 503 })).errorClass, "HTTP_SERVER_ERROR");
  const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError", cause: { code: "ETIMEDOUT" } });
  assert.equal(diagnostic(timeout).errorClass, "TRANSPORT_TIMEOUT");
  const aborted = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
    code: 20,
  });
  assert.equal(diagnostic(aborted).errorClass, "TRANSPORT_TIMEOUT");
  assert.equal(diagnostic(aborted).providerErrorCode, null);
  assert.equal(diagnostic(aborted).causeChain[0].code, null);
  assert.equal(diagnostic(Object.assign(new Error("DNS"), { code: "ENOTFOUND" })).errorClass, "DNS_FAILURE");
  assert.equal(diagnostic(Object.assign(new Error("temporary DNS"), { code: "EAI_AGAIN" })).retryable, true);
  assert.equal(diagnostic(Object.assign(new Error("reset"), { code: "ECONNRESET" })).errorClass, "CONNECTION_RESET");
  assert.equal(diagnostic(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })).errorClass, "CONNECTION_REFUSED");

  const invalidParameters = Object.assign(new Error("invalid params"), { code: -32602 });
  assert.equal(diagnostic(invalidParameters).errorClass, "RPC_INVALID_PARAMETERS");
  assert.equal(diagnostic(invalidParameters).validRpcResponse, true);
  assert.equal(diagnostic(invalidParameters).retryable, false);
  const providerInvalidParameters = Object.assign(
    new Error("Missing or invalid parameters. Double check you have provided the correct parameters."),
    { code: -32000 },
  );
  assert.equal(diagnostic(providerInvalidParameters).errorClass, "RPC_INVALID_PARAMETERS");
  assert.equal(diagnostic(providerInvalidParameters).validRpcResponse, true);
  assert.equal(diagnostic(providerInvalidParameters).retryable, false);
  const historical = Object.assign(new Error("historical state unavailable"), { code: -32000 });
  assert.equal(diagnostic(historical).errorClass, "RPC_HISTORICAL_STATE_UNAVAILABLE");
  assert.equal(diagnostic(historical).providerMessage, "historical state unavailable");
  const missingHeader = Object.assign(new Error("header not found"), { code: -32000 });
  assert.equal(diagnostic(missingHeader).errorClass, "RPC_HEADER_NOT_FOUND");
  assert.equal(diagnostic(Object.assign(new Error("execution reverted"), { code: -32000 })).errorClass, "RPC_PROVIDER_ERROR");
  const redactedMessage = diagnostic(Object.assign(
    new Error("execution failed at https://rpc.example/path?api_key=hidden"),
    { code: -32000 },
  ));
  assert.equal(redactedMessage.providerMessage, "execution failed at [redacted URL]");
  assert.doesNotMatch(redactedMessage.providerMessage, /hidden|rpc\.example|path/);
  assert.equal(diagnostic(new Error("unexpected result")).errorClass, "TRANSPORT_ERROR");
  const secretCode = diagnostic(Object.assign(new Error("provider failure"), { code: "api-key-secret" }));
  assert.equal(secretCode.providerErrorCode, null);
  assert.deepEqual(secretCode.causeChain[0], { name: "Error", code: null });
});

test("RPC retry policy is bounded, deterministic, and honors Retry-After", async () => {
  let attempts = 0;
  const waits = [];
  const result = await runRpcRead({
    method: "eth_getCode",
    stage: "BYTECODE",
    maxRetries: 2,
    random: () => 0,
    sleep: async (milliseconds) => waits.push(milliseconds),
    operation: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      return "0x6000";
    },
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [250, 500]);
  assert.deepEqual(result.diagnostics.map((item) => item.attempt), [1, 2, 3]);
  assert.deepEqual(result.diagnostics.map((item) => item.succeeded), [false, false, true]);

  let rateLimitAttempts = 0;
  const rateLimitWaits = [];
  const rateLimited = await runRpcRead({
    method: "eth_getCode",
    stage: "BYTECODE",
    maxRetries: 1,
    random: () => 0,
    sleep: async (milliseconds) => rateLimitWaits.push(milliseconds),
    operation: async () => {
      rateLimitAttempts += 1;
      throw Object.assign(new Error("rate limited"), {
        status: 429,
        headers: new Headers({ "retry-after": "1" }),
      });
    },
  });
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimitAttempts, 2);
  assert.deepEqual(rateLimitWaits, [1_000]);

  let invalidParameterAttempts = 0;
  const invalidParameters = await runRpcRead({
    method: "eth_getCode",
    stage: "BYTECODE",
    operation: async () => {
      invalidParameterAttempts += 1;
      throw Object.assign(new Error("invalid params"), { code: -32602 });
    },
  });
  assert.equal(invalidParameters.ok, false);
  assert.equal(invalidParameterAttempts, 1);
});

test("concurrency scheduler enforces the bound and preserves input order", async () => {
  let active = 0;
  let maximumActive = 0;
  const started = [];
  const results = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
    started.push(value);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 10;
  });
  assert.equal(maximumActive, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.deepEqual(results, [0, 10, 20, 30, 40]);
});

test("catalogue decimal conflicts and USDT failures remain explicit", async () => {
  const conflict = await auditBscCatalogueMetadata(
    catalogue([asset(TOKEN, { decimals: 6 })]),
    mockOptions(),
  );
  assert.equal(conflict.assets[0].errorClassification, "CATALOGUE_DECIMALS_CONFLICT");
  assert.equal(conflict.assets[0].catalogueDecimals, 6);

  const failedUsdt = await auditBscCatalogueMetadata(
    catalogue(),
    mockOptions(rpc({ code: (address) => address.toLowerCase() === BSC_USDT_ADDRESS.toLowerCase() ? "0x" : "0x6000" })),
  );
  assert.equal(failedUsdt.usdt.status, "UNSUPPORTED");
  assert.equal(failedUsdt.usdt.errorClassification, "MISSING_CONTRACT_CODE");
});

test("zero and six decimal catalogue assets are accepted without a universal fallback", async () => {
  const result = await auditBscCatalogueMetadata(
    catalogue([
      asset(TOKEN, { underlyingTicker: "ZERO" }),
      asset(OTHER_TOKEN, { underlyingTicker: "SIX" }),
    ]),
    mockOptions(rpc({
      decimals: new Map([
        [TOKEN.toLowerCase(), 0],
        [OTHER_TOKEN.toLowerCase(), 6],
        [BSC_USDT_ADDRESS.toLowerCase(), 18],
      ]),
    })),
  );
  assert.deepEqual(result.assets.map((entry) => entry.decimals), [0, 6]);
});

test("catalogue sanitizer omits non-scalar and secret-shaped fields", () => {
  const sanitized = sanitizeCatalogue({
    data: [{
      ...asset(),
      decimals: 8,
      privateKey: "must-not-appear",
      apiToken: "must-not-appear",
      nested: { secret: "must-not-appear" },
    }],
  });
  assert.equal(sanitized.data[0].decimals, 8);
  assert.equal("privateKey" in sanitized.data[0], false);
  assert.equal("apiToken" in sanitized.data[0], false);
  assert.equal("nested" in sanitized.data[0], false);
});

test("dry-run plan redacts RPC credentials and does not request the network", () => {
  const plan = createAuditPlan({
    primaryRpcUrl: "https://user:secret@rpc.example/path/token?key=hidden",
    secondaryRpcUrl: "https://secondary.example/rpc?token=hidden",
  });
  const output = formatAuditPlan(plan);
  assert.match(output, /DRY RUN/);
  assert.match(output, /Unknown until the catalogue GET/);
  assert.doesNotMatch(output, /secret|hidden|\/path\/token/);
  assert.match(output, /No network request was made/);
});

test("audit command defaults to dry-run and performs no fetch", () => {
  const script = path.resolve("scripts/bsc-metadata-audit.mjs");
  const child = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--experimental-strip-types",
    script,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      BSC_RPC_URL: "",
      NEXT_PUBLIC_BSC_RPC_URL: "https://rpc.example/",
      BSC_RPC_SECONDARY_URL: "",
    },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /DRY RUN/);
  assert.match(child.stdout, /No network request was made/);
  assert.doesNotMatch(child.stdout, /test-secret|api_key|credential-value/i);
});

test("audit command rejects arbitrary address or execution arguments", () => {
  const script = path.resolve("scripts/bsc-metadata-audit.mjs");
  const child = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--experimental-strip-types",
    script,
    "--address",
    TOKEN,
  ], {
    encoding: "utf8",
    env: { ...process.env, BSC_RPC_URL: "", NEXT_PUBLIC_BSC_RPC_URL: "https://rpc.example/" },
  });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /Usage:/);
  assert.doesNotMatch(child.stdout, /No network request/);
});

test("operator confirmations require exact typed phrases", () => {
  assert.equal(requireExplicitConfirmation("READ-ONLY CATALOGUE", "READ-ONLY CATALOGUE"), true);
  assert.equal(requireExplicitConfirmation("read-only catalogue", "READ-ONLY CATALOGUE"), false);
  assert.equal(requireExplicitConfirmation("READ-ONLY BSC RPC ", "READ-ONLY BSC RPC"), true);
  assert.equal(requireProbeConfirmation(PROBE_CONFIRMATION), true);
  assert.equal(requireProbeConfirmation("READ-ONLY BSC RPC"), false);
});

test("full catalogue audit concurrency is explicit, bounded, and defaults to one", () => {
  assert.deepEqual(parseAuditArgs([]), { liveReadOnly: false, concurrency: 1 });
  assert.deepEqual(parseAuditArgs(["--live-read-only", "--concurrency", "2"]), {
    liveReadOnly: true,
    concurrency: 2,
  });
  assert.throws(() => parseAuditArgs(["--concurrency", "5"]), /from 1 to 4/i);
  assert.throws(() => parseAuditArgs(["--address", TOKEN]), /Invalid audit arguments/);
});

test("probe dry-run is read-only and redacts endpoint credentials", () => {
  const plan = formatProbePlan(redactRpcEndpointIdentity(
    "https://rpc-user:rpc-secret@node.example/path/token?key=hidden",
  ));
  assert.match(plan, /DRY RUN/);
  assert.match(plan, /131014770/);
  assert.match(plan, /READ-ONLY RECORDED-BLOCK PROBE/);
  assert.doesNotMatch(plan, /rpc-secret|hidden|path\/token/);
  assert.match(plan, /No network request was made/);
});

test("probe CLI defaults to dry-run and refuses arbitrary target arguments", () => {
  const script = path.resolve("scripts/bsc-metadata-probe.mjs");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    BSC_RPC_URL: "",
    NEXT_PUBLIC_BSC_RPC_URL: "https://dry-run-probe.example/",
  };
  delete env.__NEXT_PROCESSED_ENV;
  const dryRun = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--experimental-strip-types",
    script,
  ], { encoding: "utf8", env });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /DRY RUN/);
  assert.match(dryRun.stdout, /No network request was made/);
  assert.match(dryRun.stdout, /https:\/\/dry-run-probe\.example\/<redacted>/);

  const invalid = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--experimental-strip-types",
    script,
    "--address",
    TOKEN,
  ], { encoding: "utf8", env });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Usage:/);

  const liveWithoutConfirmation = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--experimental-strip-types",
    script,
    "--live-read-only",
  ], { encoding: "utf8", env });
  assert.equal(liveWithoutConfirmation.status, 1);
  assert.match(liveWithoutConfirmation.stderr, /interactive terminal for typed confirmation/);
  assert.match(liveWithoutConfirmation.stdout, /No network request was made/);
});

test("catalogue fetch is signed GET only and rejects malformed responses without real network access", async () => {
  const previous = {
    key: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET_KEY,
  };
  process.env.BINANCE_API_KEY = "test-api-key";
  process.env.BINANCE_SECRET_KEY = "test-secret-key";
  try {
    let request;
    const response = await fetchCatalogue(async (...args) => {
      request = args;
      return { ok: true, json: async () => catalogue() };
    });
    assert.equal(response.data.length, 1);
    assert.equal(request[1].method, "GET");
    assert.match(request[0], /\/build\/api\/v1\/dex\/market\/rwa\/tokens$/);
    assert.ok(request[1].headers["X-OC-SIGN"]);
    assert.doesNotMatch(JSON.stringify(request), /test-secret-key/);
    await assert.rejects(
      fetchCatalogue(async () => ({ ok: true, json: async () => ({ data: [{ secret: true }] }) })),
      /unexpected shape/,
    );
  } finally {
    if (previous.key === undefined) delete process.env.BINANCE_API_KEY;
    else process.env.BINANCE_API_KEY = previous.key;
    if (previous.secret === undefined) delete process.env.BINANCE_SECRET_KEY;
    else process.env.BINANCE_SECRET_KEY = previous.secret;
  }
});

test("standalone audit loads repository-root environment before dry-run", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "wolv-bsc-audit-env-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const scriptsDirectory = path.join(temporaryRoot, "scripts");
  await mkdir(scriptsDirectory);
  await symlink(path.join(projectRoot, "node_modules"), path.join(temporaryRoot, "node_modules"), "dir");
  await symlink(path.join(projectRoot, "lib"), path.join(temporaryRoot, "lib"), "dir");
  await writeFile(
    path.join(scriptsDirectory, "bsc-metadata-audit.mjs"),
    await readFile(path.join(projectRoot, "scripts/bsc-metadata-audit.mjs"), "utf8"),
  );
  await writeFile(
    path.join(temporaryRoot, ".env.local"),
    "NEXT_PUBLIC_BSC_RPC_URL=https://audit-env-load.example/\n",
  );
  const env = {
    ...process.env,
    NODE_ENV: "development",
    BSC_RPC_URL: "",
    BSC_RPC_SECONDARY_URL: "",
    BINANCE_API_KEY: "",
    BINANCE_SECRET_KEY: "",
  };
  delete env.NEXT_PUBLIC_BSC_RPC_URL;
  delete env.__NEXT_PROCESSED_ENV;
  const child = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--experimental-strip-types",
    path.join(scriptsDirectory, "bsc-metadata-audit.mjs"),
  ], { encoding: "utf8", env });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /https:\/\/audit-env-load\.example\/<redacted>/);
  assert.match(child.stdout, /No network request was made/);
});

test("missing Binance credentials are reported without fetching or exposing values", async () => {
  const previous = {
    key: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET_KEY,
  };
  delete process.env.BINANCE_API_KEY;
  delete process.env.BINANCE_SECRET_KEY;
  let fetchCalled = false;
  try {
    await assert.rejects(
      fetchCatalogue(async () => {
        fetchCalled = true;
        throw new Error("unexpected fetch");
      }),
      /Binance Web3 API credentials are not configured/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    if (previous.key === undefined) delete process.env.BINANCE_API_KEY;
    else process.env.BINANCE_API_KEY = previous.key;
    if (previous.secret === undefined) delete process.env.BINANCE_SECRET_KEY;
    else process.env.BINANCE_SECRET_KEY = previous.secret;
  }
});

test("public RPC URL policy rejects credentials and endpoint diagnostics redact private components", () => {
  assert.throws(() => resolvePublicRpcUrl(
    "https://rpc.example/path/token",
    "https://fallback.example",
    "NEXT_PUBLIC_BSC_RPC_URL",
  ), /without credentials/);
  const identity = redactRpcEndpointIdentity("https://user:secret@rpc.example/path/token?key=hidden");
  assert.equal(identity, "https://rpc.example/<redacted>");
  assert.doesNotMatch(identity, /secret|hidden|token/);
});

test("audit clients expose no transaction-writing methods", () => {
  const allowed = new Set(["getChainId", "getBlockNumber", "getBlock", "getBytecode", "readContract"]);
  const client = rpc().client;
  const clientMethods = Object.keys(client).filter((key) => typeof client[key] === "function");
  assert.ok(clientMethods.every((method) => allowed.has(method)));
});
