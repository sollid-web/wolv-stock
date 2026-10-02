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