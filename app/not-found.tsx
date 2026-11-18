import Link from "next/link";
import GlobalNav from "@/components/GlobalNav";

export default function NotFound() {
  return (
    <>
      <main className="flex min-h-screen items-center justify-center bg-[#07070f] px-4 text-white">
        <div className="max-w-md text-center">
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-[#d9a80a]">404</div>
          <h1 className="mt-3 text-2xl font-bold">This page or asset isn&apos;t listed</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            The address may be wrong, or the tokenized stock is not currently eligible for BSC spot trading on WOLV.
          </p>
          <div className="mt-6 flex justify-center gap-3 text-sm font-semibold">
            <Link href="/markets" className="rounded-xl bg-[#d9a80a] px-4 py-2.5 text-[#07070f]">Browse markets</Link>
            <Link href="/" className="rounded-xl border border-white/15 px-4 py-2.5 text-slate-200">Home</Link>
          </div>
        </div>
      </main>
      <GlobalNav />
    </>
  );
}
