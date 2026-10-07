"use client";
import { useState } from "react";
import Link from "next/link";
import { PRIMARY_TABS, MORE_TABS } from "@/lib/rwaData";

const chip = (active: boolean) =>
  `whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-bold border transition-colors focus-visible:outline-2 focus-visible:outline-[#d9a80a] ${
    active
      ? "bg-[#d9a80a] text-black border-[#d9a80a]"
      : "bg-[#0e0e1c] text-[#94a3b8] border-[#1b1b35] hover:border-[#d9a80a]/40"
  }`;

// Category is chosen via ?tab=<tabId>; the server page re-fetches the token list from Binance with that tabId.
export default function CategoryTabs({ active, basePath = "/" }: { active: number | null; basePath?: string }) {
  const [open, setOpen] = useState(false);
  const activeMore = MORE_TABS.find((t) => t.id === active);

  return (
    <nav aria-label="Sector categories" className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 pb-3 sm:px-8">
      <div className="flex min-w-0 max-w-full gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-wrap md:overflow-visible">
        <Link href={basePath} scroll={false} prefetch={false} aria-current={active == null ? "page" : undefined} className={chip(active == null)}>
          All
        </Link>
        {PRIMARY_TABS.map((t) => (
          <Link
            key={t.id}
            href={`${basePath}?tab=${t.id}`}
            scroll={false}
            prefetch={false}
            aria-current={active === t.id ? "page" : undefined}
            className={chip(active === t.id)}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {/* Outside the scroll area so the menu is never clipped */}
      <div className="relative shrink-0">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={chip(!!activeMore)}
        >
          {activeMore ? activeMore.label : "More"} ▾
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden="true" />
            <div
              role="menu"
              className="absolute right-0 top-full mt-2 z-30 w-52 max-h-72 overflow-y-auto rounded-xl border border-[#1b1b35] bg-[#0e0e1c] p-1 shadow-xl"
            >
              {MORE_TABS.map((t) => (
                <Link
                  key={t.id}
                  href={`${basePath}?tab=${t.id}`}
                  scroll={false}
                  prefetch={false}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={`block px-3 py-2 rounded-lg text-xs font-bold ${
                    active === t.id ? "bg-[#d9a80a] text-black" : "text-[#94a3b8] hover:bg-[#1b1b35]"
                  }`}
                >
                  {t.label}
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    </nav>
  );
}
