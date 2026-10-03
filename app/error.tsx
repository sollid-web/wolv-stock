"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("WOLV route error:", error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#07070f] px-6 text-white">
      <section className="w-full max-w-lg rounded-2xl border border-[#1b1b35] bg-[#0e0e1c] p-7 text-center shadow-[0_0_0_1px_rgba(240,185,11,0.08)]">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-yellow-500/15 text-xl text-[#f0b90b]">!</div>
        <h1 className="mt-5 text-2xl font-black">This view could not load</h1>
        <p className="mt-3 text-sm leading-relaxed text-[#94a3b8]">
          WOLV hit an unexpected application error. No wallet signature, approval, or transaction was sent.
        </p>
        {error.digest && <p className="mt-3 text-[10px] uppercase tracking-wider text-[#64748b]">Reference: {error.digest}</p>}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button onClick={reset} className="rounded-xl bg-[#f0b90b] px-5 py-3 text-sm font-bold text-black hover:bg-[#f0b90b]/90">
            Try again
          </button>
          <Link href="/" className="rounded-xl border border-[#334155] px-5 py-3 text-sm font-bold text-white hover:border-[#f0b90b]/60">
            Back to WOLV
          </Link>
        </div>
      </section>
    </main>
  );
}
