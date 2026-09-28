// Transaction persistence for trade state recovery
// Versioned storage key format
const STORAGE_VERSION = "v1";
const PENDING_TRADES_KEY = `wolv:pending-trades:${STORAGE_VERSION}`;

/**
 * Get all persisted pending trades from localStorage
 */
export function getPendingTrades(): Array<{
  transactionHash: string;
  walletAddress: string;
  chainId: number;
  tokenAddress: string;
  symbol: string;
  tradeMode: string;
  usdtAmount: string;
  quotedTokenAmount?: string;
  quoteId?: string;
  timestamp: number;
  status: 'pending' | 'confirmed' | 'failed';
  submitError?: string;
}> {
  if (typeof window === 'undefined') return [];

  try {
    const data = window.localStorage.getItem(PENDING_TRADES_KEY);
    if (!data) return [];
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Failed to parse pending trades from localStorage:', error);
    return [];
  }
}

/**
 * Save a pending trade to localStorage
 */
export function savePendingTrade(trade: Omit<{
  transactionHash: string;
  walletAddress: string;
  chainId: number;
  tokenAddress: string;
  symbol: string;
  tradeMode: string;
  usdtAmount: string;
  quotedTokenAmount?: string;
  quoteId?: string;
  timestamp: number;
  status: 'pending' | 'confirmed' | 'failed';
  submitError?: string;
}, 'submitError'>): void {
  if (typeof window === 'undefined') return;

  try {
    const trades = getPendingTrades();
    // Remove any existing trade with same hash to avoid duplicates
    const filtered = trades.filter(t => t.transactionHash !== trade.transactionHash);
    // Add new trade
    filtered.push(trade);
    // Keep only last 10 trades to prevent storage bloat
    const limited = filtered.slice(-10);
    window.localStorage.setItem(PENDING_TRADES_KEY, JSON.stringify(limited));
  } catch (error) {
    console.error('Failed to save pending trade to localStorage:', error);
  }
}

/**
 * Update the status of a trade in localStorage
 */
export function updateTradeStatus(transactionHash: string, updates: Partial<{
  status: 'pending' | 'confirmed' | 'failed';
  submitError?: string;
}>): void {
  if (typeof window === 'undefined') return;

  try {
    const trades = getPendingTrades();
    const updated = trades.map(trade =>
      trade.transactionHash === transactionHash
        ? { ...trade, ...updates }
        : trade
    );
    window.localStorage.setItem(PENDING_TRADES_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Failed to update trade status in localStorage:', error);
  }
}

/**
 * Remove resolved trades (confirmed/failed) from storage
 */
export function clearResolvedTrades(): void {
  if (typeof window === 'undefined') return;

  try {
    const trades = getPendingTrades();
    const pendingOnly = trades.filter(t => t.status === 'pending');
    window.localStorage.setItem(PENDING_TRADES_KEY, JSON.stringify(pendingOnly));
  } catch (error) {
    console.error('Failed to clear resolved trades from localStorage:', error);
  }
}

/**
 * Get a specific pending trade by hash
 */
export function getPendingTradeByHash(transactionHash: string):
  | ({
      transactionHash: string;
      walletAddress: string;
      chainId: number;
      tokenAddress: string;
      symbol: string;
      tradeMode: string;
      usdtAmount: string;
      quotedTokenAmount?: string;
      quoteId?: string;
      timestamp: number;
      status: 'pending' | 'confirmed' | 'failed';
      submitError?: string;
    } | undefined) {
  if (typeof window === 'undefined') return undefined;

  try {
    const trades = getPendingTrades();
    return trades.find(t => t.transactionHash === transactionHash);
  } catch (error) {
    console.error('Failed to get pending trade by hash:', error);
    return undefined;
  }
}