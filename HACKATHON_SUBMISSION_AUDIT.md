# WOLV — BNB Hack: Tokenized Stocks Edition

## Current readiness audit

**Reviewed:** 5 October 2026 (UTC+1)

**Route-correction commit:** `1e104d1` (`fix: restore product homepage and keep monitor at gap`), fast-forwarded to GitHub `main` from `f12b935`.

**Production release:** Vercel marked `1e104d1` successful at 08:50:51Z on 5 October 2026. Direct checks returned HTTP 200 for `/`, `/gap`, and `/markets`; the root showed the product landing page and spotlight, and `/gap` showed the full comparison monitor.

**Production URL:** <https://wolv-stock.vercel.app/>
**Public repository:** <https://github.com/sollid-web/wolv-stock>

> **Release distinction:** the feed validation, shared comparison helpers, wallet prompt guard, and homepage/route correction are now included in the successful production deployment at `1e104d1`. Live quote correctness still depends on upstream data and was not established by the route check.

## Executive summary

WOLV Spot Lens is a BSC spot tokenized-equity monitor and user-approved trading interface. Production now shows the product landing page at `/`, including a compact featured comparison. The detailed, polished monitor is at `/gap`; `/markets` remains the dedicated market directory.

The homepage includes a compact featured comparison and links to the full `/gap` view; it does not replace the landing page with the full monitor. The shared logic continues to normalize per-share prices, filter unreliable quotes, and show unavailable feed states instead of false zeros. Wallet execution remains user-initiated, guarded against duplicate prompts, simulated before approval, and confirmed in the user's wallet. No automated check signed or broadcast a trade.

## Evidence verified in the reconciliation worktree

- The route correction is based on `f12b935` and released as `1e104d1`; the previously dirty checkout was not reset or overwritten.
- `/` has the established BSC tokenized-market landing layout with a compact featured comparison, while `/gap` renders the full cross-venue monitor. `/markets` remains the searchable directory. The static route manifest reflects those page roles.
- Pages use shared RWA record parsing and explicit unavailable states. Per-share normalization, quote freshness, the 20% reliability cap, market-status sentinel handling, and quote selection are covered by pure helper tests.
- The single-flight wallet request gate and trade-readiness blockers are covered by tests; no wallet was connected and no transaction was attempted.
- On the route-correction branch: `pnpm test:logic` **35 passed**; lint passed; production build passed with Next.js TypeScript checking. The build still warns about an `ox` dynamic dependency expression and the unset WalletConnect project ID; injected wallets remain available.
- The responsive matrix passed **28 route/viewport cases** for `/`, `/gap`, `/markets`, `/trade`, `/wallet`, and sentinel `/stock/:address` plus `/trade/:address` at 320, 390, 768, and 1440px. The sentinel details validate fallback layout, not live asset data or trading.
- The hardening smoke previously passed against the public URL, but it is only a narrow endpoint check. It does not prove quote validity or wallet execution.
- The user supplied a screenshot of the previous deployed version, where the full monitor occupied `/`. No screenshot of the corrected live route split or final demo video has been captured yet.

## Status against submission needs

| Requirement | Status | Evidence / remaining action |
|---|---|---|
| Public repository | Verified previously | Repository is public; keep it accessible through judging. |
| Production link | **`1e104d1` deployment verified** | Vercel reports success; `/`, `/gap`, and `/markets` return HTTP 200 with the expected page roles. This does not establish live feed correctness. |
| BSC tokenized-stock use case; spot-only | Implemented | The app is scoped to spot-eligible tokenized assets on BSC. The builder should re-check the official supported-instrument and eligibility terms. |
| Listed/reference versus executable monitor | Released | The homepage has a compact featured spotlight; the full comparison and reliability view is at `/gap`. |
| Market directory | Released and preserved | `/markets` remains available with its category navigation and explicit feed-failure state. |
| Fail-closed feed handling | Automated locally | Malformed/unavailable lists do not become zero prices or inferred opportunities. Live upstream behavior still depends on the current Binance feed. |
| Portfolio view | Implemented, read-only | `/api/wallet/portfolio` and `/wallet`; a connected-wallet data review is still owner-controlled. |
| Responsive layout | Automated fallback coverage passed | 28 route/viewport checks passed. Sentinel routes are not evidence of real asset data. |
| Wallet/transaction logic | Guard and presentation tests passed | Readiness blockers, quote freshness, simulation gates, approval refresh, and prompt deduplication are unit-tested. This is not an end-to-end wallet-extension test. |
| Live approval and direct-SWAP validation | Builder/owner-controlled | Do not broadcast solely for this audit. Record a hash/receipt only for a transaction the builder actually chooses to send. |
| Demo video (≤4 minutes) | Not included | Prepare it from real app navigation plus genuine transaction evidence; no second trade is needed just to show an already-confirmed transaction. Confirm the active submission form's requirement. |
| Developer Experience Report | Draft requires builder's firsthand completion | The builder must supply their own observations of API onboarding, docs/support, latency/assets, AI tools, and concrete recommendations. Do not submit an AI-written substitute. |

## Product and safety boundaries

- **Scope:** BSC mainnet and spot-only tokenized equities. No perpetuals, autonomous trading, Agentic Wallet, or BNB Agent Studio are claimed.
- **Data integrity:** real API data only. A failed or malformed feed must not be converted to a zero-valued price, an empty-success state, or a fabricated opportunity.
- **Comparison integrity:** per-share normalization uses the token/share ratio. Stale, incomplete, or over-cap reference gaps are not treated as reliable spread signals. Venue status mismatches remain visible.
- **Execution:** a successful simulation is not approval, signature, broadcast, or a mined receipt. Quote freshness, order minimums, spot eligibility, router/spender checks, wallet approval, and transaction-status checks remain distinct steps.
- **Known defense-in-depth items remain open:** outbound request throttling is process-local; a static official router/spender allowlist is not recorded; RFQ signer recovery/replay protection and refreshing swap calldata immediately before signing remain separate review topics. They are not described as proven exploits or as fixed by this reconciliation.

## Official event details

The [official event page](https://www.bnbchain.org/en/hackathons/tokenized-stocks) and [BNB Chain launch post](https://www.bnbchain.org/en/blog/bnb-hack-tokenized-stocks-edition-with-binance-web3-wallet) were checked during the prior review. Re-check the live rules, submission form, dates, and eligibility before submission; this application does not determine participant eligibility. The Developer Experience Report needs firsthand builder input. The official overview calls a demo video of four minutes or less strongly recommended but optional, while the launch post lists a video among submission materials, so the active form should decide.

## Next steps

1. Capture current screenshots and a truthful walkthrough of the deployed route split; do not reuse the prior homepage screenshot as proof of the new route layout.
2. Use a real supported asset and the intended wallet for any owner-controlled live-feed or wallet verification. Never treat sentinel tests as live evidence.
3. A previously confirmed real trade can be documented without submitting a second trade just for video evidence.
4. Have the builder personally finish the Developer Experience Report and attach only evidence they have actually observed.
