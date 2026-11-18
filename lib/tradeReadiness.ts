export const TRADE_QUOTE_TTL_MS = 30_000;

export function isFreshQuote(quote: { quoteFetchedAt?: number } | null, now: number): boolean {
  return !!quote?.quoteFetchedAt && now - quote.quoteFetchedAt < TRADE_QUOTE_TTL_MS;
}

export type WalletConnectionFacts = {
  isHydrated: boolean;
  isInitializing: boolean;
  isConnecting: boolean;
  isConnected: boolean;
  hasError: boolean;
};

export type WalletConnectionView = "checking" | "connecting" | "error" | "disconnected" | "connected";

export function walletConnectionView(state: WalletConnectionFacts): WalletConnectionView {
  if (!state.isHydrated || state.isInitializing) return "checking";
  if (state.isConnecting) return "connecting";
  if (state.hasError) return "error";
  if (!state.isConnected) return "disconnected";
  return "connected";
}

export function displayOrderStatus(status: string): string {
  switch (status.toUpperCase()) {
    case "FILLED": return "confirmed";
    case "FAILED": return "failed";
    default: return status.toLowerCase();
  }
}

export function humanTransactionStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "pending": return "Waiting for confirmation";
    case "confirmed": return "Confirmed";
    case "failed": return "Failed";
    case "unverified": return "Needs verification";
    default: return status;
  }
}

export type TradePhase = "idle" | "signing" | "confirming" | "submitting";

export function tradePhaseMessage(phase: TradePhase): string {
  switch (phase) {
    case "signing": return "Waiting for wallet confirmation...";
    case "submitting": return "Submitting signed RFQ order...";
    case "confirming": return "Waiting for transaction/order confirmation...";
    default: return "";
  }
}

export function tradeErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error && error.message ? error.message : fallback;
  if (/unknown rpc|failed to publish payload|user rejected|user denied/i.test(message)) {
    return "Your wallet could not approve this request. Check that it is connected to BSC Mainnet, then try again.";
  }
  if (/40374|insufficient liquidity/i.test(message)) {
    return "No market maker is quoting this amount right now. Try a smaller amount (minimum 5 USDT), the same stock from the other issuer, or again in a few minutes. No transaction was sent.";
  }
  if (/40375|minimum order amount/i.test(message)) {
    return "This amount is below the provider's minimum order (5 USD). Increase the amount and request a new quote.";
  }
  if (/42900|rate limit/i.test(message)) {
    return "The quote service is busy. Wait a few seconds and request the quote again. No transaction was sent.";
  }
  if (/timeout|temporarily unavailable|network request failed|fetch failed/i.test(message)) {
    return "The service is taking too long to respond. No transaction was sent; please try again.";
  }
  return message;
}

export type TradeReadiness = {
  isConnected: boolean;
  isCorrectNetwork: boolean;
  hasAddress: boolean;
  hasProvider: boolean;
  hasQuote: boolean;
  hasSwapData: boolean;
  quoteIsFresh: boolean;
  executionMode?: string;
  swapSimulationStatus?: string;
  requiresFreshQuote: boolean;
  isLoading: boolean;
  isSubmitting: boolean;
  isApproving: boolean;
  hasTransactionStatus: boolean;
  hasApprovalError: boolean;
  hasApprovalData: boolean;
  requiresTypedDataSignature: boolean;
  hasUserSignature: boolean;
};

/**
 * The exact conditions for enabling a trade submission. This is presentation
 * gating only; every server and wallet validation remains authoritative.
 */
export function canExecuteTrade(state: TradeReadiness): boolean {
  return state.isConnected &&
    state.isCorrectNetwork &&
    state.hasAddress &&
    state.hasProvider &&
    state.hasQuote &&
    state.hasSwapData &&
    state.quoteIsFresh &&
    (state.executionMode !== "SWAP" || state.swapSimulationStatus?.toUpperCase() === "SUCCESS") &&
    !state.requiresFreshQuote &&
    !state.isLoading &&
    !state.isSubmitting &&
    !state.isApproving &&
    !state.hasTransactionStatus &&
    !state.hasApprovalError &&
    !state.hasApprovalData &&
    (!state.requiresTypedDataSignature || state.hasUserSignature);
}
