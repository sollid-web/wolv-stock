import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { BawExecutionMemoryTestStore } from "../services/bawExecutionStore.testAdapter.ts";
import {
  authorizeBawWalletRequest,
  isBawBrowserWalletAllowlistConfigured,
  createBawWalletSession,
  createBawWalletSessionChallenge,
  getBawWalletSession,
  revokeBawWalletSession,
} from "../services/bawWalletAuth.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("authorized browser-wallet session uses a one-time challenge and revocable HttpOnly cookie", async () => {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const now = 1_800_000_000_000;
  const store = new BawExecutionMemoryTestStore();
  const authOptions = { store, authorizedWallets: account.address };
  try {
    assert.equal(isBawBrowserWalletAllowlistConfigured(""), false);
    assert.equal(isBawBrowserWalletAllowlistConfigured("not-an-address"), false);
    assert.equal(isBawBrowserWalletAllowlistConfigured(account.address), true);
    const challengeRequest = new Request("https://wolv.test/api/agent/session/challenge", {
      method: "POST",
      headers: { origin: "https://wolv.test" },
    });
    const challenge = await createBawWalletSessionChallenge(account.address, challengeRequest, TOKEN, {
      ...authOptions,
      now,
    });
    assert.ok(challenge);
    const signature = await account.signMessage({ message: challenge.message });
    const sessionRequest = new Request("https://wolv.test/api/agent/session", {
      method: "POST",
      headers: { origin: "https://wolv.test" },
    });
    const session = await createBawWalletSession({
      address: account.address,
      message: challenge.message,
      signature,
    }, sessionRequest, TOKEN, { ...authOptions, now: now + 1 });
    assert.ok(session);
    assert.match(session.cookie, /HttpOnly/);
    assert.match(session.cookie, /SameSite=Strict/);
    assert.match(session.cookie, /Secure/);
    assert.equal(session.cookie.includes(TOKEN), false);

    const authorizedRequest = new Request("https://wolv.test/api/agent/execute", {
      method: "POST",
      headers: {
        origin: "https://wolv.test",
        cookie: session.cookie.split(";")[0],
      },
    });
    assert.equal(await authorizeBawWalletRequest(authorizedRequest, TOKEN, { ...authOptions, now: now + 2 }), "authorized");
    assert.equal((await getBawWalletSession(authorizedRequest, TOKEN, { ...authOptions, now: now + 2 }))?.address, account.address.toLowerCase());
    assert.equal(await getBawWalletSession(authorizedRequest, TOKEN, { ...authOptions, now: session.expiresAt }), null);

    const [cookieName, cookieValue] = session.cookie.split(";")[0].split("=");
    const tamperedValue = `${cookieValue.slice(0, -1)}${cookieValue.endsWith("a") ? "b" : "a"}`;
    const tamperedRequest = new Request("https://wolv.test/api/agent/execute", {
      headers: { cookie: `${cookieName}=${tamperedValue}` },
    });
    assert.equal(await getBawWalletSession(tamperedRequest, TOKEN, { ...authOptions, now: now + 2 }), null);

    const crossSiteRequest = new Request("https://wolv.test/api/agent/execute", {
      method: "POST",
      headers: {
        origin: "https://attacker.test",
        cookie: session.cookie.split(";")[0],
      },
    });
    assert.equal(await authorizeBawWalletRequest(crossSiteRequest, TOKEN, { ...authOptions, now: now + 2 }), "unauthorized");

    await revokeBawWalletSession(authorizedRequest, TOKEN, { ...authOptions, now: now + 3 });
    assert.equal(await getBawWalletSession(authorizedRequest, TOKEN, { ...authOptions, now: now + 4 }), null);

    const replay = await createBawWalletSession({
      address: account.address,
      message: challenge.message,
      signature,
    }, sessionRequest, TOKEN, { ...authOptions, now: now + 5 });
    assert.equal(replay, null);
  } finally {
    await store.close();
  }
});

test("browser-wallet authentication rejects unlisted identities, altered, expired, and invalidly signed challenges", async () => {
  const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const unlisted = privateKeyToAccount(`0x${"33".repeat(32)}`);
  const now = 1_800_000_000_000;
  const store = new BawExecutionMemoryTestStore();
  const authOptions = { store, authorizedWallets: account.address };
  try {
    const request = new Request("https://wolv.test/api/agent/session", {
      method: "POST",
      headers: { origin: "https://wolv.test" },
    });
    assert.equal(await createBawWalletSessionChallenge(unlisted.address, request, TOKEN, {
      ...authOptions,
      now,
    }), null);

    const challenge = await createBawWalletSessionChallenge(account.address, request, TOKEN, {
      ...authOptions,
      now,
    });
    assert.ok(challenge);
    const signature = await account.signMessage({ message: challenge.message });
    assert.equal(await createBawWalletSession({
      address: account.address,
      message: `${challenge.message} altered`,
      signature,
    }, request, TOKEN, { ...authOptions, now: now + 1 }), null);
    assert.equal(await createBawWalletSession({
      address: account.address,
      message: challenge.message,
      signature,
    }, request, TOKEN, { ...authOptions, now: challenge.expiresAt }), null);
    assert.equal(await createBawWalletSession({
      address: account.address,
      message: challenge.message,
      signature: `0x${"00".repeat(65)}`,
    }, request, TOKEN, { ...authOptions, now: now + 1 }), null);
  } finally {
    await store.close();
  }
});
