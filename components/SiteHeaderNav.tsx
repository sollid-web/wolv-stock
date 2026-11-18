"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { connectedAddressFromWagmiStore, shortAddress } from "@/lib/walletSession";

const LINKS = [
  { href: "/markets", label: "Markets", match: (path: string) => path === "/markets" || path.startsWith("/stock/") },
  { href: "/#opportunities", label: "Opportunities", match: () => false },
  { href: "/gap", label: "Monitor", match: (path: string) => path === "/gap" },
  { href: "/trade", label: "Trade", match: (path: string) => path === "/trade" || path.startsWith("/trade/") },
  { href: "/agent", label: "Agent", match: (path: string) => path === "/agent" },
  { href: "/wallet", label: "Portfolio", match: (path: string) => path === "/wallet" },
];

/** Desktop navigation links with a clear active state for the current page. */
export function SiteHeaderLinks() {
  const pathname = usePathname() ?? "/";
  return (
    <div className="hidden min-w-0 items-center gap-1 md:flex lg:gap-2">
      {LINKS.map((link) => {
        const active = link.match(pathname);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`relative rounded-lg px-2.5 py-2 text-xs font-semibold transition lg:px-3 ${
              active ? "bg-[#d9a80a]/[0.08] text-[#f2c94c]" : "text-slate-400 hover:bg-white/[0.04] hover:text-white"
            }`}
          >
            {link.label}
            {active && <span aria-hidden="true" className="absolute inset-x-2.5 -bottom-[13px] h-0.5 rounded-full bg-[#d9a80a] lg:inset-x-3" />}
          </Link>
        );
      })}
    </div>
  );
}

function subscribeWalletSession(onChange: () => void) {
  // "storage" covers other tabs; focus/visibility cover returning from a wallet popup or tab.
  window.addEventListener("storage", onChange);
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

function readWalletSession(): string {
  try {
    return connectedAddressFromWagmiStore(window.localStorage.getItem("wagmi.store")) ?? "";
  } catch {
    return "";
  }
}

/** Header wallet action: shows the connected wallet, or Connect; hidden on /wallet and /agent. */
export function SiteHeaderWalletAction() {
  const pathname = usePathname() ?? "/";
  const address = useSyncExternalStore(subscribeWalletSession, readWalletSession, () => "");
  if (pathname === "/wallet" || pathname === "/agent") return null;
  if (address) {
    return (
      <Link
        href="/wallet"
        title={address}
        aria-label={`Connected wallet ${address}. Open portfolio`}
        className="inline-flex items-center gap-2 rounded-lg border border-[#d9a80a]/35 bg-[#d9a80a]/[0.08] px-3 py-2 font-mono text-[11px] font-bold text-[#f2c94c] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition hover:bg-[#d9a80a]/[0.14]"
      >
        <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
        {shortAddress(address)}
      </Link>
    );
  }
  return (
    <Link href="/wallet" className="wolv-connect-button rounded-lg px-3 py-2 text-[11px] font-black sm:px-4">
      <span className="sm:hidden">Connect</span>
      <span className="hidden sm:inline">Connect wallet</span>
    </Link>
  );
}
