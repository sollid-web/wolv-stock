export default function Loading() {
  return (
    <main className="min-h-screen bg-[#07070f] px-4 py-8 text-white sm:px-6">
      <div className="mx-auto w-full max-w-5xl animate-pulse space-y-6">
        <div className="h-10 w-56 rounded-lg bg-[#1b1b35]" />
        <div className="grid gap-4 md:grid-cols-3">
          <div className="h-28 rounded-xl border border-[#1b1b35] bg-[#0e0e1c]" />
          <div className="h-28 rounded-xl border border-[#1b1b35] bg-[#0e0e1c]" />
          <div className="h-28 rounded-xl border border-[#1b1b35] bg-[#0e0e1c]" />
        </div>
        <div className="h-64 rounded-xl border border-[#1b1b35] bg-[#0e0e1c]" />
        <div className="flex items-center gap-3 text-xs text-[#64748b]" role="status" aria-live="polite">
          <span className="h-2 w-2 rounded-full bg-[#d9a80a]" />
          Loading WOLV data…
        </div>
      </div>
    </main>
  );
}
