import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeBawWalletRequest } from "../services/bawWalletAuth.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

function requestWithAuthorization(value) {
    const headers = value === undefined ? undefined : { Authorization: value };
    return new Request("https://wolv.test/api/agent/wallet", { headers });
}

test("wallet API authorization is disabled unless a sufficiently long token is configured", () => {
    assert.equal(authorizeBawWalletRequest(requestWithAuthorization(`Bearer ${TOKEN}`), undefined), "not_configured");
    assert.equal(authorizeBawWalletRequest(requestWithAuthorization(`Bearer ${TOKEN}`), "too-short"), "not_configured");
});

test("wallet API authorization accepts only an exact bearer token", () => {
    assert.equal(authorizeBawWalletRequest(requestWithAuthorization(`Bearer ${TOKEN}`), TOKEN), "authorized");
    assert.equal(authorizeBawWalletRequest(requestWithAuthorization(undefined), TOKEN), "unauthorized");
    assert.equal(authorizeBawWalletRequest(requestWithAuthorization(`Basic ${TOKEN}`), TOKEN), "unauthorized");
    assert.equal(authorizeBawWalletRequest(requestWithAuthorization(`Bearer ${TOKEN.slice(0, -1)}x`), TOKEN), "unauthorized");
});
