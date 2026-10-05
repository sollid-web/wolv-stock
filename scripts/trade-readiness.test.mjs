import assert from "node:assert/strict";
import test from "node:test";
import {
  canExecuteTrade,
  displayOrderStatus,
  humanTransactionStatus,
  isFreshQuote,
  tradeErrorMessage,
  tradePhaseMessage,
  walletConnectionView,
} from "../lib/tradeReadiness.ts";

const ready = {
  isConnected: true,
  isCorrectNetwork: true,
  hasAddress: true,
  hasProvider: true,
  hasQuote: true,
  hasSwapData: true,
  quoteIsFresh: true,
  executionMode: "SWAP",
  swapSimulationStatus: "SUCCESS",
  requiresFreshQuote: false,
  isLoading: false,
  isSubmitting: false,
  isApproving: false,
  hasTransactionStatus: false,
  hasApprovalError: false,
  hasApprovalData: false,
  requiresTypedDataSignature: false,
  hasUserSignature: false,
};

test("allows direct SWAP only when its fresh quote has a successful simulation", () => {
  assert.equal(canExecuteTrade(ready), true);
  assert.equal(canExecuteTrade({ ...ready, swapSimulationStatus: "FAILED" }), false);
  assert.equal(canExecuteTrade({ ...ready, swapSimulationStatus: undefined }), false);
});

test("blocks execution for each wallet, network, quote, approval, or pending-state blocker", async (t) => {
  const blockers = [
    ["disconnected", { isConnected: false }],
    ["wrong network", { isCorrectNetwork: false }],
    ["missing address", { hasAddress: false }],
    ["missing wallet client", { hasProvider: false }],
    ["missing quote", { hasQuote: false }],
    ["missing swap details", { hasSwapData: false }],
    ["expired quote", { quoteIsFresh: false }],
    ["fresh quote required", { requiresFreshQuote: true }],
    ["approval in progress", { isApproving: true }],
    ["submission in progress", { isSubmitting: true }],
    ["load in progress", { isLoading: true }],
    ["existing transaction state", { hasTransactionStatus: true }],
    ["approval error", { hasApprovalError: true }],
    ["approval still required", { hasApprovalData: true }],
  ];

  for (const [label, change] of blockers) {
    await t.test(label, () => assert.equal(canExecuteTrade({ ...ready, ...change }), false));
  }
});

test("RFQ execution requires its typed-data signature, unlike a direct SWAP", () => {
  const rfqWithoutSignature = { ...ready, executionMode: "RFQ", requiresTypedDataSignature: true };
  assert.equal(canExecuteTrade(rfqWithoutSignature), false);
  assert.equal(canExecuteTrade({ ...rfqWithoutSignature, hasUserSignature: true }), true);
});

test("approval requires a fresh quote after approval, then the normal readiness checks apply", () => {
  assert.equal(canExecuteTrade({ ...ready, hasApprovalData: true }), false);
  assert.equal(canExecuteTrade({ ...ready, hasApprovalData: false, requiresFreshQuote: true }), false);
  assert.equal(canExecuteTrade({ ...ready, hasApprovalData: false, requiresFreshQuote: false }), true);
});

test("wallet connection presentation distinguishes hydration, connecting, error, disconnected, and connected", () => {
  const hydrated = { isHydrated: true, isInitializing: false, isConnecting: false, isConnected: false, hasError: false };
  assert.equal(walletConnectionView({ ...hydrated, isHydrated: false }), "checking");
  assert.equal(walletConnectionView({ ...hydrated, isInitializing: true }), "checking");
  assert.equal(walletConnectionView({ ...hydrated, isConnecting: true }), "connecting");
  assert.equal(walletConnectionView({ ...hydrated, hasError: true }), "error");
  assert.equal(walletConnectionView(hydrated), "disconnected");
  assert.equal(walletConnectionView({ ...hydrated, isConnected: true }), "connected");
});

test("wallet rejection and network timeout have safe, precise user-facing copy", () => {
  assert.match(tradeErrorMessage(new Error("User rejected the request"), "failed"), /wallet could not approve/i);
  assert.match(tradeErrorMessage(new Error("request timeout"), "failed"), /No transaction was sent/i);
});

test("pending, confirmed, failed, unverified, and wallet-prompt phases map to visible labels", () => {
  assert.equal(displayOrderStatus("FILLED"), "confirmed");
  assert.equal(displayOrderStatus("FAILED"), "failed");
  assert.equal(humanTransactionStatus("pending"), "Waiting for confirmation");
  assert.equal(humanTransactionStatus("confirmed"), "Confirmed");
  assert.equal(humanTransactionStatus("failed"), "Failed");
  assert.equal(humanTransactionStatus("unverified"), "Needs verification");
  assert.equal(tradePhaseMessage("signing"), "Waiting for wallet confirmation...");
  assert.equal(tradePhaseMessage("submitting"), "Submitting signed RFQ order...");
  assert.equal(tradePhaseMessage("confirming"), "Waiting for transaction/order confirmation...");
  assert.equal(tradePhaseMessage("idle"), "");
});

test("quote freshness rejects missing timestamps and the exact expiry boundary", () => {
  assert.equal(isFreshQuote(null, 100_000), false);
  assert.equal(isFreshQuote({ quoteFetchedAt: 0 }, 100_000), false);
  assert.equal(isFreshQuote({ quoteFetchedAt: 70_001 }, 100_000), true);
  assert.equal(isFreshQuote({ quoteFetchedAt: 70_000 }, 100_000), false);
});
