/**
 * Calls the web app's market-pulse updater on an interval from the always-on worker, because the
 * Vercel Hobby plan only allows daily cron jobs. Optional: disabled unless both an https URL and
 * CRON_SECRET are configured. Never throws; failures are logged and retried next interval.
 */
export function startMarketPulseRefresher(options: {
    url?: string
    cronSecret?: string
    intervalMs?: number
    fetchImpl?: typeof fetch
    log?: (message: string) => void
}): { stop: () => void; refresh: () => Promise<boolean> } | null {
    const url = options.url?.trim()
    const secret = options.cronSecret?.trim()
    if (!url || !secret) return null
    let parsed: URL
    try { parsed = new URL(url) } catch { return null }
    if (parsed.protocol !== "https:") return null
    const fetchImpl = options.fetchImpl ?? fetch
    const log = options.log ?? ((message: string) => console.info(message))
    let running = false
    const refresh = async () => {
        if (running) return false
        running = true
        try {
            const response = await fetchImpl(parsed, {
                headers: { Authorization: `Bearer ${secret}` },
                signal: AbortSignal.timeout(60_000),
            })
            if (!response.ok) log(`Market pulse refresh failed with HTTP ${response.status}.`)
            return response.ok
        } catch (error) {
            log(`Market pulse refresh failed: ${error instanceof Error ? error.message : String(error)}`)
            return false
        } finally {
            running = false
        }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, Math.max(60_000, options.intervalMs ?? 5 * 60_000))
    timer.unref?.()
    return { stop: () => clearInterval(timer), refresh }
}
