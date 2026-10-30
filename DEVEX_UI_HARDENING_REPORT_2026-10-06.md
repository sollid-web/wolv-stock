# WOLV Stock Terminal — Final UI Hardening DevEx Report

**Date:** 6 October 2026
**Repository:** `sollid-web/wolv-stock`
**Branch:** `main`
**Baseline HEAD when I began the inspection:** `e9bfaa4` — `Revert WOLV terminal changes from PRs #2 and #3 (#4)`
**Repository state at final review:** `main` points to `f72dc69475f60db4ff334e19e74559aeea9853f1` (`feat: enhance navigation accessibility and styling`), also shown as `upstream/main`. That commit includes the UI hardening changes described here as well as separate analysis and asset changes. I did not create or push that commit; the commit itself does not establish which portions were performed in this UI pass. This report remains an untracked working-tree file.

## Scope and attribution

I treated this as a final presentation, responsive, and accessibility hardening pass, not a new application implementation. I inspected the existing App Router pages, shared navigation, market analysis panel, wallet network modal, stock chart, and responsive and hardening scripts before editing.

The working tree was already dirty when I began. In particular, it contained an earlier AI-analysis implementation, changes to `app/api/analyze/route.ts`, `lib/opportunityMath.ts`, `components/AIInsightStrip.tsx`, and untracked analysis-related files. Those are not UI-hardening changes from this pass. I attributed only the UI, metadata, and test-script changes made during this final pass to it. By final review, those source changes were present in `f72dc69`; the report does not attribute that commit's separate analysis and asset changes to this pass.

At initial inspection, I compared then-current source against baseline `HEAD` rather than using the full dirty-tree diff as though every change had one cause. The files directly touched during this pass were:

- `app/globals.css`
- `app/layout.tsx`
- `app/page.tsx`
- `app/stock/[address]/page.tsx`
- `app/wallet/page.tsx`
- `components/GlobalNav.tsx`
- `components/Homepage.tsx`
- `components/MarketAnalysis.tsx`
- `components/NetworkSwitchModal.tsx`
- `components/OpportunityCard.tsx`
- `components/TradeButton.tsx`
- `scripts/hardening-smoke.mjs`
- `scripts/responsive-smoke.mjs`

The changes in `app/wallet/page.tsx` and `components/TradeButton.tsx` only remove a no-op `onClose={() => undefined}` prop after I removed the unused close control from the blocking network dialog. I did not modify their wallet or trade operations.

## What I was trying to improve

I focused on concrete, reviewable rough edges in an existing trading interface:

1. Keyboard users lacked a consistent visible focus indicator.
2. Reduced-motion handling stopped some named CSS animations, but did not suppress other transitions or future animated elements.
3. The fixed mobile navigation relied on fixed-width links and did not give each link an explicit accessible name.
4. The analysis panel looked like a dialog but did not implement Escape-to-close, a keyboard tab loop, or focus restoration.
5. The wrong-network dialog did not expose dialog semantics or manage keyboard focus, and did not catch/display a rejected network-switch action.
6. A color gradient and gap coloring could carry stronger positive/negative implications than the market comparison itself supports.
7. The homepage rendered a truncated upstream exception as visitor-facing copy.
8. The document metadata still described the older “WOLV Spot Lens” page title and a narrower product.
9. The responsive test covered 320, 390, 768, and 1440 pixels, but omitted 414 pixels and did not assert touch-target dimensions.

I did not attempt to address every styling inconsistency across every page. I found inline styles in the trade flow, and I left them intact to avoid turning a bounded hardening pass into a risky trade-screen rewrite.

---

## Problem 1 — No shared visible keyboard focus treatment

### Where I found it

`app/globals.css`

The stylesheet contained global colors and animation classes, but no general `:focus-visible` rule for links, buttons, form inputs, or disclosure summaries.

### What was wrong

Keyboard focus depended on the browser default and on each individual component. A control could be operable with Tab but provide a weak or inconsistent indication of which control would activate with Enter or Space. A mouse-only visual check would not expose that problem because pointer interaction does not normally show keyboard focus.

### Why it mattered

The product includes navigation, wallet actions, quote controls, form fields, disclosure elements, and dialogs. A user moving through those controls with a keyboard needs to identify the active element without guessing. A globally removed or hidden focus ring would make keyboard navigation harder even if pointer users saw no difference.

### Before

The committed stylesheet moved from scrollbar styling directly into decorative utilities:

```css
* {
  scrollbar-color: #34344b #0a0a14;
}

.wolv-grid {
  /* decorative background */
}
```

There was no shared focus selector between these rules.

### Why the original code was insufficient

The lack of a shared rule did not prove that every browser showed no outline; browser defaults may still appear. It did mean that WOLV had no consistent focus appearance under its own dark design system, and component-specific classes could produce inconsistent contrast.

### Fix

I added a WOLV-yellow outline for interactive elements:

```css
a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
summary:focus-visible {
  outline: 2px solid #f0b90b;
  outline-offset: 3px;
}
```

### Why this fix works

`:focus-visible` applies the ring when the browser determines that focus indication is appropriate, notably for keyboard navigation, without forcing the same outline on every pointer click. The rule covers the common interactive elements present in the application. The offset separates the ring from the control border.

### What could happen if I left it unfixed

A keyboard user could lose their position while tabbing through controls, activate the wrong wallet or trade control, or miss that focus entered a dialog. That would be an accessibility and usability defect, not evidence of an exploitable vulnerability.

### Validation

I ran ESLint, the Next.js production build (which ran its TypeScript phase), standalone `npx tsc --noEmit`, and `git diff --check`. These confirm the stylesheet is accepted by the build and the patch is clean. **I did not run a dedicated keyboard-only browser test that tabs through every page and asserts the computed outline. Repository evidence does not establish that the focus ring was visually audited on each component.**

---

## Problem 2 — Reduced-motion preference was too narrow

### Where I found it

`app/globals.css`

### What was wrong

The previous reduced-motion media query disabled only the named animations already listed:

```css
@media (prefers-reduced-motion: reduce) {
  .wolv-float,
  .wolv-pulse,
  .wolv-scan,
  .wolv-chart-line,
  .wolv-chart-area,
  .home-reveal,
  .market-ticker-track {
    animation: none;
  }
}
```

It did not shorten general CSS transitions, and a newly introduced animation outside that list could continue running for a user who requested reduced motion.

### Why it mattered

The product already has motion on quote/status indicators, chart drawing, hero reveals, and the ticker. Motion can be unwanted or distracting for some users. In a trading interface, a continuous decorative animation can also compete with the market data that needs attention.

### Fix

I retained the explicit animation reset and added a broader reduced-motion override:

```css
@media (prefers-reduced-motion: reduce) {
  .wolv-float,
  .wolv-pulse,
  .wolv-scan,
  .wolv-chart-line,
  .wolv-chart-area,
  .home-reveal,
  .market-ticker-track {
    animation: none;
  }

  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### Why this fix works

The named rules stop the known animations directly. The universal rule also reduces durations for animations and transitions not currently named, including future CSS additions. It avoids globally disabling non-motion behavior outside the media query.

### What could happen if I left it unfixed

A user requesting reduced motion could still see transitions or newly introduced animations. That is a mismatch between the user’s system preference and the interface’s behavior.

### Validation

The production build and CSS checks passed. **I did not emulate `prefers-reduced-motion: reduce` in the browser and inspect every animated component.** The code change is present; a visual audit under that emulation remains unverified.

---

## Problem 3 — Mobile bottom navigation sizing and names

### Where I found it

`components/GlobalNav.tsx`

The navigation is fixed at the bottom on viewports below the `md` breakpoint. The existing implementation already included bottom safe-area padding and active coloring; those were not newly introduced in this pass.

### What was wrong

Before, five links used a fixed minimum width of `16` Tailwind units and were placed in a `justify-around` row. The width did not adapt to the available space. At narrow widths, fixed minimums plus padding could create cramped or clipped controls. Link text alone supplied the accessible name, and the AI label said “AI live” even though analysis is on demand.

### Before

```tsx
<nav className="fixed bottom-0 left-0 right-0 ... px-2 pb-[env(safe-area-inset-bottom)] ... md:hidden">
  <div className="mx-auto flex h-16 max-w-lg items-center justify-around">
    <Link href="/" className="flex min-w-16 flex-col items-center gap-1 ...">
      <NavIcon name="home" /><span>Home</span>
    </Link>
    <Link href="/#intelligence" className="flex min-w-16 flex-col items-center gap-1 ...">
      <NavIcon name="ai" /><span>AI live</span>
    </Link>
  </div>
</nav>
```

### Why the original code was insufficient

The row distributed fixed-minimum-width controls instead of dividing the available width among the five destinations. This made the layout more brittle at small viewport widths. “AI live” could also imply continuous or autonomous AI activity rather than a user-triggered analysis.

### Fix

I made each navigation item flex to share the available width, gave it at least a 48-pixel minimum height, added explicit accessible names, and renamed the AI item:

```tsx
<nav aria-label="Primary navigation" className="fixed bottom-0 left-0 right-0 ... px-2 pb-[env(safe-area-inset-bottom)] ... md:hidden">
  <div className="mx-auto flex h-16 max-w-lg items-center">
    <Link
      href="/"
      aria-current={isActive("/") ? "page" : undefined}
      aria-label="Home"
      className="flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 ..."
    >
      <NavIcon name="home" /><span>Home</span>
    </Link>
    <Link href="/#intelligence" aria-label="AI market analysis"
      className="flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 ...">
      <NavIcon name="ai" /><span>AI read</span>
    </Link>
  </div>
</nav>
```

The actual file applies the same flex sizing to all five links. I retained the existing `aria-current` active-page state for Home, Markets, Trade, and Portfolio. The AI section remains a link into the homepage’s intelligence section and is not marked as an active page.

### Why this fix works

`flex-1` lets the five links divide available horizontal space rather than insisting on a fixed minimum width. `min-w-0` allows each item to participate in that distribution. `min-h-12` produces a 48-pixel minimum height. The responsive test measures actual link rectangles and asserts width and height of at least 48 pixels, and asserts that the links remain within the viewport.

The safe-area inset was present before this change and remains present. I do not claim that this pass added safe-area support.

### What could happen if I left it unfixed

At small widths, a bottom navigation target could become harder to tap or be pushed outside the visible viewport. Users could also hear an imprecise “AI live” label that misstates the on-demand nature of the feature.

### Validation

The responsive smoke test ran at 320, 390, and 414 pixels and asserted that the mobile navigation links were at least 48 by 48 pixels and inside the viewport. All these route/width checks passed. This does not test every physical device, browser chrome, or OS safe-area configuration.

---

## Problem 4 — Analysis dialog keyboard behavior

### Where I found it

`components/MarketAnalysis.tsx`, the `MarketAnalysis` component and its conditional panel.

### What was wrong

The previous panel had `role="dialog"` and `aria-modal="true"`, but those attributes alone did not implement keyboard behavior. The code opened the panel after the user pressed Analyse, but did not move focus into it, contain Tab navigation, close on Escape, or return focus to the Analyse trigger. A keyboard user could tab into controls behind the overlay.

### Before

The prior implementation held only UI state and opened the dialog conditionally:

```tsx
const [open, setOpen] = useState(false);
const [loading, setLoading] = useState(false);

{open && (
  <div role="dialog" aria-modal="true" aria-labelledby={`analysis-${row.ticker}`}>
    <div className="w-full max-w-xl ...">
      ...
      <button type="button" onClick={() => setOpen(false)} aria-label="Close analysis">
        ×
      </button>
    </div>
  </div>
)}
```

There was no keydown handler or focus management in the component.

### Why the original code was insufficient

`aria-modal` communicates intent to assistive technology; it does not itself trap focus, implement Escape behavior, or restore focus. The visual overlay could therefore look modal while keyboard focus continued through background content.

### Fix

I added trigger and panel refs, moved focus into the panel on open, closed the panel on Escape, looped Tab and Shift+Tab at its boundaries, and restored focus to the trigger during effect cleanup:

```tsx
const triggerRef = useRef<HTMLButtonElement>(null);
const dialogRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!open) return;

  const dialog = dialogRef.current;
  const trigger = triggerRef.current;
  const focusableSelector =
    'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusable = dialog?.querySelectorAll<HTMLElement>(focusableSelector);
  focusable?.[0]?.focus();

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== "Tab" || !dialog) return;
    const items = dialog.querySelectorAll<HTMLElement>(focusableSelector);
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  document.addEventListener("keydown", handleKeyDown);
  return () => {
    document.removeEventListener("keydown", handleKeyDown);
    trigger?.focus();
  };
}, [open]);
```

The real implementation also prevents Tab if the dialog has no focusable controls. The interactive panel remains a conditional `role="dialog"` with `aria-modal`, a labelled heading, and a close button.

### Why this fix works

When the dialog opens, focus moves to its first focusable control. The key handler catches Escape and wraps focus when Tab is pressed at either end of the dialog’s focusable elements. When `open` changes to false, effect cleanup removes the global key handler and attempts to put focus back on the Analyse button that opened it.

This is keyboard focus containment; it does not make the rest of the page inert at the DOM level. I did not implement a full modal portal or screen-reader isolation of background content in this pass.

### What could happen if I left it unfixed

A keyboard user could lose context when the panel appears, tab to controls underneath it, or close it without returning to the Analyse trigger. That could make analysis inaccessible or cause accidental interaction with background controls.

### Validation

ESLint, TypeScript, and the production build passed. The browser inspection verified the panel’s existing content on the homepage, but **I did not click Analyse during the smoke test**, because doing so could make an external model-provider request. I therefore did not interactively verify Escape, Tab wrapping, or focus restoration. Those behaviors are implemented but remain an explicit manual QA item.

The analysis remains informational. This UI panel’s endpoint request sends a ticker to `/api/analyze`; it does not connect its result to quote binding, approval, simulation, signing, broadcasting, or execution. Repository evidence for the endpoint and component shows the analysis is displayed as explanation and optional navigation, not an execution command.

---

## Problem 5 — Wrong-network dialog semantics, focus, and failure feedback

### Where I found it

`components/NetworkSwitchModal.tsx`, rendered by the wallet page and trade component when a connected wallet is on a non-BSC network.

### What was wrong

Before, the overlay was a styled `div` containing a heading and a switch button. It had no `role="alertdialog"`, `aria-modal`, or label/description association. It did not put focus inside the dialog or contain Tab navigation. The button called `onSwitch` directly; if switching rejected, this component did not catch the rejection or show an inline error.

The prior callers passed a no-op `onClose={() => undefined}` even though the modal was used as a blocking warning. I removed that unused prop rather than presenting a close control that could not actually close the blocking state.

### Before

```tsx
if (!open) return null;

return (
  <div className="fixed inset-0 ...">
    <div className="...">
      <h3 className="text-xl ...">Unsupported Network</h3>
      ...
      <button onClick={onSwitch} disabled={isSwitching}>
        {isSwitching ? "Switching…" : "Switch to Binance Smart Chain Mainnet"}
      </button>
    </div>
  </div>
);
```

### Why the original code was insufficient

The dialog visually blocked the page, but keyboard and assistive-technology semantics did not identify it as a modal alert. A failed switch could leave the user at the same screen without this component presenting what to do next.

### Fix

I added alert-dialog semantics, a focus loop and restoration, a live switching label, and local error state:

```tsx
<div
  ref={dialogRef}
  tabIndex={-1}
  role="alertdialog"
  aria-modal="true"
  aria-labelledby="network-switch-title"
  aria-describedby="network-switch-description"
>
  ...
  <button
    onClick={() => void handleSwitch()}
    disabled={isSwitching}
    aria-live="polite"
  >
    {isSwitching ? "Switching…" : "Switch to Binance Smart Chain Mainnet"}
  </button>
  {switchError && <p role="alert">{switchError}</p>}
</div>
```

`handleSwitch` clears the previous message, awaits the existing callback, gives a specific message when the user rejects the wallet request, and otherwise shows the thrown message or a retry instruction:

```tsx
async function handleSwitch() {
  setSwitchError(null);
  try {
    await onSwitch();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    setSwitchError(
      /user rejected|user denied|code.?4001/i.test(message)
        ? "The network change was declined in your wallet. Select BNB Smart Chain there, then retry."
        : message || "The network could not be changed. Check your wallet and retry."
    );
  }
}
```

### Why this fix works

The role and labelled relationships expose the blocking network warning as an alert dialog. The effect focuses within it, loops Tab/Shift+Tab, and restores the previously focused element when the modal closes. The error paragraph is announced as an alert. The network-switch callback itself remains the same wallet callback; no chain IDs, providers, or switch logic changed.

### What could happen if I left it unfixed

A keyboard or screen-reader user could miss why trading was blocked or where focus had moved. A declined or failed switch could leave the user without an immediately visible explanation.

### Validation

Lint, TypeScript, and production build passed. The mobile and desktop route smoke tests rendered wallet and trade pages while disconnected. **I did not connect a wallet to force a wrong-network state or trigger a rejected network switch.** Thus the modal’s live focus behavior and the various wallet-provider rejection message shapes were not end-to-end tested.

The generic `Error.message` is still displayed for non-rejection failures. I did not prove that every provider error is safe, concise, or user-friendly; a future pass should normalize known provider error shapes without hiding useful recovery information.

---

## Problem 6 — Spread color could imply an unsupported judgment

### Where I found it

- `components/OpportunityCard.tsx`, the usable executable-price range.
- `app/stock/[address]/page.tsx`, the per-share gap value.

### What was wrong

The opportunity monitor displayed the usable quote range over a green → yellow → orange gradient. Its dots represented price positions, not quality, profit, or risk, but familiar semantic colors could make the ends of the range look like a favorable/unfavorable scale.

The stock detail page used a color helper based on the absolute size of the gap:

```tsx
const tone = (g: number | null) =>
  g == null ? "text-[#64748b]"
    : Math.abs(g) < 0.25 ? "text-green-400"
    : Math.abs(g) < 1 ? "text-yellow-400"
    : "text-red-400";
```

That meant a very small difference appeared green and a large difference appeared red, regardless of sign. A positive or small difference is not itself evidence of a profitable, safe, or executable trade.

### Why it mattered

Reference/executable differences may reflect stale or incomplete quotes, venue/session mismatch, price normalization, or reliability exclusions. A positive spread is not automatically profit, arbitrage, safe execution, or “alpha.” Color alone can communicate a stronger assessment than the calculation provides.

### Before

```tsx
className="relative mt-3 h-3 rounded-full bg-gradient-to-r from-emerald-400/70 via-[#f0b90b]/70 to-[#f97316]/70"
```

```tsx
const tone = (g: number | null) =>
  g == null ? "text-[#64748b]"
    : Math.abs(g) < 0.25 ? "text-green-400"
    : Math.abs(g) < 1 ? "text-yellow-400"
    : "text-red-400";
```

### Fix

I changed the range to a neutral track with yellow venue markers:

```tsx
className="relative mt-3 h-3 rounded-full bg-white/[0.08]"
...
className="absolute ... border-2 border-[#f0b90b] bg-[#07070f] ..."
```

I changed the stock-detail gap to use the neutral WOLV accent, without changing the numeric value:

```tsx
<div className="font-black text-lg text-[#f0b90b]">
  {gap == null ? "—" : (gap > 0 ? "+" : "") + gap.toFixed(3) + "%"}
</div>
```

The monitor continues to show its existing explicit warning for different market sessions and existing stale/unreliable quote labels. Those states and the spread calculation were not changed.

### Why this fix works

The range visualization now conveys only relative position across usable quotes. Yellow is the shared WOLV accent, not a good/bad status encoding. The gap remains signed and visible as text, while session mismatch, staleness, and unreliable comparisons retain their explicit warning presentation. I did not change how `crossVenueSpread`, `referenceGap`, or normalized prices are calculated.

### What could happen if I left it unfixed

A user could read a color gradient as an opportunity ranking or treat a green/small difference as a positive trading signal. That would be a trust and trading-interpretation risk. It is not evidence that the underlying math was wrong.

### Validation

Lint, TypeScript, build, logic tests, and responsive route checks passed. I did not conduct a usability study measuring how users interpret the colors. The fix is evidenced in source; actual user interpretation is not established by repository tests.

---

## Problem 7 — Homepage exposed upstream error detail

### Where I found it

- `app/page.tsx`, the server-rendered homepage.
- `components/Homepage.tsx`, the visitor-facing unavailable state.

### What was wrong

The catch handler stored up to 160 characters of the upstream exception and passed it into the homepage. The unavailable banner displayed that text with `break-all`.

### Before

```tsx
let feedError: string | null = null;

try {
  // Fetch and validate the asset feed.
} catch (error) {
  console.error("Homepage RWA feed unavailable:", error);
  feedUnavailable = true;
  feedError = error instanceof Error
    ? error.message.slice(0, 160)
    : "The live asset feed could not be validated";
}

<Homepage
  rows={rows}
  assetCount={tokens.length}
  feedUnavailable={feedUnavailable}
  feedError={feedError}
/>
```

The client-rendered banner then included:

```tsx
Live market data is unavailable...
{feedError && <span className="... break-all">{feedError}</span>}
```

### Why the original code was insufficient

An upstream exception can contain implementation, provider, or request details that help server-side debugging but are not useful as the primary visitor message. Long or technical text also degrades the layout. A public error message should explain the user-visible state and next step without suggesting that the underlying service has recovered.

### Fix

I removed the `feedError` prop and retained the server-side log. The UI now gives a stable user-facing message:

```tsx
} catch (error) {
  console.error("Homepage RWA feed unavailable:", error);
  feedUnavailable = true;
}

...
<Homepage rows={rows} assetCount={tokens.length} feedUnavailable={feedUnavailable} />
```

```tsx
<div role="alert">
  Live market data is unavailable. WOLV is not substituting sample prices or inferred opportunities.
  Retry when the upstream market feed is available.
</div>
```

### Why this fix works

The server still logs the actual caught error for operators. The browser receives only the explicit unavailable state, with no sample-data substitute or user-visible upstream exception string.

### What could happen if I left it unfixed

A visitor could encounter confusing vendor/network exception text, long broken wrapping, or details that expose how the upstream call failed. The underlying feed could still be unavailable either way.

### Validation

The responsive smoke test passed with the production build. The hardening smoke verified homepage HTTP response and expected rendered product content. **I did not simulate an upstream feed exception in the browser after this change.** Hiding the error does not fix the underlying API failure; the feed can still fail and the server-side error log remains necessary.

---

## Problem 8 — Product metadata lagged the application

### Where I found it

`app/layout.tsx`

### What was wrong

The root metadata was:

```tsx
export const metadata: Metadata = {
  title: "WOLV Spot Lens",
  description: "Cross-venue BSC spot price monitor for tokenized equities from Ondo and bStocks",
};
```

That title and description did not describe the product’s primary story of tokenized stocks, executable/reference price comparison, and user-controlled execution on BNB Chain.

### Why it mattered

The page title appears in browser tabs, history, and other browser surfaces; metadata can also be used by search and link-preview systems. Incorrect or stale metadata makes it harder to identify the app and can make the product description inconsistent with the visible homepage.

### Fix

```tsx
export const metadata: Metadata = {
  title: "WOLV — Tokenized Stocks, On-Chain Execution",
  description:
    "Compare reference and executable prices for tokenized stocks on BNB Chain, with market context before user-controlled execution.",
};
```

### Why this fix works

The title retains WOLV branding and states the product category. The description names the core comparison and clarifies that execution remains user-controlled.

### What could happen if I left it unfixed

Browser and link surfaces would continue describing an older, narrower product and fail to reinforce what the current homepage communicates.

### Validation

I updated `scripts/hardening-smoke.mjs` to assert the new title in the homepage HTML. The production hardening smoke passed. This verifies emitted metadata, not search-engine indexing or social-card rendering.

---

## Problem 9 — Responsive coverage omitted a common phone width and did not test target bounds

### Where I found it

`scripts/responsive-smoke.mjs`

### What was wrong

The previous viewport list was:

```js
const widths = [320, 390, 768, 1440];
```

The test checked for horizontal document overflow and expected content on several routes, but did not measure mobile navigation link dimensions or ensure those links stayed within the viewport.

### Why it mattered

414 pixels is a useful additional narrow-phone width: a layout that fits at 390 may change at 414 because of breakpoint and wrapping behavior. Testing only viewport overflow also does not establish whether an individual navigation target is too small to operate comfortably.

### Fix

I expanded the viewport list:

```js
const widths = [320, 390, 414, 768, 1440];
```

I added mobile navigation geometry assertions:

```js
navTargets: Array.from(
  document.querySelectorAll('nav[aria-label="Primary navigation"] a')
).map((link) => {
  const { left, right, width, height } = link.getBoundingClientRect();
  return { left, right, width, height };
})
```

```js
if (width < 768 && layout.navTargets.length > 0) {
  assert.ok(
    layout.navTargets.every((target) => target.width >= 48 && target.height >= 48),
    `${route.path} has a primary-navigation touch target below 48px at ${width}px`
  );
  assert.ok(
    layout.navTargets.every(
      (target) => target.left >= 0 && target.right <= layout.viewport
    ),
    `${route.path} has a clipped primary-navigation target at ${width}px`
  );
}
```

### Why this fix works

The test measures the rendered primary-nav anchors rather than assuming the Tailwind classes produced a particular final box size. It checks the 48-pixel minimum selected for this UI pass and ensures each measured link remains inside the viewport.

### What could happen if I left it unfixed

A new regression at 414 pixels would go unobserved, and the smoke test could pass even if a bottom-nav target became too small or clipped while the page itself had no horizontal overflow.

### Validation

The production responsive smoke passed for the fixed routes `/`, `/gap`, `/markets`, `/trade`, and `/wallet` at all five widths. It reported no horizontal overflow, and the mobile navigation target assertions passed where the primary nav appeared.

This is an automated Chromium viewport test, not an Android-device lab. It does not prove every component is unclipped, every target is comfortable, charts are legible at every zoom level, or browser chrome/safe-area behavior is correct.

One limitation needs to be explicit: the final smoke script uses `TEST_TOKEN_ADDRESS` for dynamic stock/trade-detail routes. During the automated run no stock path was supplied, so the script printed a skip for those routes. I separately opened an actual supported stock detail and its trade detail in the browser and checked both at 320, 390, 414, 768, and 1440 pixels; they had no horizontal document overflow. That manual viewport check did not test all detail-page controls or connected-wallet states.

---

## Problem 10 — I rejected the visual reference’s demo chart/data implementation

### What I inspected

The supplied visual reference contained static ticker-to-contract mappings, hardcoded stock metadata and venue/session states, local price/candle values, and a `Math.random()` quote update loop. Its sample fetches also referenced `/api/candles` and fabricated quote fields such as fixed freshness and market status.

I checked the actual WOLV asset and candle path:

1. `app/stock/[address]/page.tsx` fetches the existing supported RWA token list and resolves the requested address against an eligible token.
2. It calls `getCandles(address, "56", "1h", "48")` from `lib/binance.ts`.
3. `lib/binance.ts` calls Binance Web3 Market API path `/api/v1/dex/market/candles` with the BSC chain ID, token address, bar, and limit.
4. `lib/candles.ts` parses documented candle response shapes, validates positive OHLC values and timestamps, sorts observations, requires at least two valid points, and applies an anchor plausibility check.
5. The stock detail page passes normalized points to `components/MarketChart.tsx`.
6. `MarketChart` shows an explicit unavailable state when fewer than two candle points exist.

The repository contains no `app/api/candles` route. The real Binance candle request is made by the existing server-side helper; it is not the mockup’s browser endpoint.

### Why copying the reference data layer would have been wrong

The mockup’s fixed addresses would bypass the live supported-asset feed and could become stale or disagree with current asset eligibility. Hardcoded candles or `Math.random()` would create a price history that did not come from Binance. Fixed `"1s old"` freshness and `"TRADING"` status would present invented state as live. Using price impact as a reference gap would use the wrong measurement. Adding a new `/api/candles` path would also create a second market-data path instead of using the existing server helper.

### Existing implementation

The stock detail fetches candles for the resolved asset address and normalizes that response:

```tsx
const candles: unknown = await getCandles(address, "56", "1h", "48")
  .catch((error: unknown) => {
    errs.push("chart data: " + (error instanceof Error ? error.message : String(error)));
    return null;
  });

const chartPoints = normalizeCandles(candles, listed);
```

The existing chart refuses to draw invented data:

```tsx
if (points.length < 2) {
  return (
    <div className="...">
      Binance candle data is temporarily unavailable.
    </div>
  );
}
```

### Fix/decision

I made no candle-data code change in the UI hardening pass. I deliberately retained the existing asset-address-to-Binance-candles-to-normalizer-to-`MarketChart` path and did not import the mockup’s hardcoded series, address map, price fallback, or random updater.

### Why this decision is technically correct

The current data layer already owns asset resolution, BSC chain selection, Binance request parameters, response normalization, and the no-data state. The UI should render those returned values, not independently recreate market identity or price calculations.

### What could happen if I copied the mockup

The app could display a plausible but false chart, show stale or ineligible contracts, mislabel price impact as a reference-price gap, or imply fresh/open market state without evidence. A polished chart would then reduce rather than improve user trust.

### Validation

I inspected a live stock-detail page in the browser and saw the existing Binance market chart with returned candles for the selected token. The rendered detail page was checked at all five widths for horizontal overflow. I did not add or run a test proving upstream candles always arrive; availability depends on the live service. I did not test the empty-candle state with a forced upstream outage in this pass.

---

## What I deliberately did NOT copy from the visual reference

I used the reference as a visual direction, not as a production data model. I deliberately did not copy:

- Hardcoded example equities, prices, venues, spreads, or issuer/session states.
- Hardcoded candle arrays or the `Math.random()` movement loop.
- The static `TICKER_ADDRESSES` map; WOLV resolves live supported token records.
- A new client-facing `/api/candles` endpoint; it does not exist in this repository.
- Fixed quote freshness such as `"1s old"` or a fixed `"TRADING"` status.
- A fallback that substitutes executable price for missing reference price.
- A mapping that treats `priceImpactPercent` as the reference/executable gap.
- A mock execution route, destination, token/share ratio, or guaranteed settlement claim.
- A second chart/data architecture alongside the existing Binance candle helper and `MarketChart`.

The visual language may be a design target. The reference’s data values and assumptions are not evidence about WOLV’s live market. Repository evidence does not establish that the mockup addresses, values, route labels, or quoted freshness matched any live WOLV response at the time it was supplied.

---

## What went wrong or remained incomplete during development

### A polished visual could have hidden invented data

I received a chart/terminal sample that looked more complete than the existing screen. It also included hardcoded values and simulated movement. Copying it wholesale would have made the chart appear live without using the application’s live candle source. I traced the existing candle flow and chose not to duplicate it.

### Some accessibility defects were not apparent from the screenshot

The prior AI panel looked like a modal, but its visual overlay did not supply keyboard trapping or focus restoration. The wrong-network warning likewise looked blocking without corresponding dialog semantics. I found these by inspecting the component code, not by judging the screenshot alone.

### Status color was stronger than its underlying meaning

The monitor’s range gradient used green through orange, while stock detail colored gap magnitude green/yellow/red. Neither color treatment was a buy/sell instruction, but either could be read as an evaluation. I neutralized those presentations without changing the prices or spread math.

### A technically useful exception was being displayed to visitors

The homepage logged the upstream RWA failure and also showed a truncated error message to users. I kept the server log and removed only the raw text from visitor-facing markup. The data source can still fail.

### Automated dynamic route coverage was not reliable in this run

The responsive script’s previous behavior attempted to discover a stock link from homepage or Markets output. During the production smoke run, no dynamic stock path was discovered for the script to exercise. The final script now runs detail routes only when `TEST_TOKEN_ADDRESS` is provided. This made the fixed-route matrix deterministic, but it also means dynamic-page regression coverage is opt-in. I compensated for this pass by separately checking a live stock and trade detail in the browser, but this does not replace a repeatable configured test asset.

### The analysis and wrong-network keyboard behavior was not fully exercised

I did not click the analysis control to avoid an external provider request, and I did not connect a wallet to force the wrong-network modal. Source changes implement keyboard handling, but those interaction paths remain unverified in a live browser session.

---

## Why leaving these issues unfixed would have mattered

### User experience

Without clear focus, keyboard users could lose their place. Without a visible network-switch error, a declined prompt could leave the user uncertain why trading remained blocked. Showing a raw upstream exception would expose an implementation-level message instead of a clear feed-unavailable state.

### Accessibility

The old modal appearance did not itself manage keyboard focus. Users could tab behind a modal, miss the dialog’s action, or lose their point of return after closing the analysis panel. Users requesting reduced motion could still experience transitions or animations not named in the old CSS list.

### Trust

Color-coded range endpoints can imply an assessment not encoded in the market comparison. A hardcoded or randomized chart would be worse: it would present fabricated history as observed market data. I avoided that path.

### Trading safety

A displayed positive/green difference is not automatically profit, arbitrage, or a safe trade. Session mismatch, staleness, reference normalization, venue characteristics, and execution changes still matter. I changed UI semantics only; no calculation or eligibility rule changed.

### Mobile usability

Fixed minimum widths in a five-item bottom bar can crowd narrow layouts. A page can fit without horizontal document overflow while an individual touch target is too small or clipped. The new smoke assertions catch those specific navigation conditions at mobile widths.

### Maintainability

Copying static token maps and adding a parallel candle endpoint would have duplicated asset identity and market-data responsibilities. Future UI work would then need to decide which source to trust.

### Production quality

A final submission should not imply real-time data where none exists, make market comparisons look like trade recommendations through color alone, or hide failure behind confusing raw text. These are trust and UX defects; I do not classify them as security vulnerabilities.

---

## What I deliberately did NOT change

I compared the `HEAD` diff for the protected transaction files. In this UI pass I did **not** modify:

- Binance authentication or request signing.
- Binance API endpoints or response interpretation.
- Quote calculations or executable-price calculations.
- Reference-price calculations or token/share normalization.
- ERC-8056 handling.
- Spread calculations or quote freshness rules.
- Quote binding.
- Swap preparation or calldata generation.
- Approval transaction generation or approval logic.
- Transaction simulation.
- Wallet signing or broadcasting.
- RFQ submission or order-status logic.
- BSC chain configuration or chain IDs.
- Token, router, or spender addresses.
- The trade state machine.

The only diff in `components/TradeButton.tsx` removes the unused no-op `onClose` prop passed to the blocking network dialog. The only diff in `app/wallet/page.tsx` removes the same no-op prop. The callback and network-switch implementation in the wallet hook were not changed.

This statement is specific to the final UI pass. At the initial inspection, earlier analysis-related work was also uncommitted in this worktree; I have not represented that separate work as part of this pass. The later combined commit contains some of that separate work, so its aggregate file list is not a clean proxy for the scope of this UI pass.

---

## Validation results

### TypeScript

**Command:** `npx tsc --noEmit`
**Result:** Passed after the production build had generated `.next/types`.
**What it proves:** The project’s TypeScript program typechecked in the generated Next.js environment.
**What it does not prove:** Runtime behavior, market-data correctness, responsive layout, or wallet-provider compatibility.

I initially ran standalone TypeScript while the build was regenerating `.next/types`; that overlapping check reported missing generated type files. I reran it after the build completed and it passed. I did not treat the race-affected run as a code defect.

### ESLint

**Command:** `npm run lint`
**Result:** Passed with no remaining warnings after I fixed a React ref-cleanup warning in the new focus-restoration effect.
**What it proves:** ESLint accepted the project source under its current configuration.
**What it does not prove:** Accessibility conformance or actual interaction behavior.

### Production build

**Command:** `npm run build`
**Result:** Passed. Next.js compiled, ran its TypeScript phase, generated static pages, and finalized route traces.
**What it proves:** The current app compiled and Next’s production build type phase succeeded.
**What it does not prove:** Every route’s upstream integrations are healthy, every screen is visually correct, or a live wallet transaction works.

### Logic tests

**Command:** `npm run test:logic`
**Result:** 46 tests passed, 0 failed.
**What it proves:** Existing candle-normalization, opportunity-math, trade-readiness, and other tested helper behavior remained green, including tests present for the earlier AI work.
**What it does not prove:** The UI keyboard behavior or browser layout. These are unit/logic tests, not a complete end-to-end test.

### Hardening smoke tests

**Command:** `BASE_URL=http://127.0.0.1:3001 npm run test:hardening`
**Result:** Passed against the local production server after I updated the title assertion to match the new page metadata.
**What it proves:** The checked pages returned HTTP 200 with nontrivial response bodies; homepage text and title assertions matched; selected malformed quote/swap/approval/portfolio/status/broadcast/analysis requests returned their expected rejection statuses, including oversized analysis payload handling.
**What it does not prove:** Successful trade execution, live model configuration, quote correctness, wallet behavior, or all API error cases.

### Automated responsive smoke tests

**Command:** `BASE_URL=http://127.0.0.1:3001 npm run test:responsive`
**Result:** Fixed routes `/`, `/gap`, `/markets`, `/trade`, and `/wallet` passed at 320, 390, 414, 768, and 1440 pixels. The script reported no horizontal document overflow. Mobile primary-nav measurements passed its 48-pixel minimum and viewport-bound checks.
**What it proves:** Chromium rendered those routes at those viewport widths and passed the script’s content, overflow, and navigation assertions.
**What it does not prove:** Every component has ideal dimensions, all pages work on every real Android device, OS/browser safe areas behave identically, wallet modal works with a provider, or all dynamic stock routes are covered. The script skips dynamic detail routes unless `TEST_TOKEN_ADDRESS` is set.

The smoke script’s navigation target threshold is 48 pixels by 48 pixels. This is the explicit threshold enforced by the script; it is not evidence that every other control has the same minimum.

### Browser validation

**Method:** I used the integrated browser against the built local production app and manually changed viewport widths to 320, 390, 414, 768, and 1440 pixels.

**Result:** I inspected the homepage/fixed routes through the responsive run, and separately opened a real live stock detail and its trade detail. The detail page rendered its existing Binance market chart; both dynamic pages had no horizontal document overflow at the five widths. The trade-detail page showed the disconnected wallet connection state.

**What it proves:** Those observed pages rendered at those widths in the browser at that time.
**What it does not prove:** A wallet was connected, the wrong-network modal was exercised, the analysis dialog’s keyboard behavior was manually exercised, the model endpoint was called, or every Android/browser combination works. No signing, approval, broadcast, or transaction was attempted.

### Diff and scope checks

**Commands:** `git diff --check`; `git diff --name-only HEAD`; targeted `git diff` inspection of trade and transaction files.
**Result:** Whitespace check passed. No diff was present in the quote, swap, approval, simulation, broadcast, RFQ, wallet-hook, quote-binding, or address/configuration files. `components/TradeButton.tsx` had only the unused modal prop removed.
**What it proves:** The inspected working-tree diff did not modify those protected implementation files.
**What it does not prove:** That every pre-existing uncommitted change in the worktree belonged to this pass. The repository was dirty before the pass, and the later `f72dc69` commit includes separate analysis and asset work alongside the UI changes.

---

## Before / after summary

| Area | Before | Problem | Fix | Why it matters | Validation |
|------|--------|---------|-----|----------------|------------|
| Global focus | No shared `:focus-visible` styling | Keyboard focus could be inconsistent or hard to locate | Added a 2px WOLV-yellow outline and offset for common controls | Makes keyboard position visible without forcing outlines on every pointer click | Build/lint passed; no exhaustive keyboard visual audit |
| Reduced motion | Only named animations were disabled | Other transitions or future animations could continue | Added reduced durations and iteration limits under the media query | Respects motion preference across current and future CSS | Build/lint passed; browser media emulation not run |
| Mobile navigation | Fixed minimum-width links in `justify-around`; no explicit link labels; “AI live” wording | Narrow-bar crowding and ambiguous AI status | Flexible equal-width links, 48px minimum height, aria labels, “AI read” wording | Improves target sizing and truthful assistive labels | Five widths; measured bounds and size for mobile |
| Analysis dialog | Dialog role present; no Escape, focus loop, or return focus | Keyboard focus could escape behind overlay | Focus on open, Tab loop, Escape close, restore trigger focus | Makes modal operation predictable by keyboard | Static checks/build; dialog not clicked in browser |
| Network dialog | Styled overlay without dialog semantics/focus handling; no caught switch error | Assistive technology and keyboard users lacked dialog context; rejection lacked local feedback | `alertdialog`, focus containment/restoration, live switch label, inline error | Makes required network action and failure visible | Build/lint passed; no wrong-network wallet test |
| Quote range colors | Green→yellow→orange range gradient | Could look like a favorable-to-unfavorable opportunity scale | Neutral track and yellow markers | Shows relative position without implying profit | Source/build/responsive tests; no user study |
| Stock gap color | Magnitude-based green/yellow/red helper | Could look like a good/bad trade rating | Neutral WOLV-yellow gap value; signed percentage unchanged | Separates numeric difference from trade judgment | Source/build/logic tests |
| Homepage feed error | Truncated upstream error rendered to visitors | Technical exception text was not useful public UI | Retained server log; stable feed-unavailable message | Preserves operator diagnostics without exposing raw details as UI copy | Hardening and responsive smoke; no forced feed failure |
| Metadata | “WOLV Spot Lens” and narrow description | Browser/link labels lagged product story | Product-focused title and description | Better identification across browser surfaces | Hardening test checks exact title |
| Responsive coverage | 320, 390, 768, 1440; overflow only | No 414 case or nav target checks | Added 414 and 48px target/bounds assertions | Catches a useful intermediate phone width and fixed-nav regressions | All five widths passed for fixed routes |
| Candle/chart path | Existing Binance helper and normalizer | Visual sample proposed separate static/mock path | Kept `getCandles` → `normalizeCandles` → `MarketChart` | Preserves one source of truth and avoids invented price history | Live browser stock chart observed; no outage injection |

---

## What this pass accomplished

I tightened keyboard feedback, modal interaction behavior, motion preference handling, mobile navigation sizing, and the semantics of market-difference colors. I removed visitor-facing upstream exception text while retaining server-side logging. I aligned page metadata with the actual product story and expanded automated responsive assertions.

I also verified that the attractive chart mockup was not an appropriate source of production data. I kept WOLV’s actual supported-asset and Binance candle architecture intact.

## Remaining limitations

- The analysis dialog was not opened during browser testing. Escape handling, Tab wrapping, and focus restoration need a focused interactive check.
- The wrong-network modal was not triggered with a real or test wallet. Provider-specific switch failures may still produce a raw `Error.message` in the modal.
- Reduced-motion CSS was not visually tested with browser emulation.
- Automated stock/trade detail coverage is opt-in via `TEST_TOKEN_ADDRESS`. I manually checked one live supported stock and its trade route at the required widths, but that is not repeatable automated coverage.
- I did not test connected portfolio data, wallet connector selection, wrong-chain behavior, or any transaction.
- I did not force an upstream market-feed failure after hiding the homepage error text. The upstream service may still fail.
- The production model provider was not called as part of this UI pass.
- Browser warnings about the configured WalletConnect metadata URL differing from the local `127.0.0.1` URL appeared during local testing; that local-origin mismatch does not establish a production WalletConnect defect.
- This was not a full reskin of every internal page; legacy inline trade styles and other visual inconsistencies remain.

## What I would test next

1. Run the responsive script with a known, currently eligible `TEST_TOKEN_ADDRESS` so the stock and trade detail routes are tested automatically at each configured viewport.
2. Use keyboard-only interaction to open and close the analysis panel, verify Escape, forward/backward Tab wrapping, and focus restoration.
3. Emulate reduced motion and confirm ticker, pulsing indicators, chart draw, and transitions stop or reduce as expected.
4. With an owner-controlled test wallet, deliberately select a non-BSC network and test accepted, rejected, and failed network-switch outcomes without signing a trade.
5. Force or stub an upstream feed failure in a controlled test and verify the visitor-facing unavailable state while the server retains useful diagnostics.
