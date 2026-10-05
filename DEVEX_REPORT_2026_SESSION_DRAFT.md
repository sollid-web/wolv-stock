# WOLV Spot Lens — Developer Experience Report (2026 session draft)

**Prepared:** 4 October 2026; updated 5 October 2026
**Project:** WOLV Spot Lens  
**Purpose:** Evidence-based draft of this session's development experience and audit outcomes for the BNB Hack: Tokenized Stocks Edition.

> **Evidence and attribution:** This report combines repository inspection, commands and browser checks performed during the AI-assisted session, plus wallet-testing information recorded earlier from the builder. It distinguishes those sources and labels checks that were not performed.

## Executive summary

WOLV Spot Lens is a BSC spot tokenized-equity monitor focused on Ondo and bStocks. It compares issuer/listed reference data with executable aggregator quotes, normalizes prices per underlying share, and offers a user-approved trade path.

An earlier wallet-debugging session exposed an important integration mismatch in that trade path. Binance simulation reported success, but the connected wallet did not support the raw-transaction signing method WOLV requested. The app therefore failed before broadcasting and did not show the expected wallet confirmation. A subsequent connection attempt also returned a pending-request error. Browser console output supplied by the builder showed Binance Wallet's injected provider failing to initialize an internal broadcast channel; it did not establish the cause of that extension failure.

The transaction flow was changed to use the wallet's standard send-transaction path for approval and direct SWAP execution. WOLV still simulates the transaction before asking for wallet approval, and it now checks the resulting BSC receipt through the configured public RPC client. Connection attempts were also guarded against overlapping requests, and pending-request errors were made clearer.

The changes from that earlier transaction/wallet work were **not** tested against a live wallet or deployed to production in that session. The extension/provider connection error may remain. The security audit found no confirmed exploitable vulnerability from repository evidence, but identified trust-boundary and operational-hardening items that remain relevant before public mainnet use.

On 5 October, a separate AI-assisted judge-readiness pass changed the landing route to the executable-price monitor, moved the asset catalog to `/markets`, retained `/gap`, improved market-data failure reporting, and verified the local production build and routes. That later work is recorded in detail below. It did **not** deploy these changes or test a wallet transaction.

## Product and integration context

The product is intended to help a user:

1. Find a tokenized-equity ticker represented on supported BSC venues.
2. Compare issuer/reference information with an executable spot quote.
3. Understand normalization, quote age, market status, price impact, and limitations.
4. Inspect a simulation and approve any required USDT allowance in their wallet.
5. Send a spot trade only after explicit wallet confirmation.

The repository records integrations with Binance RWA data, the aggregator quote/swap/approval endpoints, and Transaction API simulation. The app's RFQ path uses Binance-returned EIP-712 typed data and Binance order submission. See [README.md](./README.md) and [TRADING_ARCHITECTURE.md](./TRADING_ARCHITECTURE.md).

## Session timeline: what went wrong and what changed

### 1. Simulation succeeded, but the wallet did not open a confirmation

The builder reported clicking **Approve USDT** and seeing an error instead of a wallet prompt. The screenshot showed an approval preflight marked `SUCCESS`, followed by an error explaining that the wallet could not sign raw transactions required for Binance broadcast.

The code path explained the apparent contradiction:

- The app obtains approval calldata and checks the simulated allowance in [TradeButton.tsx](./components/TradeButton.tsx).
- A successful preflight only means the simulated transaction passed; it does not approve USDT or broadcast anything.
- The old flow called `walletClient.signTransaction(...)` in [useWallet.tsx](./hooks/useWallet.tsx), requiring the wallet to return a raw signed transaction.
- If that method is unsupported, execution exits before the broadcast call. No transaction hash is produced by that flow.

This was an integration/capability mismatch: simulation worked, but the wallet's supported confirmation interface did not match WOLV's raw-sign-and-relay design.

### 2. Disconnecting in WOLV did not clear the next wallet's pending-request warning

The builder reported disconnecting from the WOLV page, ending the first wallet session, and then encountering “Connection declined — a previous request is still active” while trying another wallet.

The WOLV disconnect action delegates to wagmi's `disconnect()` in [useWallet.tsx](./hooks/useWallet.tsx). That changes the app's connector/session state; it does not give WOLV a general method to cancel a request already pending inside a wallet extension or WalletConnect provider.

The console text provided by the builder included errors from an injected `inpage.js` provider: it could not obtain a channel secret or node ID and reported “Broadcast channel unavailable.” This is evidence of an error within the injected wallet provider's initialization/broadcast mechanism. It does **not** identify the underlying extension defect, prove that WOLV created the condition, or prove that the same mechanism caused every wallet's pending-request message.

### 3. Wallet transaction sending was changed

The approval and direct-SWAP flows were changed from `signTransaction` followed by Binance broadcast to `sendTransaction` through the connected wallet client:

- The wallet receives the transaction request and owns signing and broadcast.
- The user should receive the wallet's normal transaction confirmation when the wallet/provider supports this flow.
- Binance simulation, quote freshness checks, and BSC chain checks remain in the app.
- The app checks for the transaction receipt through the configured BSC public client.

The changes are in [useWallet.tsx](./hooks/useWallet.tsx) and [TradeButton.tsx](./components/TradeButton.tsx). Documentation was updated in [README.md](./README.md) and [TRADING_ARCHITECTURE.md](./TRADING_ARCHITECTURE.md).

This change addresses the raw-signing incompatibility. It does not guarantee that the Binance Wallet extension's injected provider can connect or initialize successfully.

### 4. Duplicate connection requests were guarded

The app's `connect` function now returns early if a connection attempt is already in flight. The AppKit connection button also prevents a second open while its modal or connector reports a connection in progress. A pending-request message is translated into user-facing guidance to finish or dismiss the wallet prompt before retrying.

These changes reduce duplicate requests initiated by WOLV. They cannot cancel a request held by the wallet itself or repair an extension's internal broadcast channel. See [useWallet.tsx](./hooks/useWallet.tsx) and [WalletSelector.tsx](./components/WalletSelector.tsx).

## Development and debugging loops

### Wallet approval loop

```text
User clicks Approve USDT
  -> WOLV fetches Binance approval transaction
  -> Binance simulation reports SUCCESS
  -> old flow requests raw signature (eth_signTransaction-equivalent)
  -> wallet does not support that method
  -> app exits before broadcast; no approval hash/allowance change
  -> flow changed to wallet-native sendTransaction
  -> live wallet validation remains outstanding
```

### Wallet connection loop

```text
WOLV starts wallet connection
  -> wallet/connector reports a request is already pending
  -> builder disconnects WOLV and ends first wallet session
  -> retry still reports pending request
  -> console shows injected-provider broadcast-channel initialization errors
  -> WOLV duplicate-request guards and clearer messaging added
  -> extension/provider cause remains unverified and requires live retest
```

### Repository audit loop

```text
Hackathon checklist review
  -> found product technically aligned but home screen not judge-first
  -> repo readiness audit recorded missing external submission evidence
  -> adversarial security pass traced actual routes and signing/broadcast flows
  -> preliminary concerns separated into confirmed issues,
     hardening, architecture limitations, and unsupported claims
  -> no confirmed high/critical exploit established from repository evidence
```

## Audit findings relevant to the build

### Confirmed implementation facts

- The app has quote freshness and a short-lived HMAC quote binding for token, amount, wallet, quote ID, and, when present, approval target. Implemented in [quoteBinding.ts](./lib/quoteBinding.ts).
- The approval route compares the returned approval spender to the quote-bound approval target. The swap route compares the SWAP destination to that target when the binding contains it. See [approve-transaction/route.ts](./app/api/approve-transaction/route.ts) and [swap/route.ts](./app/api/swap/route.ts).
- The app does not independently reconstruct or recover the signer for Binance-supplied RFQ typed data. WOLV forwards the signed RFQ order to Binance. This is an external trust boundary, not proof of an exploitable mutation.
- The rate limiter in [binance.ts](./lib/binance.ts) is process-local, not shared across serverless instances.
- The repository's [next.config.ts](./next.config.ts) does not define explicit security headers.
- Binance credentials are read server-side; `.env*` is ignored by [.gitignore](./.gitignore). No evidence from the reviewed repository showed the credentials being exposed to client code.

### Classification

| Audit observation | Session conclusion |
|---|---|
| RFQ typed-data values are not independently validated by WOLV | Confirmed trust-boundary limitation; no repository-evidenced mutation exploit |
| Router/spender has no static official-contract allowlist | Partially mitigated by quote-bound destination/spender comparisons; further allowlisting is defense-in-depth |
| Quote may be stale at execution | Freshness and quote-binding checks exist; swap details are fetched during quote preparation, then execution is blocked when the quote is stale. The code does not fetch new swap calldata immediately before wallet signing. |
| Public routes are unauthenticated | Public relay surface and quota-abuse consideration; not a wallet-drain finding by itself |
| Wallet race/session failure | No wrong-wallet execution demonstrated; the user's pending-provider failure is real but the root cause remains external/unverified |
| Security headers absent from repository config | Hardening recommendation; no concrete exploit established |
| Secrets exposed | Not supported by inspected code; server-only Binance credentials and ignored env files |
| Process-local rate limiting | Scalability/abuse-resistance limitation, not a confirmed exploit |

## What the audit got right, and what it did not establish

The initial readiness review correctly identified that the opportunity monitor was not the obvious homepage entry point and that public deployment, demo accessibility, and a complete judge journey could not be proved from the repository alone.

The later security review correctly identified areas requiring trust in Binance-provided payloads, missing global rate limiting, and absent explicit security headers. It did not establish that those conditions let an attacker mutate a signed trade, bypass wallet approval, or steal funds. The follow-up verification therefore treated them as trust-boundary, hardening, or architectural findings rather than confirmed high/critical vulnerabilities.

The wallet issue was not simply “simulation failed.” Simulation succeeded; the signing/broadcast method was incompatible with the tested wallet. Separately, the injected provider emitted its own initialization errors. The evidence does not support claiming that WOLV caused the provider error or that the wallet-native send change resolves it.

## Verification record and limitations

| Check | Result |
|---|---|
| TypeScript/editor diagnostics after wallet-flow edits | No errors reported for [useWallet.tsx](./hooks/useWallet.tsx), [WalletSelector.tsx](./components/WalletSelector.tsx), and [TradeButton.tsx](./components/TradeButton.tsx) |
| Earlier repository TypeScript, lint, production build | Passed during the earlier repo audit, before the wallet-native transaction-flow edits |
| Live approval prompt after wallet-native change | Not tested in this session |
| Live SWAP after wallet-native change | Not tested in this session |
| Binance Wallet injected-provider connection after guards | Not tested in this session; provider-console errors remain unresolved |
| Deployed production behavior | Not verified after these local changes |

No transaction, signing event, or approval should be claimed as newly completed by this session. The builder's earlier live-transaction experience is recorded in the existing development log, but this session's observed wallet failure did not produce evidence of a new on-chain transaction.

## AI-assisted judge-readiness session: 5 October 2026

### Scope and evidence boundary

I am an AI coding assistant. The first-person record in this section describes the code, browser, and command-line work I actually performed in this repository during this session. It does not claim that I am the human hackathon participant, that I personally experienced the builder's earlier wallet/API onboarding, or that I signed, broadcast, or confirmed a transaction.

The explicit request for this pass was to help bring the existing app closer to a judge-ready submission. I honored the user's instruction not to commit or push. All code and documentation edits described here remain local/uncommitted; the production URL therefore still serves its previously deployed build unless separately deployed by the project owner.

### Step-by-step record

1. **Inspected the landing-page implementation first.** I read the tagged [app/page.tsx](./app/page.tsx) rather than assuming the repository was an empty starter. It was already a server-rendered token-market page: it loaded the RWA platform and token lists, applied the spot-eligibility filter, displayed market/platform counts and category tabs, rendered `StockList`, and exposed a link named “Executable prices” to `/gap`. This showed that the initial problem was not a missing app; it was that the more distinctive monitor required an extra navigation step.

2. **Checked the repository's existing project evidence before changing code.** I read [package.json](./package.json), [README.md](./README.md), [HACKATHON_SUBMISSION_AUDIT.md](./HACKATHON_SUBMISSION_AUDIT.md), [DEVEX_LOG.md](./DEVEX_LOG.md), [TRADING_ARCHITECTURE.md](./TRADING_ARCHITECTURE.md), and the then-current draft of this report. The audit already identified the monitor-not-primary issue and external submission gaps. The README described the integrations and clearly warned that the Developer Experience Report must contain firsthand observations. I treated those as constraints: preserve the trading functionality, do not invent participant experiences, and do not claim readiness based only on a visual pass.

3. **Read the installed framework guidance before changing routes.** This repository uses Next.js 16.3.6. Following the repository instructions, I read the installed App Router guides on layouts/pages and server/client components in `node_modules/next/dist/docs/01-app/01-getting-started/`. The route changes preserve the existing pattern: async data fetching and monitor rendering remain in server components; no client-side wallet boundary or Next.js API was introduced.

4. **Established the pre-change validation baseline.** Before editing, I ran `pnpm exec tsc --noEmit`, `pnpm lint`, and `pnpm test:hardening`; all passed. The hardening script's default target was the existing public deployment, `https://wolv-stock.vercel.app`. I also ran `pnpm build`; the production build compiled and completed Next.js's TypeScript phase, collecting page data and generating its static pages. These results describe the pre-change baseline only.

5. **Compared the existing opportunity monitor and navigation.** I inspected [app/gap/page.tsx](./app/gap/page.tsx), [components/GlobalNav.tsx](./components/GlobalNav.tsx), [components/CategoryTabs.tsx](./components/CategoryTabs.tsx), and [app/trade/page.tsx](./app/trade/page.tsx). `/gap` already contained the core differentiator: it loads spot-eligible RWA records, groups matching underlying tickers across venues, requests USD quotes for a fixed 100 USDT input, normalizes both reference and executable values by the token-to-share ratio, excludes stale or extreme-gap quotes from spread ranking, and warns about differing venue market statuses. I chose to reuse this implementation instead of creating a second monitor with duplicated quote logic.

6. **Moved the existing catalog rather than deleting it.** I relocated the former home-page implementation to [app/markets/page.tsx](./app/markets/page.tsx), preserving its category query parsing, platform/token loading, eligibility filtering, counts, `StockList`, and error messages. I changed its `CategoryTabs` base path to `/markets`. I then made [app/page.tsx](./app/page.tsx) render the shared monitor and retained [app/gap/page.tsx](./app/gap/page.tsx) as a compatibility route. The former `/gap` implementation is now [components/OpportunityMonitor.tsx](./components/OpportunityMonitor.tsx), so both `/` and `/gap` render the same logic rather than diverging copies.

7. **Fixed navigation that became incorrect as a consequence of the route change.** Before this change, sector category links hard-coded `/` and the mobile “Markets” item went to `/gap`. Once `/` became the monitor, those links would send a person back to the monitor instead of opening or filtering the catalog. I added a `basePath` prop to `CategoryTabs`, passed `/markets` from the catalog and `/trade` from the trade selector, and pointed the mobile Markets tab to `/markets`. I also changed the monitor's back link to `/markets`.

8. **Made the monitor's catalog-fetch failure visible without taking down the whole page.** Before the extraction, `getRWATokenList()` was awaited without a page-level error boundary in the monitor route. A rejected catalog request could fail the route instead of showing its comparison page and a specific data error. The shared monitor now records the error and renders an accessible `role="alert"` message (“Couldn't load market data: …”). It does not present the failed fetch as successful data: the list remains empty and the error is surfaced. This is availability and truthful-error handling, not a security control, and quote/API failures for individual assets remain distinct.

9. **Updated behavior checks and documentation.** I extended [scripts/hardening-smoke.mjs](./scripts/hardening-smoke.mjs) to request `/markets` in addition to `/`, `/gap`, `/trade`, and `/wallet`; it now asserts that the root HTML contains “Listed vs Executable Price” and “per share, executable”. The README now documents the route map and current public repository/deployment references. The audit draft now marks the local landing-page work complete while retaining outstanding deployment, wallet, demo, and submission-material checks. Those edits do not publish anything.

10. **Built and rechecked the local result.** The post-change `pnpm build` succeeded and listed `/`, `/gap`, and `/markets` as routes. I initially started a standalone TypeScript check at the same time as that build. It reported missing `.next/types/...` files while Next.js was regenerating that directory; this was a build/typecheck race, not evidence of missing application source types. After the build completed, I reran `pnpm exec tsc --noEmit` and `pnpm lint` sequentially; both passed.

11. **Exercised the production output locally.** I started the built app on `127.0.0.1:3001`, ran `BASE_URL=http://127.0.0.1:3001 pnpm test:hardening`, and the complete existing smoke suite passed against the local build. I opened the root page in a browser and observed “Listed vs Executable Price,” cross-listed ticker rows, the per-share quote labels, quote age, and the warning explaining market-status differences. I used the mobile “Markets” navigation and confirmed it reached `/markets`; after the route's “Loading WOLV data…” status completed, its catalog rendered with the observed API data (480 eligible asset records and two venue cards at that moment). I clicked the “SpaceX” sector link and confirmed navigation to `/markets?tab=2`. My first automation assertion then threw `ReferenceError: URL is not defined` because that browser-code environment did not expose a global `URL`; the navigation itself had already completed. I reran the assertion against `page.url()` directly and confirmed the expected route/query. This was a test-snippet mistake, not an application error. These are point-in-time browser observations, not guarantees about future market data or a full automated visual-regression suite. I stopped the local production server afterward.

12. **Checked repository and deployment boundaries.** `git diff --check` passed. GitHub CLI reported `sollid-web/wolv-stock` as a public repository. I had also opened the existing public deployment before changes, and the pre-change hardening checks passed against it. I did not deploy this new local build, did not create a commit, and did not push. Consequently, I cannot claim the judge-facing homepage is live on Vercel yet.

### Defect/fix record with before-and-after code

These snippets show the relevant behavior, not every line of the moved pages.

#### Defect 1 — The primary route opened the catalog, not the differentiating monitor

Before, the root route fetched the catalog directly and rendered the category selector and asset list:

```tsx
// Before: app/page.tsx
export default async function Home({ searchParams }: {
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  const { tab } = await searchParams;
  // Fetch platform/token catalog, filter assets, and prepare StockList data...
  return (
    <>
      <CategoryTabs active={tabId} />
      <StockList key={tabId ?? "all"} tokens={slim} category={tabLabel} />
    </>
  );
}
```

The monitor already existed at `/gap`, so a judge had to discover and select the “Executable prices” link to reach it. That was a product-discovery defect, not an exploit: the implementation made the project's core idea less obvious and could cause a short judge demo to start on the less distinctive catalog.

After, the root route delegates to the existing monitor, while the catalog has a durable route:

```tsx
// After: app/page.tsx
import OpportunityMonitor from "@/components/OpportunityMonitor";

export const dynamic = "force-dynamic";

export default function Home({ searchParams }: {
  searchParams: Promise<{ n?: string }>
}) {
  return <OpportunityMonitor searchParams={searchParams} />;
}
```

```tsx
// After: app/markets/page.tsx
export default async function Markets({ searchParams }: {
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  // The former home-page catalog implementation remains here.
  // ...
  return <CategoryTabs active={tabId} basePath="/markets" />;
}
```

If the change had not been made, `/` would still have presented the catalog first. The route split does not grant access to new trade actions or bypass the existing spot checks; the monitor is display/navigation and the catalog/trade/API validation remains in its own existing code paths. This improves judge clarity; it is not a new transaction-security guarantee.

#### Defect 2 — Hard-coded category URLs became wrong after changing the home route

Before, every category tab generated a root URL:

```tsx
// Before: components/CategoryTabs.tsx
<Link href="/" ...>All</Link>
<Link href={`/?tab=${t.id}`} ...>{t.label}</Link>
```

This was coupled to the catalog living at `/`. Once `/` served the monitor, sector clicks from the catalog or trade selector could take the user away from the list they intended to filter; the new root monitor accepts `n`, not the catalog's `tab`, so the requested sector would not filter that screen.

After, callers provide the intended route base:

```tsx
// After: components/CategoryTabs.tsx
export default function CategoryTabs({
  active,
  basePath = "/",
}: {
  active: number | null;
  basePath?: string;
}) {
  // ...
  <Link href={basePath} ...>All</Link>
  <Link href={`${basePath}?tab=${t.id}`} ...>{t.label}</Link>
}
```

The markets page passes `/markets`; the trade page passes `/trade`. Without the fix, this would have been a broken navigation/filtering flow, not a means to quote or execute an ineligible asset: the API's server-side validation is still the enforcement boundary. The change preserves that distinction and does not treat a UI filter as authorization.

#### Defect 3 — “Markets” and monitor back-navigation pointed to the wrong screen

Before, the mobile Markets item linked to `/gap`, and the monitor back arrow linked to `/`. Because `/gap` was itself the monitor and `/` used to be the catalog, neither target expressed the correct intent after the route change.

After, the Markets item and the monitor back arrow both navigate to `/markets`; `/gap` remains an alias for the monitor so older external links continue to work. Without these changes, users could loop between monitor routes or be unable to reach the catalog using the navigation labels. This is UX correctness, not access control.

#### Defect 4 — Catalog-list failure could fail the monitor route without a useful page-level explanation

Before, monitor data loading began with an unguarded await:

```tsx
// Before: app/gap/page.tsx
const tokensResponse = await getRWATokenList();
const all = filterSpotEligibleAssets(parseRwaAssetRecords(tokensResponse));
```

If that request rejected, the page render rejected too. The page-level result did not contain a monitor-specific catalog error message.

After, the failure is kept as an error and rendered explicitly:

```tsx
// After: components/OpportunityMonitor.tsx
let all: RwaToken[] = [];
let tokenListError: string | null = null;
try {
  const tokensResponse = await getRWATokenList();
  all = filterSpotEligibleAssets(parseRwaAssetRecords(tokensResponse));
} catch (error) {
  tokenListError = (error instanceof Error ? error.message : String(error)).slice(0, 160);
}
```

```tsx
{tokenListError && (
  <div role="alert">
    Couldn&apos;t load market data: {tokenListError}
  </div>
)}
```

Without the change, temporary RWA-list API failure could leave the monitor unavailable behind a generic route error. Now the failure is visible and the route can explain what data is missing. It is more resilient, but it does not make stale/unavailable data safe to trade by itself; the explicit warning must not be mistaken for a live quote or successful preflight. The error string is length-limited, but this work did not add a redaction system, persistent telemetry, retry, or monitoring.

### Security and “secure now” assessment

The changes in this session did **not** modify wallet signing, transaction simulation, quote binding, token eligibility rules, allowance handling, or swap submission. They do not close the separately recorded router/spender allowlisting, distributed rate-limiting, or RFQ signer-validation gaps. No new security vulnerability was confirmed in the route/UI work, and no security review of every transaction code path was performed as part of this edit.

The concrete safety property preserved is that the old catalog behavior was moved rather than replaced with a new client-side asset source; it still uses `filterSpotEligibleAssets`, and the trade page continues to use that filter. More importantly, neither the route visibility nor `CategoryTabs` is represented as the security boundary: quote/swap/approval API routes must continue to validate their token and quote inputs server-side. This pass did not prove those controls complete or independently re-audit them. It would be inaccurate to say “the app is now secure” based solely on these fixes. Accurate wording is: **the judge-facing route and failure/navigation behavior were improved; the existing transaction boundaries were left unchanged; public-mainnet safety remains subject to the outstanding verification in this report.**

### Verification results and limits for this session

| Verification | Result and scope |
|---|---|
| Pre-change `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test:hardening` | Passed before edits; smoke suite defaulted to the then-deployed `https://wolv-stock.vercel.app` |
| Pre-change `pnpm build` | Passed before edits |
| Post-change `pnpm build` | Passed; Next.js reported routes `/`, `/gap`, and `/markets` |
| Post-change standalone `pnpm exec tsc --noEmit` | Passed when rerun after the build completed |
| Post-change `pnpm lint` | Passed |
| Initial parallel build/typecheck attempt | Standalone typecheck reported missing generated `.next/types` files while build was regenerating them; sequential rerun passed. Treat as a command race, not a source-code failure. |
| Post-change `BASE_URL=http://127.0.0.1:3001 pnpm test:hardening` | Passed against the local production build, including root monitor text, `/markets`, legacy `/gap`, trade/wallet pages, and existing malformed-input API checks |
| Local browser | Root monitor rendered; mobile Markets navigation reached `/markets`; catalog content loaded; the “SpaceX” category link reached `/markets?tab=2`. No wallet extension transaction flow was exercised. |
| Public GitHub repository | `gh repo view` reported `sollid-web/wolv-stock` as `PUBLIC` |
| Public production deployment after changes | Not verified/deployed; there was no push or commit |
| Wallet approvals, swaps, contract destinations, or on-chain receipts | Not tested in this session |

### Outstanding submission work not performed here

- Publish the approved changes through the project's normal review/deploy process, then retest `/`, `/markets`, and `/gap` on the deployed URL.
- Test actual wallet connection, approval, and swap flows on BSC with the intended wallet; record wallet/browser versions, user-visible prompts, transaction hashes, receipt status, and any failures. Do not claim a successful trade without this evidence.
- Confirm current router and spender addresses against official contract data before representing mainnet trading as safe.
- Make and upload the judge demo (recommended maximum four minutes), verify repository/deployment accessibility, and enter the exact official submission details.

## Lessons for the next development cycle

1. A successful simulation is preflight evidence, not a wallet approval or transaction receipt.
2. Wallet signing and broadcast capabilities differ; use the wallet's standard user-confirmed send path for ordinary EVM transactions unless the product specifically requires raw transaction relay.
3. Treat wallet connection, transaction approval, transaction broadcast, and receipt confirmation as separate observable states.
4. An app disconnect cannot be presented as clearing every pending request inside a wallet extension or WalletConnect session.
5. Keep failure copy precise: distinguish “simulation passed,” “wallet confirmation unavailable,” “user rejected,” “broadcast submitted,” and “receipt verified.”
6. A repository audit can establish code behavior, but cannot establish deployed behavior or an external wallet's root cause without a controlled live reproduction.

## Priority actions before judging

1. Test the changed approval flow with the actual target wallet on BSC mainnet using a small, affordable amount; record whether the wallet confirmation appears, the transaction hash, and the receipt result.
2. Test the direct-SWAP flow separately and verify that receipt lookup works for wallet-broadcast transactions. Also decide whether the product requires new swap calldata immediately before signing; the current client obtains it during quote preparation and enforces quote freshness afterward.
3. Reproduce the connection issue in a clean browser profile with only one wallet extension active. Capture the wallet name/version, browser, connector path, exact sequence, and redacted console errors.
4. Verify the live deployed URL and public repository remain accessible; rehearse the primary judge journey from the deployed URL.
5. Deploy and verify the local reference-versus-executable monitor as the judge's landing page, as recorded in [HACKATHON_SUBMISSION_AUDIT.md](./HACKATHON_SUBMISSION_AUDIT.md).
