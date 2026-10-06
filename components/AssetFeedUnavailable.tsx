import Link from "next/link";

type Props = {
  title: string;
  description: string;
  backHref: string;
  backLabel: string;
};

export default function AssetFeedUnavailable({ title, description, backHref, backLabel }: Props) {
  return (
    <main className="min-h-screen bg-[#07070f] pb-[calc(6rem+env(safe-area-inset-bottom))] text-white md:pb-10">
      <nav className="border-b border-[#1b1b35] bg-[#0e0e1c] px-4 py-4 sm:px-6">
        <Link href={backHref} className="text-sm font-bold text-[#d9a80a] hover:text-[#f2c94c]">
          ← {backLabel}
        </Link>
      </nav>
      <section className="mx-auto flex min-h-[60vh] w-full max-w-3xl items-center px-4 py-10 sm:px-6">
        <div role="status" aria-live="polite" className="w-full rounded-2xl border border-yellow-800/50 bg-[#0e0e1c] p-6 sm:p-8">
          <div className="mb-3 text-xs font-black uppercase tracking-[0.16em] text-yellow-400">Live data unavailable</div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">{description}</p>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            WOLV cannot verify this asset without the live RWA list. No price, quote, opportunity, or trade action is inferred from missing data.
          </p>
          <Link href={backHref} className="mt-6 inline-flex min-h-11 items-center rounded-lg border border-[#d9a80a]/40 px-4 py-2 text-sm font-bold text-[#d9a80a] hover:bg-[#d9a80a]/10">
            {backLabel}
          </Link>
        </div>
      </section>
    </main>
  );
}
