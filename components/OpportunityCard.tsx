import Image from "next/image";
import Link from "next/link";
import { quoteAgeSeconds } from "@/lib/quotes";
import { marketLabel, MAX_RELIABLE_GAP_PERCENT, signedPercent, type OpportunityRow, type VenueResult } from "@/lib/opportunityMath";

function isInReliableSpread(venue: VenueResult): boolean {
  return venue.quote.ok &&
    !venue.stale &&
    !venue.unreliable &&
    venue.referenceGap != null &&
    venue.executablePerShare != null &&
    venue.executablePerShare > 0;
}

function price(value: number | null): string {
  return value == null ? "—" : `$${value.toFixed(3)}`;
}

export default function OpportunityCard({ row }: { row: OpportunityRow }) {
  const reliableVenues = row.venues.filter(isInReliableSpread);
  const reliablePrices = reliableVenues
    .map((venue) => venue.executablePerShare as number)
    .filter(Number.isFinite);
  const minPrice = reliablePrices.length ? Math.min(...reliablePrices) : null;
  const maxPrice = reliablePrices.length ? Math.max(...reliablePrices) : null;
  const priceRange = minPrice != null && maxPrice != null ? maxPrice - minPrice : 0;

  return (
    <article className="overflow-hidden rounded-2xl border border-white/[0.09] bg-[#0e0e1c] shadow-[0_18px_54px_rgba(0,0,0,.22)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.07] px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Featured cross-listed ticker</div>
          <h2 className="mt-1 text-xl font-black tracking-tight text-white sm:text-2xl">{row.ticker}</h2>
        </div>
        <div className="min-w-[8rem] text-left sm:text-right">
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Executable spread · per share</div>
          <div className={`mt-1 text-lg font-black ${row.crossVenueSpread == null ? "text-slate-400" : "text-[#f0b90b]"}`}>
            {row.crossVenueSpread == null ? "Unavailable" : signedPercent(row.crossVenueSpread)}
          </div>
        </div>
      </div>

      {row.statusMismatch && (
        <div role="status" className="mx-4 mt-4 rounded-lg border border-yellow-800/60 bg-yellow-900/10 p-3 text-xs leading-relaxed text-yellow-300 sm:mx-5">
          <span className="font-bold uppercase tracking-wider">Different market sessions</span>
          <span className="ml-2">Venue status differs ({row.statuses.join(" vs ")}); this price range may reflect session timing, not a tradable opportunity.</span>
        </div>
      )}

      {reliableVenues.length >= 2 && minPrice != null && maxPrice != null && (
        <div className="mx-4 mt-4 rounded-xl border border-white/[0.06] bg-[#0a0a14] px-3 py-3 sm:mx-5">
          <div className="flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
            <span>Lowest usable quote</span><span>Highest usable quote</span>
          </div>
          <div
            role="img"
            aria-label={`Usable executable prices range from ${price(minPrice)} to ${price(maxPrice)} per share across ${reliableVenues.length} venues`}
            className="relative mt-3 h-3 rounded-full bg-white/[0.08]"
          >
            {reliableVenues.map((venue, index) => {
              const amount = venue.executablePerShare as number;
              const position = priceRange === 0 ? 50 : ((amount - minPrice) / priceRange) * 100;
              return (
                <span
                  key={venue.token.tokenContractAddress}
                  title={`${venue.token.platformId}: ${price(amount)} per share`}
                  className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#f0b90b] bg-[#07070f] shadow-[0_0_0_2px_rgba(7,7,15,.55)]"
                  style={{ left: `${position}%`, zIndex: index + 1 }}
                />
              );
            })}
          </div>
          <div className="mt-2 text-[10px] text-slate-500">Relative range among the usable quotes shown below; not an estimate of profit.</div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-2 sm:p-5">
        {row.venues.map((venue) => {
          const usable = isInReliableSpread(venue);
          const label = marketLabel(venue.token);
          return (
            <Link
              key={venue.token.tokenContractAddress}
              href={`/stock/${venue.token.tokenContractAddress}`}
              className={`block min-w-0 rounded-xl border p-3 transition-colors hover:border-[#f0b90b]/40 ${
                venue.stale || venue.unreliable || !venue.quote.ok || venue.referenceGap == null
                  ? "border-yellow-900/50 bg-yellow-900/[0.04]"
                  : "border-white/[0.07] bg-[#0a0a14]"
              }`}
            >
              <div className="flex min-w-0 items-center gap-2">
                {venue.token.tokenLogoUrl && (
                  <Image src={venue.token.tokenLogoUrl} width={20} height={20} className="size-5 shrink-0 rounded-full" alt="" />
                )}
                <span className="min-w-0 truncate text-xs font-bold capitalize text-slate-300">{venue.token.platformId}</span>
                <span className="ml-auto max-w-[48%] break-words text-right text-[10px] capitalize text-slate-500">{label}</span>
              </div>

              {venue.quote.ok ? (
                <>
                  <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className={`text-lg font-black ${venue.unreliable ? "text-yellow-300" : "text-white"}`}>
                      {venue.unreliable ? "Unreliable quote" : price(venue.executablePerShare)}
                    </span>
                    {!venue.unreliable && <span className="text-[10px] text-slate-500">executable / share</span>}
                  </div>
                  <div className="mt-1 break-words text-[11px] text-slate-400">
                    Reference {price(venue.referencePerShare)} · {venue.multiplier == null ? "share ratio unavailable" : `${venue.multiplier.toFixed(4)} shares/token`}
                  </div>
                  <div className={`mt-1 text-[11px] font-semibold ${venue.unreliable || venue.stale ? "text-yellow-300" : "text-slate-300"}`}>
                    {venue.unreliable
                      ? `Excluded: reference gap exceeds ${MAX_RELIABLE_GAP_PERCENT}%`
                      : venue.referenceGap == null
                        ? "Reference comparison unavailable; excluded from spread"
                        : `Reference difference ${signedPercent(venue.referenceGap)}${usable ? " · included" : ""}`}
                  </div>
                  <div className="mt-2 break-words text-[10px] text-slate-500">
                    {venue.quote.vendor} · {venue.quote.mode} · impact {venue.quote.impact == null ? "n/a" : `${venue.quote.impact}%`} · {quoteAgeSeconds(venue.quote)}s old
                  </div>
                  {venue.stale && <div className="mt-2 text-[10px] font-bold uppercase tracking-wider text-yellow-300">Stale quote · refresh before trading</div>}
                </>
              ) : (
                <div className="mt-3 break-words text-xs leading-relaxed text-yellow-300">Quote unavailable: {venue.quote.err}</div>
              )}
            </Link>
          );
        })}
      </div>
    </article>
  );
}
