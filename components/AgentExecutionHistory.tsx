"use client"

import { useEffect, useState } from "react"
import { formatEther, formatUnits } from "viem"

type Execution = {
    claimId: string
    scheduleName: string | null
    status: string
    failureCode: string | null
    userOperationHash: string | null
    transactionHash: string | null
    blockNumber: string | null
    amountIn: string | null
    receivedAmount: string | null
    createdAt: number | null
}

const POLL_MS = 15_000

function explorerBase(chainId: number): string {
    return chainId === 56 ? "https://bscscan.com" : "https://testnet.bscscan.com"
}

function shortHash(value: string): string {
    return `${value.slice(0, 10)}…${value.slice(-6)}`
}

function statusClass(status: string): string {
    if (status === "CONFIRMED") return "text-emerald-300"
    if (status === "FAILED" || status === "STOPPED") return "text-red-300"
    return "text-amber-200"
}

/** Read-only history of the owner's autonomous executions with on-chain evidence links. */
export default function AgentExecutionHistory({ chainId, tokenLabel = "token" }: { chainId: number; tokenLabel?: string }) {
    const [items, setItems] = useState<Execution[]>([])
    const [error, setError] = useState<string | null>(null)
    const [showFailures, setShowFailures] = useState(false)

    useEffect(() => {
        let cancelled = false
        async function load() {
            try {
                const response = await fetch("/api/agent/executions?limit=50", { cache: "no-store", credentials: "same-origin" })
                const data = await response.json()
                if (!response.ok || !Array.isArray(data.executions)) throw new Error(typeof data.error === "string" ? data.error : "Execution history could not be loaded.")
                if (!cancelled) { setItems(data.executions as Execution[]); setError(null) }
            } catch (cause) {
                if (!cancelled) setError(cause instanceof Error ? cause.message : "Execution history could not be loaded.")
            }
        }
        void load()
        const timer = setInterval(() => void load(), POLL_MS)
        return () => { cancelled = true; clearInterval(timer) }
    }, [])

    const confirmed = items.filter(item => item.status === "CONFIRMED")
    const visible = showFailures ? items : items.filter(item => item.status !== "FAILED")
    const totalIn = confirmed.reduce((sum, item) => sum + BigInt(item.amountIn ?? "0"), BigInt(0))
    const totalOut = confirmed.reduce((sum, item) => sum + BigInt(item.receivedAmount ?? "0"), BigInt(0))
    const base = explorerBase(chainId)

    return (
        <div className="mt-4 border-t border-slate-800 pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-bold text-slate-200">Autonomous trade history</h3>
                <span className="text-xs text-slate-500">
                    {confirmed.length} confirmed · {formatEther(totalIn)} BNB in · {formatUnits(totalOut, 18)} {tokenLabel} received
                </span>
            </div>
            {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
            {!error && visible.length === 0 && <p className="mt-2 text-xs text-slate-500">No autonomous trades yet.</p>}
            {visible.length > 0 && (
                <ul className="mt-2 divide-y divide-slate-800 text-xs">
                    {visible.map(item => (
                        <li key={item.claimId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                            <span className="text-slate-400">{item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"}</span>
                            <span className={`font-semibold ${statusClass(item.status)}`}>{item.status}{item.failureCode ? ` · ${item.failureCode}` : ""}</span>
                            <span className="text-slate-300">
                                {item.amountIn ? `${formatEther(BigInt(item.amountIn))} BNB` : ""}
                                {item.receivedAmount ? ` → ${formatUnits(BigInt(item.receivedAmount), 18)} ${tokenLabel}` : ""}
                            </span>
                            {item.transactionHash ? (
                                <a className="break-all text-sky-300 underline" href={`${base}/tx/${item.transactionHash}`} target="_blank" rel="noreferrer">{shortHash(item.transactionHash)}</a>
                            ) : item.userOperationHash ? (
                                <span className="break-all text-slate-500">UserOp {shortHash(item.userOperationHash)}</span>
                            ) : <span className="text-slate-600">not submitted</span>}
                        </li>
                    ))}
                </ul>
            )}
            {items.some(item => item.status === "FAILED") && (
                <button type="button" onClick={() => setShowFailures(value => !value)} className="mt-2 text-xs text-slate-400 underline">
                    {showFailures ? "Hide failed attempts" : "Show failed attempts"}
                </button>
            )}
        </div>
    )
}
