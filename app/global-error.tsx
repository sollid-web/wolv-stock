"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("WOLV global error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-[#07070f] text-white">
        <main className="flex min-h-screen items-center justify-center px-6">
          <section className="w-full max-w-lg rounded-2xl border border-[#1b1b35] bg-[#0e0e1c] p-7 text-center">
            <h1 className="text-2xl font-black">WOLV is temporarily unavailable</h1>
            <p className="mt-3 text-sm leading-relaxed text-[#94a3b8]">
              The application shell failed to load. Retry the page; wallet actions are not available while this screen is shown.
            </p>
            <button onClick={reset} className="mt-6 rounded-xl bg-[#d9a80a] px-5 py-3 text-sm font-bold text-black hover:bg-[#d9a80a]/90">
              Reload application
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
