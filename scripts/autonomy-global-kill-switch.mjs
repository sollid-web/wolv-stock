#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function buildGlobalControlRequest(args = [], env = process.env) {
  const release = args.includes("--release");
  if (args.includes("--engage") && release) throw new Error("Choose either --engage or --release, not both.");
  const reason = env.WOLV_AUTONOMY_GLOBAL_KILL_REASON?.trim() ||
    (release ? "OPERATOR_EXPLICIT_RELEASE" : "OPERATOR_MANUAL_STOP");
  if (reason.length < 3 || reason.length > 300) throw new Error("Global kill-switch reason must contain 3 to 300 characters.");
  return { p_kill_switch: !release, p_reason: reason };
}

export async function setGlobalKillSwitch(env = process.env, args = [], fetchImpl = fetch) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Supabase URL and server-only service-role key are required.");
  const payload = buildGlobalControlRequest(args, env);
  const response = await fetchImpl(url + "/rest/v1/rpc/wolv_set_autonomy_global_kill_switch", {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Global kill-switch update failed (" + response.status + "): " + (await response.text()).slice(0, 300));
  const result = await response.json();
  if (result !== true) throw new Error("Global kill-switch RPC did not confirm the update.");
  return { killSwitch: payload.p_kill_switch, reason: payload.p_reason };
}

function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
      }
    }
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  loadLocalEnv();
  try {
    const result = await setGlobalKillSwitch(process.env, process.argv.slice(2));
    console.log("[autonomy-global-control] killSwitch=" + result.killSwitch + " reason=" + result.reason);
  } catch (error) {
    console.error("[autonomy-global-control] failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  }
}
