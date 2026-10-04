"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
    <nav aria-label="Primary navigation" className="fixed bottom-0 left-0 right-0 z-50 flex h-[calc(4rem+env(safe-area-inset-bottom))] items-center justify-around border-t border-white/[0.1] bg-[#0a0a14]/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
      <Link href="/" className={`flex flex-col items-center text-sm font-medium ${isActive("/") ? "text-[#f0b90b]" : "text-[#64748b]"}`}>
        <span className="w-8 h-8 rounded-full bg-[#f0b90b]/20 flex items-center justify-center text-xs font-black">
          W
        </span>
        <span className="mt-1">Home</span>
      </Link>
      <Link href="/gap" className={`flex flex-col items-center text-sm font-medium ${isActive("/gap") ? "text-[#f0b90b]" : "text-[#64748b]"}`}>
        <span className="w-8 h-8 rounded-full bg-[#f0b90b]/20 flex items-center justify-center text-xs font-black">
          📊
        </span>
        <span className="mt-1">Markets</span>
      </Link>
      <Link href="/trade" className={`flex flex-col items-center text-sm font-medium ${isActive("/trade") || pathname.startsWith("/trade/") ? "text-[#f0b90b]" : "text-[#64748b]"}`}>
        <span className="w-8 h-8 rounded-full bg-[#f0b90b]/20 flex items-center justify-center text-xs font-black">
          💱
        </span>
        <span className="mt-1">Trade</span>
      </Link>
      <Link href="/wallet" className={`flex flex-col items-center text-sm font-medium ${isActive("/wallet") ? "text-[#f0b90b]" : "text-[#64748b]"}`}>
        <span className="w-8 h-8 rounded-full bg-[#f0b90b]/20 flex items-center justify-center text-xs font-black">
          👛
        </span>
        <span className="mt-1">Wallet</span>
      </Link>
    </nav>
  );
}
