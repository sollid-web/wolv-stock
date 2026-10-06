# WOLV supplied assets

Place provided, licensed assets in the matching directory below. The homepage
uses an asset when its expected name exists; otherwise it keeps the current
text, API-logo, or CSS fallback. No generated placeholder artwork is included.

Supported extensions, checked in this order: `.svg`, `.webp`, `.png`, `.jpg`,
`.jpeg`.

| Directory | Expected filenames | Used for |
| --- | --- | --- |
| `branding/` | `wolv-logo.svg` (or another supported extension) | Header wordmark |
| `companies/` | `{ticker}.svg`, e.g. `nvda.svg`, `spy.svg` | Company mark; takes priority over the API token logo |
| `platforms/` | `{platformId}.svg`, e.g. `bstock.svg`, `ondo.svg`; `bnb-chain.svg` | Venue marks and the BNB Chain panel |
| `backgrounds/` | `terminal-grid.svg` | Optional, subtle terminal panel backdrop |
| `icons/` | `discover.svg`, `compare.svg`, `analyze.svg`, `execute.svg` | How WOLV Works step icons |
| `illustrations/` | `opportunity-flow.svg` | Optional illustration beside the workflow heading |

Names are matched case-insensitively after converting non-alphanumeric
characters to hyphens. For example, a ticker such as `BRK.B` maps to
`companies/brk-b.svg`. Prefer transparent logos and diagrams that remain
legible against a dark background.
