import test from "node:test";
import assert from "node:assert/strict";
import { buildGlobalControlRequest, setGlobalKillSwitch } from "./autonomy-global-kill-switch.mjs";

const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-secret",
};

test("global control defaults to engaging the kill switch", () => {
  assert.deepEqual(buildGlobalControlRequest([], {}), {
    p_kill_switch: true, p_reason: "OPERATOR_MANUAL_STOP",
  });
});

test("releasing the global kill switch requires an explicit release flag", () => {
  assert.deepEqual(buildGlobalControlRequest(["--release"], {}), {
    p_kill_switch: false, p_reason: "OPERATOR_EXPLICIT_RELEASE",
  });
  assert.throws(() => buildGlobalControlRequest(["--release", "--engage"], {}), /Choose either/);
});

test("global control validates reason length", () => {
  assert.throws(() => buildGlobalControlRequest([], { WOLV_AUTONOMY_GLOBAL_KILL_REASON: "x" }), /3 to 300/);
});

test("global control calls only the server-side Supabase RPC", async () => {
  let captured;
  const result = await setGlobalKillSwitch(env, ["--release"], async (url, options) => {
    captured = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response("true", { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(result.killSwitch, false);
  assert.equal(captured.url, "https://project.supabase.co/rest/v1/rpc/wolv_set_autonomy_global_kill_switch");
  assert.equal(captured.options.headers.Authorization, "Bearer server-secret");
  assert.deepEqual(captured.body, { p_kill_switch: false, p_reason: "OPERATOR_EXPLICIT_RELEASE" });
});

test("global control fails without server credentials or a confirmed RPC result", async () => {
  await assert.rejects(setGlobalKillSwitch({}, []), /service-role key/);
  await assert.rejects(setGlobalKillSwitch(env, [], async () => new Response("false", { status: 200 })), /did not confirm/);
});
