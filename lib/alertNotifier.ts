export type WorkerAlert = {
    severity: "INFO" | "WARNING" | "CRITICAL"
    kind: string
    message: string
    ownerAddress?: string
    claimId?: string
    createdAt: number
}

type NotifierOptions = {
    webhookUrl?: string
    workerId: string
    minSeverity?: WorkerAlert["severity"]
    repeatWindowMs?: number
    fetchImpl?: typeof fetch
    now?: () => number
}

const RANK = { INFO: 0, WARNING: 1, CRITICAL: 2 } as const

/**
 * Pushes worker alerts to an operator webhook (Discord, Slack, or any JSON endpoint).
 * Best effort: never throws and never blocks the worker; repeated alerts of the same kind are
 * suppressed within the repeat window. Disabled when no https webhook URL is configured.
 */
export function createAlertNotifier(options: NotifierOptions) {
    const url = parseWebhookUrl(options.webhookUrl)
    const minRank = RANK[options.minSeverity ?? "CRITICAL"]
    const repeatWindowMs = options.repeatWindowMs ?? 10 * 60_000
    const fetchImpl = options.fetchImpl ?? fetch
    const now = options.now ?? Date.now
    const lastSent = new Map<string, number>()

    return {
        enabled: url !== null,
        async notify(alert: WorkerAlert): Promise<boolean> {
            if (!url || RANK[alert.severity] < minRank) return false
            const key = `${alert.severity}:${alert.kind}:${alert.ownerAddress ?? ""}`
            const previous = lastSent.get(key)
            if (previous !== undefined && now() - previous < repeatWindowMs) return false
            lastSent.set(key, now())
            const text = `[WOLV ${alert.severity}] ${alert.kind} on ${options.workerId}: ${alert.message}`.slice(0, 1_900)
            try {
                const response = await fetchImpl(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text, content: text }),
                    signal: AbortSignal.timeout(5_000),
                })
                return response.ok
            } catch {
                return false
            }
        },
    }
}

function parseWebhookUrl(value: string | undefined): string | null {
    const trimmed = value?.trim()
    if (!trimmed) return null
    try {
        const parsed = new URL(trimmed)
        return parsed.protocol === "https:" ? parsed.toString() : null
    } catch {
        return null
    }
}
