# WOLV Stock Terminal — Developer Experience Log

## Day 1 — Sept 23, 2026

### Authentication (60 mins to figure out)
- Initially used wrong base URL: `api.binance.com` → got 400 Invalid API Key
- The `BX-` key prefix is Web3 portal only, not exchange API
- Signature uses Base64(HMAC-SHA256) not hex — this is different from standard Binance exchange API
- The `/build` prefix in requestPath is critical — missing it causes 40102 Invalid signature
- Documentation says this clearly but it's easy to miss on first read

### Token List Fields
- Field names not obvious: `underlyingTicker` not `ticker`, `tokenLogoUrl` not `logoUrl`
- No TypeScript types provided — had to console.log first token to discover structure
- `referencePrice` vs `tokenPrice` — gap data already embedded in token list (good design)

### proot-distro Issue
- Next.js 16 Turbopack crashes on proot Ubuntu — symlink resolution fails
- Fix: `next dev --webpack` flag required
- Not documented anywhere — wasted ~2 hours diagnosing
The app already had a valuable, tested path: request a Binance quote, build swap data, connect a wallet, and send a BSC transaction. You confirmed you had completed a live transaction, so the priority was to protect that flow rather than replace it. The repo also had a useful DEVEX_LOG.md describing real onboarding issues, including Binance Web3 authentication details and unfamiliar RWA field names.

The rough edges were around that working path: the spot filter only blocked a few known symbols, approval and swap checks ran in the wrong order, and the wallet hook hid broadcast errors behind a generic message. The architecture document also described RFQ endpoints and verification that the code did not actually implement.

What changed and why
I extended the spot filter to catch leveraged and inverse products using available instrument metadata, then applied it to listings, detail pages, and trading API boundaries. That mattered for the hackathon’s spot-only rule: a UI-only filter would have left direct routes open.

I checked Binance’s Transaction API documentation and added its signed simulation endpoint before approval and swap wallet prompts. The UI shows the simulation’s predicted balance and allowance changes. For the approval issue in your screenshot, the app had simulated the swap before checking USDT allowance; the simulator correctly rejected the transfer. The flow now checks allowance first, offers approval when needed, and asks for a fresh quote after approval succeeds.

The live homepage now reports 480 eligible assets versus 484 before, and the previously visible leveraged Marvell ETF is absent from the rendered list. TypeScript passes; lint improved from 47 to 41 errors, but the remaining failures are broader existing any usage and one effect-pattern error, so I’m not suppressing them or refactoring unrelated data layers. I’ll test the new API rejection path and rerun the production build to record the actual release blockers
curl -sS -i --get --data-urlencode 'toToken=0x7c26a12f20507e2cee22ceebed9e88fda47f866c' --data-urlencode 'amount=1000000000000000000' --data-urlencode 'userWalletAddress=0x0000000000000000000000000000000000000001' http://localhost:3000/api/quote

it returned

HTTP/1.1 400 Bad Request
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
content-type: application/json
Date: Tue, 29 Sep 2026 23:03:16 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

{"error":"Only supported spot tokenized assets can be quoted"}%  
      toToken
Binance exposes POST /api/v1/dex/pre-transaction/simulate and describes it as off-chain execution with predicted balance and allowance changes. That means we can meet the track’s dry-run requirement properly instead of relying on raw eth_call; I’m reading its required body/headers and response shape now before wiring it in.

The official schema is now clear: signed POST /api/v1/dex/pre-transaction/simulate, body { binanceChainId: "56", evmTx: { from, to, value, data } }, with data.status and predicted balance/allowance changes. I’ll replace our raw RPC preflight with a server-side Binance-signed call, leaving the existing on-chain send and receipt paths untouched. Before adding it, I’m checking the current POST signing helper and request call sites for compatibility.


export function isPositiveUint256(value: string): boolean {
  const normalized = normalizeUint256(value);
  return normalized !== null && BigInt(normalized) > BigInt(0);
}

export function normalizeUint256(value: string): string | null {
  if (!/^(?:\d{1,78}|0x[a-fA-F0-9]{1,64})$/.test(value)) return null;
  const amount = BigInt(value);
  return amount <= UINT256_MAX ? amount.toString() : null;
}


async function post(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const headers = {
    ...makeHeaders("POST", path, body),
    "Content-Type": "application/json",
  };
  await rateLimit();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok || (!json.success && json.code !== 0)) {
    throw new Error(`API error ${json.code ?? res.status}: ${json.msg ?? "Request failed"}`);
  }
  return json;
}

export async function simulateBscTransaction(
  from: string,
  to: string,
  data: string,
  value: string
) {
  return post("/api/v1/dex/pre-transaction/simulate", {
    binanceChainId: "56",
    evmTx: { from, to, value, data },
  });
}
The signed helper typechecks and uses the exact Binance /build signing convention already used by this repo. I’m adding a narrow /api/transaction-simulate proxy now: it accepts only BSC EVM transactions, bounds calldata/value, forwards no credentials to the browser, and returns simulation outcome/balance deltas without broadcasting.
import { NextResponse } from "next/server";
import { normalizeUint256, EVM_ADDRESS_PATTERN } from "@/lib/apiValidation";
import { simulateBscTransaction } from "@/lib/binance";

export const dynamic = "force-dynamic";

const DATA_PATTERN = /^0x(?:[a-fA-F0-9]{2})*$/;

type SimulationResponse = {
  data?: {
    status?: unknown;
    failReason?: unknown;
    balanceChanges?: unknown;
    allowanceChanges?: unknown;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Invalid transaction simulation request" }, { status: 400 });
    }

    const { from, to, data } = body;
    const rawValue = body.value == null ? "0" : String(body.value);
    const value = normalizeUint256(rawValue);
    if (
      typeof from !== "string" || !EVM_ADDRESS_PATTERN.test(from) ||
      typeof to !== "string" || !EVM_ADDRESS_PATTERN.test(to) ||
      typeof data !== "string" || data.length > 200_000 || !DATA_PATTERN.test(data) ||
      value === null
    ) {
      return NextResponse.json({ error: "Invalid transaction simulation request" }, { status: 400 });
    }

    const response = await simulateBscTransaction(from, to, data, value) as SimulationResponse;
    const simulation = response.data;
    if (!simulation || typeof simulation.status !== "string") {
      return NextResponse.json({ error: "Simulation service returned an invalid response" }, { status: 502 });
    }

    return NextResponse.json({
      status: simulation.status,
      failReason: typeof simulation.failReason === "string" ? simulation.failReason : null,
      balanceChanges: Array.isArray(simulation.balanceChanges) ? simulation.balanceChanges : [],
      allowanceChanges: Array.isArray(simulation.allowanceChanges) ? simulation.allowanceChanges : [],
    });
  } catch (error) {
    console.error("Transaction simulation failed:", error);
    return NextResponse.json({ error: "Transaction preflight is temporarily unavailable" }, { status: 502 });
  }
}
The official simulation proxy compiles and now uses Binance’s server-side HMAC signing; the old custom /api/bsc simulation action is removed, leaving that route for allowance/receipt reads only. I’m switching the client preflight to interpret Binance’s SUCCESS/FAILED result rather than the temporary RPC { simulated: true } response.

type SimulationResult = {
  status: string;
  failReason: string | null;
  balanceChanges: { contractAddress?: string; tokenType?: string; change?: string; owner?: string }[];
  allowanceChanges: { tokenAddress?: string; owner?: string; spender?: string; preAmount?: string; postAmount?: string }[];
};

async function simulateTransaction(from: string, to: string, data: string, value = "0"): Promise<SimulationResult> {
  const response = await fetch("/api/transaction-simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, data, value }),
  });
  const result = await response.json() as SimulationResult & { error?: string };
  if (!response.ok) {
    throw new Error(result.error || "Transaction preflight is unavailable; no transaction was sent");
  }
  if (result.status.toUpperCase() !== "SUCCESS") {
    throw new Error(result.failReason || "Transaction preflight failed; no transaction was sent");
  }
  return result;
}
The Binance simulation response includes predicted balance and ERC-20 allowance deltas, so I’m making that result visible before users approve or execute. The quote flow will simulate the swap as soon as transaction details arrive; if there’s an approval, it will simulate that separately before enabling the approval prompt, then re-simulate immediately before the wallet send to catch state changes
  
  const [swapSimulation, setSwapSimulation] = useState<SimulationResult | null>(null);
  const [approvalSimulation, setApprovalSimulation] = useState<SimulationResult | null>(null);
 
}

function SimulationSummary({ title, result }: { title: string; result: SimulationResult }) {
  return (
    <div role="status" style={{ backgroundColor: "#064e3b", color: "#dcfce7", borderRadius: "0.25rem", padding: "0.5rem", margin: "0.5rem 0", fontSize: "0.75rem" }}>
      <div>{title}: {result.status}</div>
      {result.balanceChanges.map((change, index) => (
        <div key={`${change.owner ?? "owner"}-${change.contractAddress ?? "native"}-${index}`} style={{ wordBreak: "break-all" }}>
          Balance change: {change.change ?? "unknown"} raw units · {change.contractAddress || "native asset"}
        </div>
      ))}
      {result.allowanceChanges.map((change, index) => (
        <div key={`${change.owner ?? "owner"}-${change.spender ?? "spender"}-${index}`} style={{ wordBreak: "break-all" }}>
          Allowance: {change.preAmount ?? "?"} → {change.postAmount ?? "?"} raw units · {change.tokenAddress || "token"} · spender {change.spender || "unknown"}
        </div>
      ))}
    </div>
  );
}
The Binance simulation result is now surfaced in the trade UI, including raw predicted balance/allowance changes, and SWAP execution is gated on a successful preflight; the user is asked to inspect the destination and spender. TypeScript remains clean. I’m updating the architecture notes to reflect that official simulation is now integrated, while clearly distinguishing it from Binance’s optional broadcast endpoint, which this app does not use.

’m making one safe verification call with a zero-value, empty-calldata EOA transaction: it exercises Binance auth, request signing, route schema, and response mapping without signing or broadcasting anything on-chain

curl -sS -i -X POST http://localhost:3000/api/transaction-simulate -H 'Content-Type: application/json' --data '{"from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000001","value":"0","data":"0x"}
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
content-type: application/json
Date: Tue, 29 Sep 2026 23:17:07 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

{"status":"SUCCESS","failReason":"","balanceChanges":[],"allowanceChanges":[]}%

The safe live test succeeded against Binance’s real Transaction API: the server-signed BSC simulation returned SUCCESS with empty balance/allowance deltas, and no transaction was broadcast. The app now uses that documented preflight before SWAP and approval wallet prompts
The indexedDB stack traces to WalletConnect’s browser-only storage being initialized during Next server prerender. Wagmi’s provider supports reconnectOnMount; I’m checking its local implementation to confirm we can disable reconnection only on the server while preserving client-side auto-reconnect and explicit wallet connections
Wagmi’s local implementation confirms the server onMount() is what starts connector reconnection during prerender; reconnectOnMount={false} skips connector reconnect while preserving normal user-initiated connection. I’ll set it false only in the server render and true in the browser (typeof window !== "undefined"), then rebuild to verify that client-side auto-reconnect stays configured and the SSR exception disappears.
   <WagmiProvider config={wagmiConfig} reconnectOnMount={typeof window !== "undefined"}>
      <QueryClientProvider client={queryClient}>
      That fixed the SSR issue: the production build now completes without the indexedDB exception. WalletConnect’s browser-only connector is still included in the client bundle; I’m verifying it remains offered in the wallet UI and checking lint on the provider/config change. The only build warnings left are the optional pino-pretty resolution from WalletConnect’s dependency tree.
      The final verification is mixed but clear: TypeScript passes, the production build succeeds without the indexedDB error, focused API/eligibility lint is clean, Binance’s simulation endpoint returned SUCCESS, and the spot-filter/API rejection tests pass. Full lint still reports 41 errors/12 warnings in legacy pages/hooks (including TradeButton’s existing any and effect rule); I’m marking the work complete with those as explicit release gates, not calling the app fully production-cleared
      Implemented

The event’s main track calls for a BSC, spot-only tokenized-stock product. The app is now positioned around Ondo/bStocks cross-venue executable-price and reference-price monitoring; leveraged/inverse products are filtered from listings and checked again at asset and trade API boundaries. The live list dropped from 484 to 480, and the leveraged quote test returned HTTP 400.
Replaced the temporary RPC preflight with the documented, server-signed Binance Transaction API simulation. Successful SWAP and approval simulations show predicted balance/allowance changes and are required before wallet prompts. A safe zero-value simulation returned SUCCESS; nothing was broadcast.
Added exact 18-decimal USDT parsing, BSC checks before signing/sending, stricter API input validation, uncached trade requests, generic upstream errors, cryptographic RFQ request IDs, and reliable polling cleanup. The app now displays the swap destination and approval spender before wallet confirmation.
Added the event’s restricted-region notice, corrected wallet choices to match their actual connector behavior
The remaining security gates are persistent per-client rate limiting, verification/allowlisting of official router and spender addresses, and confirming how Binance binds RFQ signatures to their quote and wallet

The console has two kinds of noise: wallet-extension provider/relay errors, and React 418, which is the app issue to isolate. One likely hydration mismatch is our browser-only WalletConnect setup: the server can render “not configured” while the browser renders “scan with mobile wallet.” I’ll verify the wallet state and render path, then make the initial server/client wallet UI deterministic without removing wallet support.

the WalletConnect connector is omitted during SSR but present in the browser, and the selector renders different text from that connector list. Wagmi’s reconnect state can also differ on first render. I’ll make the wallet-dependent regions wait until after hydration and derive connector availability from the shared public project-ID config; injected-wallet and WalletConnect support remain unchanged. The inpage.js Ton/Tron/channel messages are from the injected wallet, not app code.
The render discrepancy is confirmed in the source: SSR has no WalletConnect connector, while the browser does, and the wallet pages render connector availability and reconnect state directly. I’ll use React’s hydration-aware external-store snapshot for those wallet-dependent regions (wallet page and trade panel) and make WalletConnect availability derive from the shared env value, so the server markup and first client render match
Only two client surfaces consume Wagmi state, so the fix stays local. I’ll add a hydration snapshot hook, use it to hold wallet/trade output on a stable “checking” state through the first render, and make WalletConnect availability depend on the public project ID rather than whether the server or browser instantiated the connector.

useisHydrated
"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export function useIsHydrated() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

 error: getConnectionErrorMessage(connectError),
    walletConnectAvailable: Boolean(process.env.NEXT_PUBLIC_WALLET_PROJECT_ID),
    connect,
    disconnect,

walletpage
import { useIsHydrated } from "@/hooks/useIsHydrated";
import { useState } from "react";
import GlobalNav from "@/components/GlobalNav";

export const dynamic = "force-dynamic";

export default function WalletPage() {
  const isHydrated = useIsHydrated();

TradxeButton.tsx
  import { useIsHydrated } from "@/hooks/useIsHydrated";
The hydration fix passes TypeScript. I’ve kept the first wallet render identical on server and client, and the selector’s WalletConnect label no longer depends on a browser-only connector list. I’m smoke-testing both /wallet and the trade route in the browser now; if React 418 persists there, the remaining source will likely be the injected extension rather than app markup.
The rough edges were around that working path: the spot filter only blocked a few known symbols, approval and swap checks ran in the wrong order, and the wallet hook hid broadcast errors behind a generic message. The architecture document also described RFQ endpoints and verification that the code did not actually implement.

What changed and why
I extended the spot filter to catch leveraged and inverse products using available instrument metadata, then applied it to listings, detail pages, and trading API boundaries. That mattered for the hackathon’s spot-only rule: a UI-only filter would have left direct routes open.

I checked Binance’s Transaction API documentation and added its signed simulation endpoint before approval and swap wallet prompts. The UI shows the simulation’s predicted balance and allowance changes. For the approval issue in your screenshot, the app had simulated the swap before checking USDT allowance; the simulator correctly rejected the transfer. The flow now checks allowance first, offers approval when needed, and asks for a fresh quote after approval succeeds.

I also stopped suppressing wallet broadcast exceptions, so the app can show the actual provider error instead of claiming the transaction simply wasn’t submitted. No transaction payload or broadcast method was changed.

What it meant to leave the issues
A leveraged product could have appeared tradable despite the spot-only requirement. Users with no USDT allowance could hit a confusing preflight failure instead of seeing approval. A rejected broadcast appeared as an app failure with no useful cause. Speculative architecture notes could also have led future work toward endpoints the app wasn’t using.

What we verified
The spot filter rejected the previously visible leveraged ETF; its quote route returned HTTP 400. Binance’s simulation endpoint returned SUCCESS for a harmless zero-value request. TypeScript and the production build passed at the last checks, and your screenshot later showed a confirmed production trade. I did not send a live transaction myself.

Still worth recording
The WalletConnect relay and missing-MetaMask errors are external connection problems; the app now gives more specific guidance but cannot make a blocked relay reachable. Repository-wide lint still had unresolved errors, and the Developer Experience Report should include your own account of the Binance docs, API onboarding, real transaction, and mobile wallet experience.