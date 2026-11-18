const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Extracts the active account from wagmi's persisted store (localStorage "wagmi.store") without
 * loading wagmi. Returns null for missing, malformed, or disconnected state. Display only: the
 * wallet itself remains the source of truth on pages that use it.
 */
export function connectedAddressFromWagmiStore(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown })?.state as { current?: unknown; connections?: unknown } | undefined;
    if (!state || typeof state.current !== "string") return null;
    const connections = state.connections as { __type?: unknown; value?: unknown } | undefined;
    if (!connections || connections.__type !== "Map" || !Array.isArray(connections.value)) return null;
    for (const entry of connections.value) {
      if (!Array.isArray(entry) || entry[0] !== state.current) continue;
      const accounts = (entry[1] as { accounts?: unknown })?.accounts;
      const first = Array.isArray(accounts) ? accounts[0] : null;
      return typeof first === "string" && ADDRESS.test(first) ? first : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
