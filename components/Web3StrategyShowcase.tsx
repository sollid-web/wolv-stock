import ExecutionModePolicyToggle from "@/components/ExecutionModePolicyToggle";
import RfqTicket from "@/components/RfqTicket";
import WeekendYieldCard from "@/components/WeekendYieldCard";

export default function Web3StrategyShowcase() {
  return (
    <section aria-labelledby="web3-strategy-showcase-title" className="mx-auto max-w-7xl px-4 pb-10 sm:px-6 md:pb-14">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-[#d9a80a]">New · Manual-first strategy tools</p>
          <h2 id="web3-strategy-showcase-title" className="mt-1 text-xl font-black tracking-tight text-white sm:text-2xl">
            Plan with context. Stay in control.
          </h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-slate-400">
            Preview exposure limits, weekend DeFi checks, and the RFQ review flow. These panels do not load live yield or RFQ quotes, and choosing a mode does not start execution.
          </p>
        </div>
        <span className="rounded-full border border-white/[0.08] bg-white/[0.025] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">
          Strategy preview · no signing
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ExecutionModePolicyToggle />
        <WeekendYieldCard />
        <div className="xl:col-span-2">
          <RfqTicket />
        </div>
      </div>
    </section>
  );
}
