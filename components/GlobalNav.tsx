"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type IconName = "home" | "markets" | "trade" | "wallet" | "ai";

function NavIcon({ name }: { name: IconName }) {
  const props = {
    className: "size-5",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  if (name === "home") return <svg {...props}><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9" /><path d="M9 20v-6h6v6" /></svg>;
  if (name === "markets") return <svg {...props}><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></svg>;
  if (name === "trade") return <svg {...props}><path d="M4 7h15l-3-3" /><path d="m19 7-3 3" /><path d="M20 17H5l3 3" /><path d="m5 17 3-3" /></svg>;
  if (name === "wallet") return <svg {...props}><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 9h18" /><path d="M16 14h.01" /><path d="M7 5V3h10v2" /></svg>;
  return <svg {...props}><path d="m12 3 1.5 6.2L20 11l-6.5 1.8L12 19l-1.5-6.2L4 11l6.5-1.8L12 3Z" /><path d="m19 4 .5 2.2L22 7l-2.5.8L19 10l-.5-2.2L16 7l2.5-.8L19 4Z" /></svg>;
}

export default function GlobalNav() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    // Handle exact matches and partial matches for dynamic routes
    if (href === "/trade" && pathname.startsWith("/trade/")) {
      return true;
    }
    return pathname === href;
  };

  return (
    <nav aria-label="Primary navigation" className="fixed bottom-0 left-0 right-0 z-50 border-t border-white/[0.1] bg-[#080912]/75 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl md:hidden">
      <div className="mx-auto flex h-16 max-w-lg items-center">
        <Link href="/" aria-current={isActive("/") ? "page" : undefined} aria-label="Home" className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-semibold transition-colors ${isActive("/") ? "text-[#f0b90b]" : "text-slate-500 hover:text-slate-200"}`}>
          <NavIcon name="home" /><span>Home</span>
        </Link>
        <Link href="/markets" aria-current={isActive("/markets") ? "page" : undefined} aria-label="Markets" className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-semibold transition-colors ${isActive("/markets") ? "text-[#f0b90b]" : "text-slate-500 hover:text-slate-200"}`}>
          <NavIcon name="markets" /><span>Markets</span>
        </Link>
        <Link href="/#intelligence" aria-label="AI market analysis" className="flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-semibold text-sky-300 transition-colors hover:text-sky-200">
          <span className="relative"><NavIcon name="ai" /><span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-sky-300" /></span><span>AI read</span>
        </Link>
        <Link href="/trade" aria-current={isActive("/trade") || pathname.startsWith("/trade/") ? "page" : undefined} aria-label="Trade" className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-semibold transition-colors ${isActive("/trade") || pathname.startsWith("/trade/") ? "text-[#f0b90b]" : "text-slate-500 hover:text-slate-200"}`}>
          <NavIcon name="trade" /><span>Trade</span>
        </Link>
        <Link href="/wallet" aria-current={isActive("/wallet") ? "page" : undefined} aria-label="Portfolio and wallet" className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-semibold transition-colors ${isActive("/wallet") ? "text-[#f0b90b]" : "text-slate-500 hover:text-slate-200"}`}>
          <NavIcon name="wallet" /><span>Portfolio</span>
        </Link>
      </div>
    </nav>
  );
}
