import { useEffect, useRef, useState } from "react";

type NetworkSwitchModalProps = {
  open: boolean;
  isSwitching: boolean;
  onSwitch: () => Promise<void> | void;
};

export default function NetworkSwitchModal({
  open,
  isSwitching,
  onSwitch,
}: NetworkSwitchModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const first = dialog?.querySelector<HTMLElement>(focusableSelector);
    first?.focus();

    function keepFocusInDialog(event: KeyboardEvent) {
      if (event.key !== "Tab" || !dialog) return;

      const items = dialog.querySelectorAll<HTMLElement>(focusableSelector);
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!firstItem || !lastItem) {
        event.preventDefault();
      } else if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener("keydown", keepFocusInDialog);
    return () => {
      document.removeEventListener("keydown", keepFocusInDialog);
      if (previouslyFocused && previouslyFocused !== document.body) previouslyFocused.focus();
    };
  }, [open]);

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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#02060d]/80 px-4 backdrop-blur-sm">
      <div ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="network-switch-title" aria-describedby="network-switch-description" className="my-4 max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-[#d9a80a]/40 bg-[#0e0e1c] p-5 shadow-2xl shadow-[#d9a80a]/10 sm:p-6">
        <div>
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#d9a80a]/15 text-2xl" aria-hidden="true">!</div>

          <h3 id="network-switch-title" className="text-xl font-black text-white">Unsupported Network</h3>
          <p id="network-switch-description" className="mt-3 text-sm leading-6 text-[#cbd5e1]">
            Your wallet is connected to a network that cannot trade WOLV tokenized equities. This terminal requires Binance Smart Chain Mainnet to stay compliant with the Spot Trading Only hackathon rule.
          </p>

          <div className="mt-4 rounded-xl border border-[#d9a80a]/30 bg-[#d9a80a]/5 p-3 text-sm font-bold text-[#d9a80a]">
            Switch to Binance Smart Chain Mainnet
          </div>

          <button
            onClick={() => void handleSwitch()}
            disabled={isSwitching}
            aria-live="polite"
            className="mt-5 min-h-12 w-full rounded-xl bg-[#d9a80a] px-4 py-3 text-sm font-black text-black transition hover:bg-[#f7ce57] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSwitching ? "Switching…" : "Switch to Binance Smart Chain Mainnet"}
          </button>
          {switchError && <p role="alert" className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-3 text-xs leading-5 text-rose-200">{switchError}</p>}

          <p className="mt-3 text-center text-[11px] uppercase tracking-[0.18em] text-[#64748b]">
            Required before WOLV Spot Lens interaction
          </p>
        </div>
      </div>
    </div>
  );
}
