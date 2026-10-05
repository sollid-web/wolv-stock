# WOLV — BNB Hack: Tokenized Stocks Edition

## Current readiness audit

**Reviewed:** 5 October 2026 (UTC+1)

**Current route-correction branch:** `fix/restore-homepage-and-monitor-route`, based on `f12b935`. It restores the established landing page on `/` with a compact featured-price spotlight, while the full comparison monitor remains on `/gap`.

**Released reconciliation:** commit `f12b935` is now on GitHub `main`; Vercel marked its production deployment successful at 08:30:30Z on 5 October 2026. That deployed version still puts the full monitor on `/`; the route correction described here is local and has not been released.

**Production URL:** <https://wolv-stock.vercel.app/>
**Public repository:** <https://github.com/sollid-web/wolv-stock>

> **Release distinction:** the shared feed validation, comparison helpers, and wallet prompt guard in `f12b935` are released. The homepage/route adjustment on `fix/restore-homepage-and-monitor-route` has passed local checks but is not yet deployed.

## Executive summary

WOLV Spot Lens is a BSC spot tokenized-equity monitor and user-approved trading interface. The currently deployed `f12b935` made the comparison monitor the landing page. This follow-up restores the product landing page at `/` and keeps the detailed, polished monitor at `/gap`; `/markets` remains the dedicated market directory.

The homepage includes a compact featured comparison and links to the full `/gap` view; it does not replace the landing page with the full monitor. The shared logic continues to normalize per-share prices, filter unreliable quotes, and show unavailable feed states instead of false zeros. Wallet execution remains user-initiated, guarded against duplicate prompts, simulated before approval, and confirmed in the user's wallet. No automated check signed or broadcast a trade.

## Evidence verified in the reconciliation worktree

- The route correction is based on `f12b935`; the previously dirty checkout was not reset or overwritten.
- `/` now has the established BSC tokenized-market landing layout with a compact featured comparison, while `/gap` continues to render the full cross-venue monitor. `/markets` remains the searchable directory. The static route manifest reflects those page roles.
- Pages use shared RWA record parsing and explicit unavailable states. Per-share normalization, quote freshness, the 20% reliability cap, market-status sentinel handling, and quote selection are covered by pure helper tests.
- The single-flight wallet request gate and trade-readiness blockers are covered by tests; no wallet was connected and no transaction was attempted.
- On the route-correction branch: `pnpm test:logic` **35 passed**; lint passed; production build passed with Next.js TypeScript checking. The build still warns about an `ox` dynamic dependency expression and the unset WalletConnect project ID; injected wallets remain available.
- The responsive matrix passed **28 route/viewport cases** for `/`, `/gap`, `/markets`, `/trade`, `/wallet`, and sentinel `/stock/:address` plus `/trade/:address` at 320, 390, 768, and 1440px. The sentinel details validate fallback layout, not live asset data or trading.
- The hardening smoke previously passed against the public URL, but it is only a narrow endpoint check. It does not prove quote validity or wallet execution.
- The user supplied a screenshot of the deployed monitor on `/`. No screenshot from the new local route build or final demo video has been captured.

## Status against submission needs

| Requirement | Status | Evidence / remaining action |
|---|---|---|
| Public repository | Verified previously | Repository is public; keep it accessible through judging. |
| Production link | **`f12b935` deployment verified** | Vercel reports success; `/` still shows the full monitor until the local route correction is released. HTTP 200 alone does not establish live feed correctness. |
| BSC tokenized-stock use case; spot-only | Implemented | The app is scoped to spot-eligible tokenized assets on BSC. The builder should re-check the official supported-instrument and eligibility terms. |
| Listed/reference versus executable monitor | Released; route presentation corrected locally | The full monitor remains at `/gap`; the homepage will show only a compact featured spotlight after the route correction is deployed. |
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

1. Review and commit the route-correction branch; it currently passes logic tests, lint, build, and the 28-case responsive matrix.
2. After the route correction is released, verify its exact Vercel deployment and confirm `/` is the landing page and `/gap` is the full monitor.
3. Use a real supported asset and the intended wallet for any owner-controlled live-feed or wallet verification. Never treat sentinel tests as live evidence.
4. Capture current screenshots and a truthful walkthrough after the target deployment is confirmed. A previously confirmed real trade can be documented without submitting a second trade.
5. Have the builder personally finish the Developer Experience Report and attach only evidence they have actually observed.
