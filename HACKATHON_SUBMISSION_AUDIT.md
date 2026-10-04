# WOLV — BNB Hack: Tokenized Stocks Edition

## Audit draft and repo readiness review

Prepared: 2026-10-04

This document audits the current repository against the supplied Hackathon submission checklist and marks what is already implemented, what is partially satisfied, and what must be fixed before a judge-facing submission is considered ready.

## Executive summary

The project is materially aligned with the core product idea and technical scope for the BNB Hack: Tokenized Stocks Edition main track:

- It is built around BSC tokenized equities.
- It centers on Ondo and bStocks assets.
- It is spot-only and explicitly filters leveraged or inverse products.
- It compares reference/listed data with executable quotes.
- It includes live API integration, transaction simulation, and wallet approval flow.

However, the repository is not yet fully aligned with the submission checklist as written. The biggest gaps are not technical feasibility; they are product/production readiness and judge clarity:

1. The home screen is still a generic token list rather than the executable-price monitor the checklist calls for.
2. Several submission requirements remain unverified in the repo itself (public repo, deployed link, live accessibility, demo video, and final judge journey under real conditions).
3. Some UI language and navigation still read like a generic market explorer instead of a clear opportunity-discovery product.

In other words: the repo is strong on technical capability, but it still needs a judge-first framing and final submission proof points.

## Evidence reviewed

- [README.md](./README.md)
- [TRADING_ARCHITECTURE.md](./TRADING_ARCHITECTURE.md)
- [app/page.tsx](./app/page.tsx)
- [app/gap/page.tsx](./app/gap/page.tsx)
- [lib/compliance.ts](./lib/compliance.ts)
- [lib/spotAssets.ts](./lib/spotAssets.ts)

## Status against the checklist

### 1. Confirmed target and non-negotiable rules

- [x] The project is centered on tokenized stocks on BSC.
  - Supported by [README.md](./README.md) and [TRADING_ARCHITECTURE.md](./TRADING_ARCHITECTURE.md).

- [x] At least one of bStocks, Ondo, or xStocks is central to the product.
  - The code and docs explicitly center on Ondo and bStocks in multiple locations.

- [x] The product is spot-only. No perpetuals or other derivatives.
  - The compliance logic in [lib/compliance.ts](./lib/compliance.ts) explicitly rejects leveraged/inverse products and the architecture notes describe a spot-only product boundary.

- [x] The product runs against BSC mainnet for the required live product path.
  - This is described in the architecture and product docs, and the app is built for BSC wallet flows.

- [x] The deliverable is a working project, not only a deck or concept.
  - The repository contains working Next.js code and API routes, and the app builds successfully.

- [ ] The submission contains a public repository.
  - This is not verifiable from the local repo alone; the public-facing GitHub URL still needs confirmation.

- [ ] The submission contains a working deployed link, or reproducible judge instructions.
  - The repo includes a local dev/build setup, but not a confirmed deployed URL in the project docs.

- [ ] The demo video is no longer than four minutes.
  - No project artifact shows a finalized judge-facing demo output.

- [ ] The repository, demo, and deployed link remain accessible through judging.
  - Not verifiable from repository state alone.

- [x] The product does not claim guaranteed profit or guaranteed arbitrage.
  - The gap page explicitly says the spread is not guaranteed profit.

- [x] The product clearly distinguishes reference/listed data from executable quotes.
  - This is a core concept in [app/gap/page.tsx](./app/gap/page.tsx) and the README.

- [x] Eligibility and restricted-region terms are handled according to the official rules; the product does not make unsupported legal eligibility claims.
  - The docs include official links and caution that eligibility is user responsibility.

### 2. Product definition to freeze

- [x] The product statement is largely aligned with the intended scope.
  - The project description in [README.md](./README.md) and the gap page state the core idea clearly: compare reference data with executable quotes and allow a user-approved spot trade.

- [x] The core promise is consistent with the architecture.
  - The app offers price difference discovery, evidence explanation, execution-quality checks, and wallet-led spot trade flow.

- [x] The product boundary is mostly respected.
  - It does not add broad DeFi or perpetual features, and it enforces a spot-only filter.

- [ ] The home page still does not satisfy the “primary judge journey” framing as written in the checklist.
  - [app/page.tsx](./app/page.tsx) opens on a generic token listing and market overview; the opportunity monitor is routed through [app/gap/page.tsx](./app/gap/page.tsx) rather than being the primary landing experience.

### 3. Current implementation baseline to preserve

- [x] RWA token/platform listing integration is present.
- [x] Ondo and bStocks listing support is present.
- [x] Spot-eligibility filtering is implemented.
- [x] Aggregator quote integration is implemented.
- [x] Swap-detail integration is implemented.
- [x] Approval-transaction integration is implemented.
- [x] Binance Transaction API simulation before wallet prompt is implemented.
- [x] Browser-wallet signing/broadcast path for the SWAP flow is present.
- [x] RFQ typed-data/order path is represented in the architecture and codebase.
- [x] BSC mainnet enforcement is part of the product boundaries.
- [x] Cross-venue gap page with token/share-ratio normalization is present.

The following remain not yet fully confirmed from a repo-only audit:

- [ ] Clean standalone TypeScript check.
  - Confirmed in this local audit: `pnpm exec tsc --noEmit` passes.

- [ ] Clean lint check.
  - Confirmed in this local audit: `pnpm lint` passes.

- [ ] Clean production deployment.
  - Confirmed in this local audit: `pnpm build` succeeds.

- [ ] Full browser test of the deployed trade path.
  - Not verified from the repository alone.

- [ ] Router/spender destination allowlist.
  - Documented as still needing explicit validation before public mainnet use.

- [ ] Portfolio API integration.
  - Not implemented.

- [ ] Binance Wallet Skills integration.
  - Not implemented.

- [ ] BNB Agent Studio integration.
  - Not implemented.

- [ ] Completed four-minute demo.
  - Not created.

## Workstream A: judge-readiness audit

### A1. Make the executable-price monitor the product entry point

Status: Partial / not yet satisfied

Why it is still failing the checklist:

- The home page in [app/page.tsx](./app/page.tsx) emphasizes “Explore tokenized stocks built for onchain trading” and presents a general token list.
- The opportunity monitor is at [app/gap/page.tsx](./app/gap/page.tsx), but it is not the primary screen or dominant action on the landing experience.
- The checklist expects a judge to understand the differentiator without reading the README, and the current landing screen does not do that clearly enough.

What the repo already does well:

- [app/gap/page.tsx](./app/gap/page.tsx) contains the actual comparison logic and price-normalization narrative.
- The text on that page clearly positions the app as “Listed vs Executable Price”.

### A2. Standardize the price definitions

Status: Mostly satisfied on the gap page

What is already present:

- The page shows reference price, executable price, per-share normalized values, spread, and quote age.
- It calculates `referencePerShare = referencePrice / multiplier` and compares it to executable per-share data.
- It surfaces quote freshness, stale warnings, and market status.

What remains to tighten up:

- The landing page still does not consistently reinforce the same terminology.
- The product should present the exact terms that the checklist requires at the first screen as a judge-facing statement, not only in the deeper comparison view.
- The app should make the contract address, platform identifier, multiplier, quote direction, input amount, and age more explicit within each opportunity card if the user is meant to make fully judge-ready on-the-spot judgments.

## Product verdict

This repo is technically credible and materially close to the requirement set. It is stronger than a concept deck and it is clearly built around the right problem statement. The main gap is not the core idea or the on-chain plumbing — it is the product framing and submission readiness.

The app should be judged as:

- Strong technical implementation: yes
- Strong product story: partially yes, but not yet judged from the first screen
- Submission-ready as currently documented: not yet

## Recommended submission action plan

1. Reframe the home and navigation experience so the gap/opportunity monitor is the primary judge entry point.
2. Make the first screen explicitly say: Reference price, Executable price, Per-share normalized price, Cross-venue spread, and Quote age.
3. Confirm the live deployed URL and public repo URL in the final submission materials.
4. Produce a judged demo flow that matches the expected primary journey.
5. Add a final checklist file or submission brief that maps each requirement to the live product and cites the relevant routes/screens.

## Final repo verdict

- Technical alignment: strong
- Submission alignment: partial
- Need for a revised “look-alike” document: yes, to reflect the actual repo state and the remaining judge-readiness gaps

This audit draft should be used as the basis for the final hackathon submission brief, with the current implementation treated as a strong beta-grade implementation rather than a final, fully judge-ready submission pack.
