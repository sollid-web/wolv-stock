import assert from "node:assert/strict";
import test from "node:test";
import { startMarketPulseRefresher } from "../lib/marketPulseRefresher.ts";

test("refresher is disabled without an https URL and a cron secret", () => {
  assert.equal(startMarketPulseRefresher({ url: "https://x.example/api", cronSecret: "" }), null);
  assert.equal(startMarketPulseRefresher({ url: "", cronSecret: "s" }), null);
  assert.equal(startMarketPulseRefresher({ url: "http://x.example/api", cronSecret: "s" }), null);
});

test("refresher calls the updater with the bearer secret and survives failures", async () => {
  const calls = [];
  const logs = [];
  let fail = false;
  const refresher = startMarketPulseRefresher({
    url: "https://www.example.test/api/updateMarketPulse", cronSecret: "top-secret", log: m => logs.push(m),
    fetchImpl: async (url, init) => { calls.push({ url: String(url), auth: init.headers.Authorization }); if (fail) throw new Error("timeout"); return new Response("{}", { status: 200 }); },
  });
  try {
    await new Promise(done => setImmediate(done));
    assert.equal(calls[0].url, "https://www.example.test/api/updateMarketPulse");
    assert.equal(calls[0].auth, "Bearer top-secret");
    fail = true;
    assert.equal(await refresher.refresh(), false);
    assert.match(logs.at(-1), /Market pulse refresh failed: timeout/);
    assert.ok(!logs.join(" ").includes("top-secret"), "the secret is never logged");
  } finally {
    refresher.stop();
  }
});
