"use client"

import { useCallback, useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import {
    encodeFunctionData,
    formatEther,
    getAddress,
    isAddress,
    type Address,
    type Hex
} from "viem"
import { useAccount, useSignMessage, useWalletClient } from "wagmi"
import AgentSetupForm, { type AgentConfiguredStrategy } from "@/components/AgentSetupForm"
import {
    AGENT_POLICY_HOOK_ABI
} from "@/lib/setupAgentPolicy"
import {
    getAgentPublicClient,
    createKernelClientFromContext,
    getKernelAccountContext,
    type AgentKernelClient
} from "@/lib/kernelClient"
import { isBscNetworkAllowedOnPath, isSupportedBscChainId } from "@/lib/bscChain"

type RuntimeSchedule = {
    scheduleId: string
    name: string
    enabled: boolean
}

type RuntimeWorkerReadiness = {
    workerReady: boolean
    workerConfigIssues: string[]
    executionGateEnabled: boolean
    executionGateReason: string | null
}

type PolicySnapshot = {
    account: Address
    chainId: number
    installed: boolean
    revoked: boolean
    paused: boolean
    targetToken: Address
    configured: boolean
    policyHash: Hex
    maxTradeValue: bigint
    expiresAt: bigint
    intentSigner: Address
}

const configuredChainId = Number(
    process.env.NEXT_PUBLIC_CHAIN_ID
    ?? process.env.NEXT_PUBLIC_BSC_CHAIN_ID
    ?? "56"
)
const validatorEnv = process.env.NEXT_PUBLIC_POLICY_HOOK_ADDRESS
    || process.env.NEXT_PUBLIC_VALIDATOR_ADDRESS
const validatorAddress = validatorEnv && isAddress(validatorEnv)
    ? getAddress(validatorEnv)
    : null

function formatExpiration(timestamp: bigint): string {
    return new Date(Number(timestamp) * 1000).toLocaleString()
}

function StatusIndicator({ label, active }: { label: string; active: boolean }) {
    return (
        <span className={`inline-flex items-center gap-2 text-sm font-medium ${active ? "text-emerald-300" : "text-slate-400"}`}>
            <span className={`size-2 rounded-full ${active ? "bg-emerald-400" : "bg-slate-600"}`} aria-hidden="true" />
            {label}
        </span>
    )
}

function getFriendlyError(error: unknown): string {
    const message = error instanceof Error ? error.message.toLowerCase() : ""
    if (/user rejected|user denied|rejected the request|code.?4001/.test(message)) {
        return "Wallet approval was declined. No policy change was completed."
    }
    if (/chain|network|entrypoint|validator|bundler|rpc/.test(message)) {
        return "The connected wallet or agent policy service is not configured for this BNB Chain network."
    }
    return "The on-chain agent policy could not be loaded or updated. Check the network and try again."
}

export default function AgentPolicyPanel() {
    const pathname = usePathname()
    const { address, chainId, isConnected } = useAccount()
    const { data: walletClient } = useWalletClient()
    const { signMessageAsync } = useSignMessage()
    const [kernelClient, setKernelClient] = useState<AgentKernelClient | null>(null)
    const [publicClient, setPublicClient] = useState<ReturnType<typeof getAgentPublicClient> | null>(null)
    const [clientOwnerKey, setClientOwnerKey] = useState("")
    const [derivedAccount, setDerivedAccount] = useState<{ address: Address; ownerKey: string } | null>(null)
    const [snapshot, setSnapshot] = useState<PolicySnapshot | null>(null)
    const [snapshotOwnerKey, setSnapshotOwnerKey] = useState("")
    const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000))
    const [error, setError] = useState("")
    const [notice, setNotice] = useState("")
    const [busy, setBusy] = useState(false)
    const [lastUserOperation, setLastUserOperation] = useState<Hex | null>(null)
    const [pendingStrategy, setPendingStrategy] = useState<AgentConfiguredStrategy | null>(null)
    const [runtimeSchedule, setRuntimeSchedule] = useState<RuntimeSchedule | null>(null)
    const [runtimeScheduleLoaded, setRuntimeScheduleLoaded] = useState(false)
    const [runtimeSessionAuthenticated, setRuntimeSessionAuthenticated] = useState(false)
    const [runtimeWorkerReadiness, setRuntimeWorkerReadiness] = useState<RuntimeWorkerReadiness | null>(null)
    const [runtimeBusy, setRuntimeBusy] = useState(false)
    const [runtimeError, setRuntimeError] = useState("")

    const chainConfigured = isSupportedBscChainId(configuredChainId)
    const configuredNetworkName = configuredChainId === 97
        ? "BNB Smart Chain Testnet"
        : "BNB Smart Chain Mainnet"
    const bundlerVariable = configuredChainId === 97
        ? "NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL"
        : "NEXT_PUBLIC_BSC_BUNDLER_RPC_URL"
    const bundlerConfigured = Boolean(configuredChainId === 97
        ? process.env.NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL
        : process.env.NEXT_PUBLIC_BSC_BUNDLER_RPC_URL)
    const correctChain = isConnected
        && chainId === configuredChainId
        && isBscNetworkAllowedOnPath(pathname, chainId)
    const walletReady = Boolean(address && walletClient && correctChain)
    const walletKey = address ? `${chainId}:${address.toLowerCase()}` : ""
    const currentDerivedAccount = derivedAccount?.ownerKey === walletKey ? derivedAccount.address : null

    const refreshPolicy = useCallback(async (
        account: Address,
        currentChainId: number,
        currentOwnerAddress: Address,
        currentPublicClient = getAgentPublicClient()
    ) => {
        if (!validatorAddress) {
            throw new Error("Configure NEXT_PUBLIC_POLICY_HOOK_ADDRESS with the deployed validator address.")
        }
        const [installed, revoked, policy, targetToken, paused] = await Promise.all([
            currentPublicClient.readContract({
                address: validatorAddress,
                abi: AGENT_POLICY_HOOK_ABI,
                functionName: "isInitialized",
                args: [account]
            }),
            currentPublicClient.readContract({
                address: validatorAddress,
                abi: AGENT_POLICY_HOOK_ABI,
                functionName: "isRevoked",
                args: [account]
            }),
            currentPublicClient.readContract({
                address: validatorAddress,
                abi: AGENT_POLICY_HOOK_ABI,
                functionName: "getAccountPolicy",
                args: [account]
            }),
            currentPublicClient.readContract({
                address: validatorAddress,
                abi: AGENT_POLICY_HOOK_ABI,
                functionName: "getTargetToken",
                args: [account]
            }),
            currentPublicClient.readContract({
                address: validatorAddress,
                abi: AGENT_POLICY_HOOK_ABI,
                functionName: "paused"
            })
        ])
        setSnapshot({
            account,
            chainId: currentChainId,
            installed,
            revoked,
            paused,
            targetToken,
            configured: policy[0],
            policyHash: policy[1],
            maxTradeValue: policy[2],
            expiresAt: policy[3],
            intentSigner: policy[4]
        })
        setSnapshotOwnerKey(`${currentChainId}:${currentOwnerAddress.toLowerCase()}`)
    }, [])

    useEffect(() => {
        let cancelled = false
        let refreshTimer: ReturnType<typeof setInterval> | undefined
        if (!walletReady || !walletClient || !address) return

        void (async () => {
            try {
                const nextPublicClient = getAgentPublicClient()
                const context = await getKernelAccountContext(walletClient)
                if (cancelled) return
                const ownerAddress = getAddress(address)
                const accountAddress = getAddress(context.account.address)
                const ownerKey = `${context.chain.id}:${ownerAddress.toLowerCase()}`
                setDerivedAccount({ address: accountAddress, ownerKey })
                setKernelClient(null)
                setPublicClient(nextPublicClient)
                setClientOwnerKey(ownerKey)
                if (!validatorAddress) {
                    setError("")
                    return
                }
                await refreshPolicy(accountAddress, context.chain.id, ownerAddress, nextPublicClient)
                setError("")
                if (cancelled) return
                if (!bundlerConfigured) {
                    setError(`Configure ${bundlerVariable} before submitting agent policy transactions.`)
                    return
                }
                const nextKernelClient = createKernelClientFromContext(context)
                setKernelClient(nextKernelClient)
                refreshTimer = setInterval(() => {
                    setNowSeconds(Math.floor(Date.now() / 1000))
                    void refreshPolicy(accountAddress, context.chain.id, ownerAddress, nextPublicClient).catch((cause: unknown) => {
                        if (!cancelled) setError(getFriendlyError(cause))
                    })
                }, 15_000)
            } catch (cause) {
                if (!cancelled) setError(getFriendlyError(cause))
            }
        })()
        return () => {
            cancelled = true
            if (refreshTimer) clearInterval(refreshTimer)
        }
    }, [address, chainId, walletClient, walletReady, refreshPolicy, bundlerConfigured, bundlerVariable])

    const refreshRuntimeSchedule = useCallback(async () => {
        if (!address || !isConnected || !currentDerivedAccount) {
            setRuntimeScheduleLoaded(false)
            setRuntimeSchedule(null)
            setRuntimeSessionAuthenticated(false)
            setRuntimeWorkerReadiness(null)
            return
        }
        try {
            const sessionResponse = await fetch("/api/agent/session", {
                cache: "no-store",
                credentials: "same-origin"
            })
            const session = await sessionResponse.json()
            if (!sessionResponse.ok || session.authenticated !== true ||
                typeof session.address !== "string" || session.address.toLowerCase() !== address.toLowerCase()) {
                setRuntimeSessionAuthenticated(false)
                setRuntimeSchedule(null)
                setRuntimeWorkerReadiness(null)
                setRuntimeScheduleLoaded(true)
                return
            }
            setRuntimeSessionAuthenticated(true)
            const scheduleResponse = await fetch("/api/agent/schedules", {
                cache: "no-store",
                credentials: "same-origin"
            })
            const data = await scheduleResponse.json()
            if (!scheduleResponse.ok || !Array.isArray(data.schedules)) {
                throw new Error(typeof data.error === "string" ? data.error : "Autonomous schedule status could not be loaded.")
            }
            if (typeof data.workerReady === "boolean" && typeof data.executionGateEnabled === "boolean") {
                setRuntimeWorkerReadiness({
                    workerReady: data.workerReady,
                    workerConfigIssues: Array.isArray(data.workerConfigIssues) ? data.workerConfigIssues.filter((item: unknown): item is string => typeof item === "string") : [],
                    executionGateEnabled: data.executionGateEnabled,
                    executionGateReason: typeof data.executionGateReason === "string" ? data.executionGateReason : null,
                })
            }
            const matching = data.schedules.filter((item: unknown) => {
                if (typeof item !== "object" || item === null || Array.isArray(item)) return false
                const schedule = item as Record<string, unknown>
                const config = schedule.strategyConfig
                return schedule.strategyType === "BSC_AGENT_TRADE" &&
                    schedule.executionMode === "AUTONOMOUS" &&
                    typeof config === "object" && config !== null && !Array.isArray(config) &&
                    typeof (config as Record<string, unknown>).account === "string" &&
                    (config as Record<string, unknown>).account.toLowerCase() === currentDerivedAccount.toLowerCase()
            }) as Array<Record<string, unknown>>
            const selected = matching.find(item => item.enabled === true) ?? matching[0]
            setRuntimeSchedule(selected && typeof selected.scheduleId === "string" && typeof selected.name === "string"
                ? { scheduleId: selected.scheduleId, name: selected.name, enabled: selected.enabled === true }
                : null)
            setRuntimeError("")
        } catch (cause) {
            setRuntimeSchedule(null)
            setRuntimeError(cause instanceof Error ? cause.message : "Autonomous schedule status could not be loaded.")
        } finally {
            setRuntimeScheduleLoaded(true)
        }
    }, [address, isConnected, currentDerivedAccount])

    useEffect(() => {
        void refreshRuntimeSchedule()
    }, [refreshRuntimeSchedule])

    async function authenticateRuntimeSession(): Promise<boolean> {
        if (!isConnected || !address) {
            setRuntimeError("Connect the owner wallet before enabling autonomous execution.")
            return false
        }
        try {
            const challengeResponse = await fetch("/api/agent/session/challenge", {
                method: "POST",
                cache: "no-store",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address })
            })
            const challenge = await challengeResponse.json()
            if (!challengeResponse.ok || typeof challenge.message !== "string") {
                throw new Error(typeof challenge.error === "string" ? challenge.error : "Autonomous worker wallet authentication is unavailable.")
            }
            const signature = await signMessageAsync({ message: challenge.message })
            const response = await fetch("/api/agent/session", {
                method: "POST",
                cache: "no-store",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address, message: challenge.message, signature })
            })
            const session = await response.json()
            if (!response.ok || session.authenticated !== true) {
                throw new Error(typeof session.error === "string" ? session.error : "Autonomous worker wallet authentication failed.")
            }
            setRuntimeSessionAuthenticated(true)
            return true
        } catch (cause) {
            setRuntimeError(cause instanceof Error ? cause.message : "Autonomous worker wallet authentication failed.")
            return false
        }
    }

    async function enableAutonomousSchedule() {
        if (!pendingStrategy) return
        setRuntimeBusy(true)
        setRuntimeError("")
        try {
            if (!runtimeSessionAuthenticated && !(await authenticateRuntimeSession())) return
            const strategy = pendingStrategy
            const response = await fetch("/api/agent/schedules", {
                method: "POST",
                cache: "no-store",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: strategy.strategyId,
                    intervalSeconds: 60,
                    policyVersion: "WOLV_AGENT_POLICY_V3",
                    policy: {
                        targetToken: strategy.targetToken,
                        maxTradeValueWei: strategy.maxTradeValueWei,
                        expiresAt: strategy.expiresAt,
                        intentSigner: strategy.intentSigner
                    },
                    strategyType: "BSC_AGENT_TRADE",
                    executionMode: "AUTONOMOUS",
                    strategyConfig: {
                        id: strategy.strategyId,
                        account: strategy.account,
                        targetToken: strategy.targetToken,
                        amountBnb: strategy.amountBnb,
                        entryPriceMicros: strategy.entryPriceMicros,
                        slippageBps: strategy.slippageBps,
                        maxPriceImpactBps: strategy.maxPriceImpactBps
                    }
                })
            })
            const data = await response.json()
            if (!response.ok || typeof data.scheduleId !== "string" || data.execution !== "AUTONOMOUS_SCHEDULED") {
                throw new Error(typeof data.error === "string" ? data.error : "The autonomous strategy could not be registered.")
            }
            setRuntimeSchedule({ scheduleId: data.scheduleId, name: strategy.strategyId, enabled: true })
            if (typeof data.workerReady === "boolean" && typeof data.executionGateEnabled === "boolean") {
                setRuntimeWorkerReadiness({
                    workerReady: data.workerReady,
                    workerConfigIssues: Array.isArray(data.workerConfigIssues) ? data.workerConfigIssues.filter((item: unknown): item is string => typeof item === "string") : [],
                    executionGateEnabled: data.executionGateEnabled,
                    executionGateReason: typeof data.executionGateReason === "string" ? data.executionGateReason : null,
                })
            }
            setPendingStrategy(null)
            setRuntimeScheduleLoaded(true)
            setNotice("Autonomous strategy saved. The worker evaluates it every 60 seconds when the worker process is running and execution gates are enabled; individual trades do not require owner approval.")
        } catch (cause) {
            setRuntimeError(cause instanceof Error ? cause.message : "The autonomous strategy could not be registered.")
        } finally {
            setRuntimeBusy(false)
        }
    }

    async function setAutonomousScheduleEnabled(enabled: boolean) {
        if (!runtimeSchedule) return
        setRuntimeBusy(true)
        setRuntimeError("")
        try {
            const response = await fetch("/api/agent/schedules", {
                method: "PATCH",
                cache: "no-store",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ scheduleId: runtimeSchedule.scheduleId, enabled })
            })
            const data = await response.json()
            if (!response.ok || data.enabled !== enabled) {
                throw new Error(typeof data.error === "string" ? data.error : "The autonomous schedule could not be updated.")
            }
            setRuntimeSchedule({ ...runtimeSchedule, enabled })
            setNotice(enabled ? "Autonomous schedule resumed." : "Autonomous schedule paused. On-chain policy remains installed.")
        } catch (cause) {
            setRuntimeError(cause instanceof Error ? cause.message : "The autonomous schedule could not be updated.")
        } finally {
            setRuntimeBusy(false)
        }
    }

    async function revokeAgent() {
        if (!activeKernelClient || !activePublicClient || !currentSnapshot || !validatorAddress || !address) return
        setBusy(true)
        setError("")
        setNotice("")
        setLastUserOperation(null)
        try {
            const callData = encodeFunctionData({
                abi: AGENT_POLICY_HOOK_ABI,
                functionName: "revokeAccount",
                args: [currentSnapshot.account]
            })
            const hash = await activeKernelClient.sendUserOperation({
                calls: [{ to: validatorAddress, value: BigInt(0), data: callData }]
            })
            setLastUserOperation(hash)
            const receipt = await activeKernelClient.waitForUserOperationReceipt({ hash })
            if (!receipt.success) {
                throw new Error("Revoke UserOperation reverted.")
            }
            await refreshPolicy(
                getAddress(activeKernelClient.account.address),
                activeKernelClient.chain?.id ?? configuredChainId,
                getAddress(address),
                activePublicClient
            )
            setNotice("Agent policy revoked on-chain.")
        } catch (cause) {
            setError(getFriendlyError(cause))
        } finally {
            setBusy(false)
        }
    }

    const currentSnapshot = snapshotOwnerKey === walletKey ? snapshot : null
    const activeKernelClient = clientOwnerKey === walletKey ? kernelClient : null
    const activePublicClient = clientOwnerKey === walletKey ? publicClient : null
    const policyActive = Boolean(
        currentSnapshot?.configured
        && currentSnapshot.installed
        && !currentSnapshot.revoked
        && currentSnapshot.expiresAt > BigInt(nowSeconds)
    )
    const readyForExecution = Boolean(policyActive && currentSnapshot?.installed && !currentSnapshot.paused && runtimeSchedule?.enabled)
    return (
        <section className="mx-auto w-full max-w-6xl px-4 py-8">
            <div className="mb-5">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#d9a80a]">WOLV · BNB Chain</p>
                <h1 className="mt-1 text-2xl font-black tracking-tight text-white sm:text-3xl">Agent policy</h1>
                <p className="mt-1 text-sm text-slate-400">
                    Policy permissions are enforced by the BNB Chain smart account hook. Every setup or revocation step requires owner authorization.
                </p>
            </div>

            <div className="mb-5 rounded-xl border border-slate-800 bg-[#0e0e1c] p-4 sm:p-5">
                <div className="flex flex-wrap gap-x-6 gap-y-3">
                    <StatusIndicator
                        label={policyActive ? "Policy active" : "Policy inactive"}
                        active={policyActive}
                    />
                    <StatusIndicator
                        label={currentSnapshot?.installed ? "Hook installed" : "Hook not installed"}
                        active={Boolean(currentSnapshot?.installed)}
                    />
                    <StatusIndicator
                        label={runtimeSchedule?.enabled ? "Autonomous schedule enabled" : "No autonomous schedule"}
                        active={readyForExecution}
                    />
                </div>
                {currentSnapshot?.paused && <p className="mt-3 text-sm text-amber-300">The validator guardian has paused execution.</p>}
                {currentSnapshot?.revoked && (
                    <p className="mt-3 text-sm text-amber-300">
                        This account has been revoked on-chain. The current validator requires hook reinstallation before a new policy can be activated.
                    </p>
                )}
                {currentDerivedAccount && (
                    <p className="mt-3 break-all text-xs text-slate-500">
                        Smart account (chain {configuredChainId}): {currentDerivedAccount}
                    </p>
                )}
            </div>

            {!isConnected && <p className="mb-5 text-sm text-slate-400">Connect your owner wallet to load or configure its on-chain policy.</p>}
            {isConnected && !correctChain && (
                <p className="mb-5 text-sm text-amber-300">
                    Switch your wallet to {configuredNetworkName} to continue.
                </p>
            )}
            {!chainConfigured && <p className="mb-5 text-sm text-rose-300">NEXT_PUBLIC_CHAIN_ID or NEXT_PUBLIC_BSC_CHAIN_ID must be 56 (BSC mainnet) or 97 (BSC testnet).</p>}
            {isConnected && !validatorAddress && (
                <p className="mb-5 text-sm text-rose-300">Set NEXT_PUBLIC_VALIDATOR_ADDRESS to the deployed validator address.</p>
            )}
            {error && <p role="alert" className="mb-5 text-sm text-rose-300">{error}</p>}
            {notice && <p role="status" className="mb-5 text-sm text-emerald-300">{notice}</p>}
            {runtimeError && <p role="alert" className="mb-5 text-sm text-rose-300">{runtimeError}</p>}
            {lastUserOperation && (
                <p className="mb-5 break-all text-xs text-slate-400">Revocation UserOperation: {lastUserOperation}</p>
            )}

            {currentSnapshot?.configured && (
                <div className="mb-5 rounded-xl border border-slate-800 bg-[#0e0e1c] p-4 sm:p-5">
                    <h2 className="mb-4 text-lg font-bold text-white">Current policy</h2>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        <div><dt className="text-slate-500">Target Token</dt><dd className="break-all text-slate-200">{currentSnapshot.targetToken}</dd></div>
                        <div><dt className="text-slate-500">Maximum Trade Value</dt><dd className="text-slate-200">{formatEther(currentSnapshot.maxTradeValue)} BNB</dd></div>
                        <div><dt className="text-slate-500">Expiration</dt><dd className="text-slate-200">{formatExpiration(currentSnapshot.expiresAt)}</dd></div>
                        <div><dt className="text-slate-500">Intent Signer</dt><dd className="break-all text-slate-200">{currentSnapshot.intentSigner}</dd></div>
                    </dl>
                    {currentSnapshot.installed && (
                        <div className="mt-5 border-t border-slate-800 pt-4">
                            <button
                                className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-300 transition hover:border-rose-400/50 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                                type="button"
                                disabled={!walletReady || !activeKernelClient || busy || currentSnapshot.revoked}
                                onClick={() => void revokeAgent()}
                            >
                                {busy ? "Revoking..." : currentSnapshot.revoked ? "Agent Revoked" : "Emergency Revoke"}
                            </button>
                            <p className="mt-2 text-xs text-slate-500">Immediately disables agent execution for this smart account.</p>
                        </div>
                    )}
                </div>
            )}

            {policyActive && currentSnapshot && !currentSnapshot.revoked && (
                <div className="mb-5 rounded-xl border border-slate-800 bg-[#0e0e1c] p-4 sm:p-5">
                    <h2 className="text-lg font-bold text-white">Autonomous execution</h2>
                    {runtimeSchedule?.enabled ? (
                        <>
                            <p className="mt-2 text-sm text-emerald-300">Strategy {runtimeSchedule.name} is saved for unattended evaluation every 60 seconds. Trades execute automatically when the worker process is running, execution gates are enabled, and on-chain policy and market checks pass.</p>
                            <p className="mt-1 break-all text-xs text-slate-500">Schedule ID: {runtimeSchedule.scheduleId}</p>
                            {runtimeWorkerReadiness && (!runtimeWorkerReadiness.workerReady || !runtimeWorkerReadiness.executionGateEnabled) && (
                                <p className="mt-2 text-xs text-amber-300">
                                    {runtimeWorkerReadiness.workerConfigIssues.length > 0 ? "Missing worker configuration: " + runtimeWorkerReadiness.workerConfigIssues.join(", ") + ". " : ""}
                                    {runtimeWorkerReadiness.executionGateReason ? "Execution gate: " + runtimeWorkerReadiness.executionGateReason : ""}
                                </p>
                            )}
                            <button type="button" disabled={runtimeBusy} onClick={() => void setAutonomousScheduleEnabled(false)} className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-bold text-amber-200 disabled:opacity-50">{runtimeBusy ? "Updating..." : "Pause autonomous worker"}</button>
                        </>
                    ) : runtimeSchedule && !runtimeSchedule.enabled ? (
                        <>
                            <p className="mt-2 text-sm text-amber-300">The autonomous schedule is paused. The on-chain policy remains installed but the worker will not claim this schedule.</p>
                            <button type="button" disabled={runtimeBusy} onClick={() => void setAutonomousScheduleEnabled(true)} className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-bold text-emerald-200 disabled:opacity-50">{runtimeBusy ? "Updating..." : "Resume autonomous worker"}</button>
                        </>
                    ) : pendingStrategy ? (
                        <>
                            <p className="mt-2 text-sm text-slate-300">The on-chain policy is configured for {pendingStrategy.strategyId}. Authorize one browser-wallet session and save the strategy; individual trades will not require wallet approval.</p>
                            <button type="button" disabled={runtimeBusy} onClick={() => void enableAutonomousSchedule()} className="mt-4 rounded-xl bg-[#d9a80a] px-4 py-2.5 text-sm font-bold text-black disabled:opacity-50">{runtimeBusy ? "Enabling..." : "Enable autonomous execution"}</button>
                        </>
                    ) : !runtimeSessionAuthenticated ? (
                        <>
                            <p className="mt-2 text-sm text-slate-300">Authorize the owner wallet once to view or register a persistent strategy schedule. This is not a per-trade approval.</p>
                            <button type="button" disabled={runtimeBusy || !walletReady} onClick={async () => { setRuntimeBusy(true); const ok = await authenticateRuntimeSession(); if (ok) await refreshRuntimeSchedule(); setRuntimeBusy(false); }} className="mt-4 rounded-xl border border-slate-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">{runtimeBusy ? "Authorizing..." : "Authorize autonomous worker"}</button>
                        </>
                    ) : (
                        <p className="mt-2 text-sm text-slate-400">No autonomous strategy is registered for this smart account. Configure a strategy below to save one.</p>
                    )}
                    <p className="mt-3 text-xs text-slate-500">The server worker must be deployed and running. Execution remains disabled until the master autonomous-trading and live-submission gates are enabled; mainnet has additional authorization gates.</p>
                </div>
            )}

            {walletReady && currentSnapshot && !currentSnapshot.revoked &&
                (!policyActive || (runtimeScheduleLoaded && runtimeSessionAuthenticated && !runtimeSchedule?.enabled)) &&
                !pendingStrategy && validatorAddress && (
                <AgentSetupForm
                    ownerKernelClient={activeKernelClient}
                    publicClient={activePublicClient}
                    validatorAddress={validatorAddress}
                    installedTargetToken={currentSnapshot.installed ? currentSnapshot.targetToken : undefined}
                    canSubmit={Boolean(activeKernelClient && activePublicClient && !busy)}
                    disabledReason={activeKernelClient
                        ? undefined
                        : bundlerConfigured
                            ? "Preparing the Kernel smart account..."
                            : `Configure ${bundlerVariable} before submitting agent policy transactions.`}
                    onConfigured={async (strategy) => {
                        setPendingStrategy(strategy)
                        setNotice("On-chain policy verified. Enable autonomous execution to persist this strategy.")
                        if (activeKernelClient && address) {
                            if (activePublicClient) {
                                await refreshPolicy(
                                    getAddress(activeKernelClient.account.address),
                                    activeKernelClient.chain?.id ?? configuredChainId,
                                    getAddress(address),
                                    activePublicClient
                                )
                            }
                        }
                    }}
                />
            )}
        </section>
    )
}
