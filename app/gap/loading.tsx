import BrandMark from "@/components/BrandMark";

export default function GapLoading() {
  return (
    <main className="wolv-app-shell min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom))] text-white md:pb-10">
      <nav className="sticky top-0 z-10 border-b border-white/[0.1] bg-[#070711]/72 px-4 py-4 backdrop-blur-2xl sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center gap-4">
          <BrandMark compact />
          <div className="hidden h-7 w-px bg-white/10 sm:block" />
          <div>
            <h1 className="text-base font-black sm:text-lg">Listed vs Indicative Estimate</h1>
            <p className="text-xs text-[#64748b]">Preparing the live comparison monitor · BSC spot</p>
          </div>
        </div>
      </nav>
      <section className="mx-auto max-w-6xl px-4 pt-6 sm:px-6" aria-busy="true" aria-live="polite">
        <div className="mb-5 max-w-4xl text-xs leading-relaxed text-[#94a3b8]">
          Checking the current asset feed and indicative quotes. The monitor will show verified results or a clear unavailable state; it will not infer prices.
        </div>
        <div className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-[#64748b]">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#d9a80a]" />
          Loading comparison data
        </div>
        <div className="space-y-4">
          {["loading-a", "loading-b", "loading-c"].map((key) => (
            <div key={key} className="animate-pulse rounded-2xl border border-white/[0.09] bg-[#0e0e1c] p-5" aria-hidden="true">
              <div className="h-5 w-32 rounded bg-white/[0.08]" />
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="h-12 rounded bg-white/[0.06]" />
                <div className="h-12 rounded bg-white/[0.06]" />
                <div className="h-12 rounded bg-white/[0.06]" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
