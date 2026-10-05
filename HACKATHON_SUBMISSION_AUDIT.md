# WOLV — BNB Hack: Tokenized Stocks Edition

## Current readiness audit

**Reviewed:** 5 October 2026 (UTC+1)

**Reconciliation branch:** `reconcile/wolv-monitor-safety-2026-10-05`, based on the fetched `origin/main` commit `6ca6b4b` (`feat: make executable price monitor the landing page`). The original dirty checkout was left in place; integration work was performed in a separate worktree.

**Production URL:** <https://wolv-stock.vercel.app/>
**Public repository:** <https://github.com/sollid-web/wolv-stock>

> **Release distinction:** the changes described in this audit are local to the reconciliation branch and have not been pushed or deployed. The current public app and `origin/main` must not be described as containing this branch's additional validation, shared reliability helpers, or tests until that branch is released and the resulting production deployment is checked.

## Executive summary

WOLV Spot Lens is a BSC spot tokenized-equity monitor and user-approved trading interface. The latest public `main` already makes the executable-price monitor the landing page and retains `/markets` as the market directory. I reconciled the separate local safety and monitor changes on top of that newer structure rather than restoring the candidate's conflicting home-page rewrite.

The reconciliation keeps `/`, `/gap`, and `/markets` available; moves comparison math and quote selection into shared, tested helpers; and makes missing or malformed feed data visibly unavailable instead of turning it into a zero price or an empty-looking success. Wallet execution remains user-initiated, guarded against duplicate prompts, simulated before wallet approval, and confirmed by the user's wallet. This audit does not claim that any automated check signed or broadcast a trade.

## Evidence verified in the reconciliation worktree

- `origin/main` was fetched before the integration and the new worktree was based on `6ca6b4b`. The original checkout was not rebased, reset, or overwritten.
- The existing `/` and `/gap` monitor wrappers and the remote `/markets` directory were preserved. `/markets` was added to the route manifest and responsive test matrix.
- The route pages use shared RWA record parsing and an explicit unavailable state for feed failures. Per-share normalization, quote freshness, a 20% reliability cap, market-status sentinel handling, and quote selection are covered by pure helper tests.
- The single-flight wallet request gate and trade-readiness blockers are covered by tests; no wallet was connected and no transaction was attempted during these checks.
- `pnpm test:logic`: **35 tests passed**. `pnpm lint`: passed. `pnpm build`: passed, including Next.js TypeScript checking. The build emitted a dependency warning from `viem`/`ox` about a dynamic dependency expression and noted that `NEXT_PUBLIC_WALLET_PROJECT_ID` was not set; injected wallets remain available.
- The production-build responsive smoke test passed **28 route/viewport cases**: `/`, `/gap`, `/markets`, `/trade`, `/wallet`, and sentinel `/stock/:address` plus `/trade/:address` at 320, 390, 768, and 1440px. Dynamic detail routes used an invalid sentinel address without local API credentials, so these results demonstrate the fallback layout—not live asset data or trade execution.
- The hardening smoke script passed against the public URL. That is a narrow endpoint check; it does not prove which source commit is deployed, that current live quotes are valid, or that wallet execution works.
- No screenshots from the reconciled build or final demo video are included. Earlier candidate screenshots were deliberately not carried forward because the home-page route structure changed during reconciliation.

## Status against submission needs

| Requirement | Status | Evidence / remaining action |
|---|---|---|
| Public repository | Verified previously | Repository is public; keep it accessible through judging. |
| Production link | Reachable in the prior review; revision not verified here | After release, check the live routes and deployment commit. HTTP 200 alone does not establish the correct build or live data. |
| BSC tokenized-stock use case; spot-only | Implemented | The app is scoped to spot-eligible tokenized assets on BSC. The builder should re-check the official supported-instrument and eligibility terms. |
| Listed/reference versus executable monitor | Implemented on the reconciliation branch; not released | `/` and `/gap` use the shared comparison path in this branch. Do not attribute these additional changes to production until deployed. |
| Market directory | Preserved and hardened on the reconciliation branch | `/markets` remains available with its existing category navigation and now forwards explicit feed-failure state. |
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

1. Review the reconciliation branch diff and its test results; keep the original dirty checkout as the source of any work that was not included.
2. If the builder wants this code released, publish the reconciliation branch or merge it into `main`, then verify the deployment commit and public `/`, `/gap`, and `/markets` routes. No push or deployment is implied by this audit.
3. Use a real supported asset and the intended wallet for any owner-controlled live-feed or wallet verification. Never treat sentinel tests as live evidence.
4. Capture current screenshots and a truthful walkthrough after the target deployment is confirmed. A previously confirmed real trade can be documented without submitting a second trade.
5. Have the builder personally finish the Developer Experience Report and attach only evidence they have actually observed.
