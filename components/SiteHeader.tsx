import Link from "next/link";
import BrandMark from "@/components/BrandMark";

/** Desktop/tablet site header shared by the homepage and app pages (mobile uses GlobalNav). */
export default function SiteHeader({ networkLabel = "BNB Chain · Mainnet" }: { networkLabel?: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.09] bg-[#070711]/70 backdrop-blur-2xl">
      <nav aria-label="Main navigation" className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <BrandMark />
        <div className="hidden min-w-0 items-center gap-5 md:flex lg:gap-7">
          <Link href="/markets" className="text-xs font-semibold text-slate-400 transition hover:text-white">Markets</Link>
          <Link href="/#opportunities" className="text-xs font-semibold text-slate-400 transition hover:text-white">Opportunities</Link>
          <Link href="/gap" className="text-xs font-semibold text-slate-400 transition hover:text-white">Monitor</Link>
          <Link href="/trade" className="text-xs font-semibold text-slate-400 transition hover:text-white">Trade</Link>
          <Link href="/agent" className="text-xs font-semibold text-slate-400 transition hover:text-white">Agent</Link>
          <Link href="/wallet" className="text-xs font-semibold text-slate-400 transition hover:text-white">Portfolio</Link>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-sky-300/20 bg-sky-300/[0.05] px-2.5 py-2 text-[9px] font-bold text-sky-200 xl:flex">
            <span className="size-1.5 rounded-full bg-sky-300" /> AI market read
          </span>
          <span className="hidden items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.03] px-3 py-2 text-[10px] font-semibold text-slate-300 lg:flex">
            <span className="size-1.5 rounded-full bg-[#d9a80a]" />
            {networkLabel}
          </span>
          <Link href="/wallet" className="wolv-connect-button rounded-lg px-3 py-2 text-[11px] font-black sm:px-4">
            Connect wallet
          </Link>
        </div>
      </nav>
    </header>
  );
}
