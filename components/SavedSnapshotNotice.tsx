const STALE_AFTER_MS = 15 * 60_000

function age(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000))
    if (minutes < 60) return `${minutes} min`
    const hours = Math.round(minutes / 60)
    if (hours < 48) return `${hours} h`
    return `${Math.round(hours / 24)} days`
}

/** Labels saved market data with its age so a cached comparison is never mistaken for live data. */
export default function SavedSnapshotNotice({ savedAt, liveFeedAvailable }: { savedAt: number | null; liveFeedAvailable: boolean }) {
    // eslint-disable-next-line react-hooks/purity -- server-rendered age label
    const ageMs = savedAt === null ? null : Date.now() - savedAt
    const stale = ageMs === null || ageMs > STALE_AFTER_MS
    if (liveFeedAvailable && !stale) return null
    return (
        <div role="status" className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-xs leading-relaxed text-amber-100">
            <span className="font-bold">Saved snapshot{ageMs !== null ? ` · updated ${age(ageMs)} ago` : ""}.</span>{" "}
            {liveFeedAvailable ? "" : "The live Binance feed is temporarily unavailable. "}
            Prices shown are the last validated comparison WOLV stored, not live quotes. Request a fresh quote before trading.
        </div>
    )
}
