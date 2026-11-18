"use client"

import dynamic from "next/dynamic"
import { useConnect } from "wagmi"
import { walletConnectProjectId } from "@/lib/wagmi"

// AppKit is created only in the browser (app/providers.tsx), so its button must never render on
// the server. Without a WalletConnect project ID, fall back to the injected browser wallet.
const AppKitConnectButton = dynamic(
    () => import("@/components/WalletSelector").then((module) => module.AppKitConnectButton),
    { ssr: false, loading: () => <ConnectButtonShell label="Connect wallet" disabled /> },
)

function ConnectButtonShell({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick?: () => void }) {
    return (
        <button type="button" onClick={onClick} disabled={disabled}
            className="wolv-connect-button inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg px-5 text-sm font-bold disabled:cursor-wait disabled:opacity-60">
            {label} <span aria-hidden="true">→</span>
        </button>
    )
}

function InjectedConnectButton() {
    const { connect, connectors, isPending, error } = useConnect()
    const injected = connectors[0]
    return (
        <div>
            <ConnectButtonShell
                label={isPending ? "Wallet connection pending..." : "Connect wallet"}
                disabled={isPending || !injected}
                onClick={() => injected && connect({ connector: injected })}
            />
            {error && <p role="alert" className="mt-3 text-sm text-rose-400">{error.message}</p>}
        </div>
    )
}

const STEPS = [
    { title: "Authorize once", body: "Your smart account installs the policy hook and sets limits: token, per-trade cap, entry price, slippage and expiry." },
    { title: "Agent trades within limits", body: "The worker signs bounded intents; the hook re-checks every rule and the Chainlink price floor on-chain." },
    { title: "Stay in control", body: "Pause the schedule, trigger the global stop, or revoke on-chain at any time. No per-trade custody." },
]

const VERIFIED_TX = "https://testnet.bscscan.com/tx/0xfd4025d73c656ad2d252ab737a33363cbe55b6ca242fba5f3b771a24af974375"

/** Disconnected state for /agent: connect the owner wallet, with a concise explanation and proof. */
export default function AgentConnectCard() {
    return (
        <section className="wolv-glass mb-5 overflow-hidden rounded-2xl p-5 sm:p-7" aria-labelledby="agent-connect-title">
            <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:items-center">
                <div>
                    <h2 id="agent-connect-title" className="text-xl font-bold text-white">Connect your owner wallet</h2>
                    <p className="mt-2 text-sm leading-6 text-slate-400">
                        Load your smart account&apos;s on-chain policy, or configure a new one. Connecting does not sign or send anything.
                    </p>
                    <div className="mt-5 max-w-xs">
                        {walletConnectProjectId ? <AppKitConnectButton /> : <InjectedConnectButton />}
                    </div>
                    <a href={VERIFIED_TX} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-[#d9a80a] transition hover:text-[#f2c94c]">
                        <span className="size-1.5 rounded-full bg-[#d9a80a]" aria-hidden="true" />
                        Verified autonomous trade on BSC Testnet ↗
                    </a>
                </div>
                <ol className="grid gap-3">
                    {STEPS.map((step, index) => (
                        <li key={step.title} className="flex gap-4 rounded-xl border border-white/[0.07] bg-white/[0.025] p-4">
                            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-[#d9a80a]/40 bg-[#d9a80a]/[0.08] text-xs font-black text-[#f2c94c]">{index + 1}</span>
                            <div>
                                <div className="text-sm font-semibold text-white">{step.title}</div>
                                <p className="mt-1 text-xs leading-5 text-slate-400">{step.body}</p>
                            </div>
                        </li>
                    ))}
                </ol>
            </div>
        </section>
    )
}
