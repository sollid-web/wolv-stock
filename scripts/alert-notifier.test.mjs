import assert from "node:assert/strict";
import test from "node:test";
import { createAlertNotifier } from "../lib/alertNotifier.ts";

const alert = { severity: "CRITICAL", kind: "WORKER_PANIC_STOP", message: "3 consecutive RPC failures", createdAt: 1 };

test("alert notifier is disabled without an https webhook", async () => {
  for (const webhookUrl of [undefined, "", "http://hooks.example.com/x", "not a url"]) {
    const notifier = createAlertNotifier({ webhookUrl, workerId: "w", fetchImpl: () => assert.fail("must not send") });
    assert.equal(notifier.enabled, false);
    assert.equal(await notifier.notify(alert), false);
  }
});

test("alert notifier sends CRITICAL alerts once per repeat window and skips lower severities", async () => {
  const sent = [];
  let clock = 0;
  const notifier = createAlertNotifier({
    webhookUrl: "https://hooks.example.com/abc", workerId: "railway-1", repeatWindowMs: 1_000, now: () => clock,
    fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); },
  });
  assert.equal(await notifier.notify({ ...alert, severity: "WARNING" }), false);
  assert.equal(await notifier.notify(alert), true);
  assert.equal(await notifier.notify(alert), false, "duplicate inside the window is suppressed");
  clock = 1_000;
  assert.equal(await notifier.notify(alert), true);
  assert.equal(sent.length, 2);
  assert.match(sent[0].body.text, /WOLV CRITICAL\] WORKER_PANIC_STOP on railway-1/);
  assert.equal(sent[0].body.content, sent[0].body.text);
});

test("alert notifier never throws when the webhook fails", async () => {
  const notifier = createAlertNotifier({ webhookUrl: "https://hooks.example.com/abc", workerId: "w", fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(await notifier.notify(alert), false);
});
