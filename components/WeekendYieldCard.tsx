export type WeekendYieldStatus =
  | "REGULAR_HOURS"
  | "WEEKEND_YIELDING_ACTIVE"
  | "CLOSED"
  | "UNKNOWN";

export type WeekendYieldCardProps = {
  status?: WeekendYieldStatus;
  poolName?: string;
  protocolName?: string;
  apyPercent?: number | null;
  redeemDelayDays?: readonly [string, string] | readonly [];
  previewWarnings?: readonly string[];
};

const statusPresentation: Record<WeekendYieldStatus, {
  label: string;
  detail: string;
  className: string;
  dotClassName: string;
}> = {
  REGULAR_HOURS: {
    label: "Regular hours",
    detail: "Traditional market session",
    className: "border-white/10 bg-white/[0.045] text-slate-300",
    dotClassName: "bg-slate-400",
  },
  WEEKEND_YIELDING_ACTIVE: {
    label: "Weekend preview",
    detail: "Calendar closure verified",
    className: "border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-200 shadow-[0_0_22px_rgba(52,211,153,.08)]",
    dotClassName: "bg-emerald-300 shadow-[0_0_10px_rgba(52,211,153,.8)]",
  },
  CLOSED: {
    label: "Market closed",
    detail: "No active yield transaction",
    className: "border-[#d9a80a]/20 bg-[#d9a80a]/[0.05] text-[#f2c94c]",
    dotClassName: "bg-[#d9a80a]",
  },
  UNKNOWN: {
    label: "Status unavailable",
    detail: "Calendar verification required",
    className: "border-amber-300/20 bg-amber-300/[0.05] text-amber-100",
    dotClassName: "bg-amber-300",
  },
};

function isValidApy(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000;
}

function formatDelay(delay: WeekendYieldCardProps["redeemDelayDays"]): string {
  if (!delay || delay.length !== 2 || !delay.every((day) => /^\d{1,4}$/.test(day))) {
    return "Provider delay unavailable";
  }
  return delay[0] === delay[1]
    ? `${delay[0]} day${delay[0] === "1" ? "" : "s"}`
    : `${delay[0]}–${delay[1]} days`;
}

export default function WeekendYieldCard({
  status = "UNKNOWN",
  poolName = "Venus · BSC",
  protocolName = "Venus",
  apyPercent = null,
  redeemDelayDays,
  previewWarnings = [],
}: WeekendYieldCardProps) {
  const presentation = statusPresentation[status];

  return (
    <article className="wolv-glass relative isolate overflow-hidden rounded-2xl p-5 shadow-[0_24px_70px_rgba(0,0,0,.32)] sm:p-6">
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-28 -z-10 size-72 rounded-full bg-emerald-300/[0.06] blur-3xl" />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-[#d9a80a]/20 bg-[#d9a80a]/[0.06] text-[#f2c94c] shadow-[inset_0_1px_0_rgba(255,255,255,.06)]" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" className="size-5">
              <path d="M4 17.5 9.2 12l3.4 3.2L20 7.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M15.5 7.5H20v4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-[#d9a80a]">Weekend DeFi router</p>
            <h2 className="mt-1 text-lg font-black tracking-tight text-white">Idle balance preview</h2>
            <p className="mt-1 text-xs text-slate-500">Manual review · unsigned transaction builds only</p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.11em] ${presentation.className}`}>
          <span className={`size-1.5 rounded-full ${presentation.dotClassName} ${status === "WEEKEND_YIELDING_ACTIVE" ? "animate-pulse" : ""}`} />
          {presentation.label}
        </span>
      </header>

      <div className="mt-5 grid gap-3 sm:grid-cols-[1.15fr_.85fr]">
        <div className="rounded-xl border border-white/[0.07] bg-black/20 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-500">Target pool</p>
              <p className="mt-1.5 text-sm font-bold text-white">{poolName}</p>
            </div>
            <span className="rounded-lg border border-white/[0.08] bg-white/[0.035] px-2.5 py-1.5 text-[9px] font-bold text-slate-300">
              {protocolName}
            </span>
          </div>
          <div className="mt-4 flex items-end justify-between border-t border-white/[0.07] pt-3">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Indicative APY</p>
              <p className="mt-1 text-2xl font-black tracking-tight text-white tabular-nums">
                {isValidApy(apyPercent) ? `${apyPercent.toFixed(2)}%` : <span className="text-slate-500">—</span>}
              </p>
            </div>
            <span className="pb-1 text-[9px] font-medium text-slate-500">
              {isValidApy(apyPercent) ? "provider-supplied" : "Live data unavailable"}
            </span>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-xl border border-white/[0.07] bg-black/20 p-4">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-500">Session signal</p>
            <p className="mt-2 text-xs font-semibold text-slate-200">{presentation.detail}</p>
          </div>
          <div className="mt-4 border-t border-white/[0.07] pt-3">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Redeem delay</p>
            <p className="mt-1 text-xs font-bold text-slate-200">{formatDelay(redeemDelayDays)}</p>
          </div>
        </div>
      </div>

      {previewWarnings.length > 0 && (
        <ul aria-label="Provider preview warnings" className="mt-3 space-y-1 rounded-xl border border-amber-300/15 bg-amber-300/[0.035] p-3 text-[10px] leading-4 text-amber-100/75">
          {previewWarnings.slice(0, 3).map((warning, index) => (
            <li key={`${index}-${warning}`} className="flex gap-2">
              <span aria-hidden="true" className="text-amber-200">!</span>
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 border-t border-white/[0.07] pt-3 text-[9px] leading-[1.65] text-slate-500">
        Binance <code className="font-mono text-slate-400">redeemDelayDays</code> is an estimate from the provider. Redemption is asynchronous and is not guaranteed to settle by the next market open. A session mismatch alone never triggers a deposit.
      </p>
    </article>
  );
}
