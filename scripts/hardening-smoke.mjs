import assert from "node:assert/strict";

const baseUrl = (process.env.BASE_URL || "https://wolv-stock.vercel.app").replace(/\/$/, "");

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, redirect: "manual" });
  const text = await response.text();
  return { response, text };
}

async function expectStatus(name, path, expected, options) {
  const { response, text } = await request(path, options);
  assert.equal(response.status, expected, `${name}: expected HTTP ${expected}, got ${response.status}: ${text.slice(0, 240)}`);
  return text;
}

for (const path of ["/", "/gap", "/trade", "/wallet"]) {
  const text = await expectStatus(`page ${path}`, path, 200);
  assert.ok(text.length > 500, `page ${path}: response is unexpectedly small`);
}

const home = await request("/");
assert.match(home.text, /WOLV Spot Lens/);
assert.match(home.text, /TOKENIZED STOCKS/);
assert.match(home.text, /ON-CHAIN EXECUTION/);
assert.match(home.text, /Execution opportunities/);
assert.match(home.text, /WOLV market intelligence/);
assert.doesNotMatch(home.text, /WOLV Stock Terminal/);

await expectStatus("quote missing parameters", "/api/quote", 400);
const minimumQuoteError = await expectStatus("quote below minimum", "/api/quote?toToken=0x0000000000000000000000000000000000000001&amount=2000000000000000000&userWalletAddress=0x1111111111111111111111111111111111111111", 400);
assert.match(minimumQuoteError, /minimum order amount is 5 USDT/i);
await expectStatus("swap missing quote binding", "/api/swap?toToken=0x0000000000000000000000000000000000000001&amount=1&userWalletAddress=0x1111111111111111111111111111111111111111&quoteId=test", 400);
await expectStatus("approval missing quote binding", "/api/approve-transaction?tokenContractAddress=0x55d398326f99059ff775485246999027B3197955&toToken=0x0000000000000000000000000000000000000001&approveAmount=1&userWalletAddress=0x1111111111111111111111111111111111111111", 400);
await expectStatus("portfolio invalid address", "/api/wallet/portfolio?address=invalid", 400);
await expectStatus("transaction status invalid hash", "/api/transaction-status?txHash=bad", 400);
await expectStatus("broadcast invalid payload", "/api/transaction/broadcast", 400, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
await expectStatus("analysis invalid payload", "/api/analyze", 400, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});

console.log(`Hardening smoke checks passed for ${baseUrl}`);
