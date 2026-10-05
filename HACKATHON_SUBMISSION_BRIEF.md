# WOLV Spot Lens — Submission Brief (Pre-submission Draft)

**Prepared:** 5 October 2026

**Submission status:** Not final. Route-correction commit `1e104d1` is on GitHub `main`, and Vercel reports that its production deployment succeeded. A later documentation-only commit updates these submission notes without changing app behavior. The live `/` is the product landing page with a compact featured comparison; `/gap` is the full monitor. The demo video and builder-firsthand Developer Experience Report remain outstanding.

## Project summary

WOLV Spot Lens is an execution-intelligence monitor for tokenized equities on BNB Smart Chain. It compares issuer/listed reference data with executable spot quotes, normalizes by the token's shares-per-token ratio, and makes quote freshness, market-session mismatch, and data exclusions visible before the user decides whether to trade. Trading remains user-initiated and wallet-confirmed; WOLV does not claim guaranteed arbitrage or profit.

**Short pitch:** *See the reference signal, inspect the executable route, understand the limits, then decide for yourself.*

## Access

- **Repository:** <https://github.com/sollid-web/wolv-stock> — public repository.
- **Deployed app:** <https://wolv-stock.vercel.app/> — verify the actual deployment commit and routes before recording a demo. An HTTP 200 response alone does not establish correct assets, quotes, or wallet execution.
- **Route-correction release:** commit `1e104d1` on GitHub `main`, based on `f12b935`; Vercel reports production success.
- **Local setup:** follow the root [README](./README.md); use `pnpm install --frozen-lockfile`.

## Suggested judge journey

1. **Start at `/`.** See the original WOLV landing-page presentation, its featured comparison spotlight, and the spot-market coverage. The compact spotlight links to the detailed monitor; it is not the full monitor itself.
2. **Open `/gap`.** Review the full cross-venue comparison, quote freshness, market status, per-share normalization, and reliability exclusions. A visible difference is not guaranteed profit.
3. **Open `/markets`.** Browse the BSC tokenized-stock directory and choose an asset. If the upstream list is unavailable or malformed, the interface should say so rather than invent an asset count or price.
4. **Open `/stock/:address`.** Review reference information, issuer details, market status, chart data when actually returned, and the trade entry point. Missing upstream information should remain visibly unavailable.
5. **Open `/trade/:address` only for a user-controlled demonstration.** Request a fresh quote, run the Transaction API simulation, review the exact USDT approval and destination, then decide whether to confirm in the connected wallet. Simulation is a dry run; it is not approval, broadcast, or receipt. No automated test in this repository sends a transaction.
6. **Open `/wallet`.** The portfolio view is read-only; it displays Binance-sourced BSC balances and statistics and does not sign or execute.

The current route split is live: the homepage is distinct from the full comparison monitor, and the `/gap` link provides a direct way to open that monitor.

## Current evidence

The route-correction commit passed a production build, lint, 35 logic tests, and 28 route/viewport checks at 320, 390, 768, and 1440px. The detail routes used an invalid sentinel address; those checks demonstrate fallback layout, not real data or execution. Vercel marked `1e104d1` successful; direct production checks confirmed `/`, `/gap`, and `/markets` returned HTTP 200 with the expected page roles.

The builder supplied a mobile screenshot of the previous release, where the full monitor was on `/`; it is not evidence of the corrected route layout. No new screenshot of the updated live homepage or final demo video is included here. Capture current production evidence from `1e104d1`. Do not replace missing feed data with synthetic values.

## Builder-controlled items before submission

- [ ] Capture updated production screenshots and rehearse `/`, `/gap`, `/markets`, `/stock/:address`, `/trade/:address`, and `/wallet` from the public URL.
- [ ] Record any genuine feed delay/error without relabeling it as a price.
- [ ] For a wallet demonstration, use a clean profile and one intended wallet extension. Record wallet/browser/connector versions and redact private information.
- [ ] Treat approval and direct-SWAP wallet prompts as separate steps. The builder decides whether to broadcast any live transaction. Record a hash and receipt only if actually produced; a previously confirmed trade can be documented without making a second trade for the video.
- [ ] Confirm failure/rejection copy and whether a pending wallet prompt reproduces.
- [ ] If submitting a demo, keep it truthful and within four minutes. The overview describes the video as strongly recommended but optional, while the launch post lists it; confirm the active submission form.
- [ ] Have the builder personally complete the Developer Experience Report from firsthand API onboarding, documentation/support interactions, latency and asset observations, AI-stack use, and specific redesign recommendations. Do not submit a draft or this AI-assisted brief as a firsthand report.
- [ ] Re-check official event dates, eligibility, restricted-region rules, and the submission form at <https://www.bnbchain.org/en/hackathons/tokenized-stocks> before lock.

## Submission constraints checked

The [official event overview](https://www.bnbchain.org/en/hackathons/tokenized-stocks) and [BNB Chain launch post](https://www.bnbchain.org/en/blog/bnb-hack-tokenized-stocks-edition-with-binance-web3-wallet) were consulted during the prior review. They describe a BSC-mainnet spot product centered on bStocks, Ondo, or xStocks and emphasize a specific, firsthand Developer Experience Report. Verify the current form and rules before submission; participant eligibility is the builder's responsibility.
