"use client"

import { useCallback, useEffect, useState } from "react"
import {
    encodeFunctionData,
    formatEther,
    getAddress,
    isAddress,
    type Address,
    type Hex
} from "viem"
import { useAccount, useWalletClient } from "wagmi"
import AgentSetupForm from "@/components/AgentSetupForm"
import {
    AGENT_POLICY_HOOK_ABI
} from "@/lib/setupAgentPolicy"
import {
    getAgentPublicClient,
    getKernelClient,
    type AgentKernelClient
} from "@/lib/kernelClient"

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

const configuredChainId = Number(process.env.NEXT_PUBLIC_BSC_CHAIN_ID ?? "56")
const validatorEnv = process.env.NEXT_PUBLIC_VALIDATOR_ADDRESS
    || process.env.NEXT_PUBLIC_POLICY_HOOK_ADDRESS
const validatorAddress = validatorEnv && isAddress(validatorEnv)
    ? getAddress(validatorEnv)
    : null

function formatExpiration(timestamp: bigint): string {
    return new Date(Number(timestamp) * 1000).toLocaleString()
}

function statusClass(active: boolean): string {
    return active ? "text-emerald-300" : "text-slate-400"
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
    const { address, chainId, isConnected } = useAccount()
    const { data: walletClient } = useWalletClient()
    const [kernelClient, setKernelClient] = useState<AgentKernelClient | null>(null)
    const [publicClient, setPublicClient] = useState<ReturnType<typeof getAgentPublicClient> | null>(null)
    const [clientOwnerKey, setClientOwnerKey] = useState("")
    const [snapshot, setSnapshot] = useState<PolicySnapshot | null>(null)
    const [snapshotOwnerKey, setSnapshotOwnerKey] = useState("")
    const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000))
    const [error, setError] = useState("")
    const [notice, setNotice] = useState("")
    const [busy, setBusy] = useState(false)
    const [lastUserOperation, setLastUserOperation] = useState<Hex | null>(null)

    const chainConfigured = configuredChainId === 56
    const correctChain = isConnected && chainId === configuredChainId
    const walletReady = Boolean(address && walletClient && correctChain)

    const refreshPolicy = useCallback(async (
        currentKernelClient: AgentKernelClient,
        currentOwnerAddress: Address,
        currentPublicClient = getAgentPublicClient()
    ) => {
        if (!validatorAddress) {
            throw new Error("Configure NEXT_PUBLIC_VALIDATOR_ADDRESS with the deployed validator address.")
        }
        const account = getAddress(currentKernelClient.account.address)
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
            chainId: currentKernelClient.chain?.id ?? 0,
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
        setSnapshotOwnerKey(`${currentKernelClient.chain?.id}:${currentOwnerAddress.toLowerCase()}`)
    }, [])

    useEffect(() => {
        let cancelled = false
        let refreshTimer: ReturnType<typeof setInterval> | undefined
        if (!walletReady || !walletClient) return
        if (!validatorAddress || !address) return

        void (async () => {
            try {
                const nextPublicClient = getAgentPublicClient()
                const nextKernelClient = await getKernelClient(walletClient)
                if (cancelled) return
                const ownerAddress = getAddress(address)
                setKernelClient(nextKernelClient)
                setPublicClient(nextPublicClient)
                setClientOwnerKey(`${nextKernelClient.chain?.id}:${ownerAddress.toLowerCase()}`)
                await refreshPolicy(nextKernelClient, ownerAddress, nextPublicClient)
                setError("")
                if (cancelled) return
                refreshTimer = setInterval(() => {
                    setNowSeconds(Math.floor(Date.now() / 1000))
                    void refreshPolicy(nextKernelClient, ownerAddress, nextPublicClient).catch((cause: unknown) => {
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
    }, [address, chainId, walletClient, walletReady, refreshPolicy])

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
            await refreshPolicy(activeKernelClient, getAddress(address), activePublicClient)
            setNotice("Agent policy revoked on-chain.")
        } catch (cause) {
            setError(getFriendlyError(cause))
        } finally {
            setBusy(false)
        }
    }

    const walletKey = address ? `${chainId}:${address.toLowerCase()}` : ""
    const currentSnapshot = snapshotOwnerKey === walletKey ? snapshot : null
    const activeKernelClient = clientOwnerKey === walletKey ? kernelClient : null
    const activePublicClient = clientOwnerKey === walletKey ? publicClient : null
    const policyActive = Boolean(
        currentSnapshot?.configured
        && currentSnapshot.installed
        && !currentSnapshot.revoked
        && currentSnapshot.expiresAt > BigInt(nowSeconds)
    )
    const readyForExecution = Boolean(policyActive && currentSnapshot?.installed && !currentSnapshot.paused)
    return (
        <section className="mx-auto w-full max-w-6xl px-4 py-8">
            <div className="mb-5">
                <h1 className="text-2xl font-semibold text-slate-100">On-chain Agent Policy</h1>
                <p className="mt-1 text-sm text-slate-400">
                    Policy permissions are enforced by the BNB Chain smart account hook. Every setup or revocation step requires owner authorization.
                </p>
            </div>

            <div className="wolv-glass mb-5 rounded-2xl p-5">
                <div className="grid gap-3 sm:grid-cols-3">
                    <p className={statusClass(policyActive)}>Policy Active: {policyActive ? "Yes" : "No"}</p>
                    <p className={statusClass(Boolean(currentSnapshot?.installed))}>Hook Installed: {currentSnapshot ? (currentSnapshot.installed ? "Yes" : "No") : "Checking"}</p>
                    <p className={statusClass(readyForExecution)}>Ready for Execution: {readyForExecution ? "Yes" : "No"}</p>
                </div>
                {currentSnapshot?.paused && <p className="mt-3 text-sm text-amber-300">The validator guardian has paused execution.</p>}
                {currentSnapshot?.revoked && (
                    <p className="mt-3 text-sm text-amber-300">
                        This account has been revoked on-chain. The current validator requires hook reinstallation before a new policy can be activated.
                    </p>
                )}
                {currentSnapshot && <p className="mt-3 break-all text-xs text-slate-500">Smart account: {currentSnapshot.account}</p>}
            </div>

            {!isConnected && <p className="mb-5 text-sm text-slate-400">Connect your owner wallet to load or configure its on-chain policy.</p>}
            {isConnected && !correctChain && (
                <p className="mb-5 text-sm text-amber-300">
                    Switch your wallet to {configuredChainId === 97 ? "BNB Smart Chain Testnet" : "BNB Smart Chain"} to continue.
                </p>
            )}
            {!chainConfigured && <p className="mb-5 text-sm text-rose-300">NEXT_PUBLIC_BSC_CHAIN_ID must be 56 (BSC mainnet).</p>}
            {isConnected && !validatorAddress && (
                <p className="mb-5 text-sm text-rose-300">Set NEXT_PUBLIC_VALIDATOR_ADDRESS to the deployed validator address.</p>
            )}
            {error && <p role="alert" className="mb-5 text-sm text-rose-300">{error}</p>}
            {notice && <p role="status" className="mb-5 text-sm text-emerald-300">{notice}</p>}
            {lastUserOperation && (
                <p className="mb-5 break-all text-xs text-slate-400">Revocation UserOperation: {lastUserOperation}</p>
            )}

            {currentSnapshot?.configured && (
                <div className="wolv-glass mb-5 rounded-2xl p-5">
                    <h2 className="mb-3 text-lg font-semibold text-slate-100">Current Policy</h2>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        <div><dt className="text-slate-500">Target Token</dt><dd className="break-all text-slate-200">{currentSnapshot.targetToken}</dd></div>
                        <div><dt className="text-slate-500">Maximum Trade Value</dt><dd className="text-slate-200">{formatEther(currentSnapshot.maxTradeValue)} BNB</dd></div>
                        <div><dt className="text-slate-500">Expiration</dt><dd className="text-slate-200">{formatExpiration(currentSnapshot.expiresAt)}</dd></div>
                        <div><dt className="text-slate-500">Intent Signer</dt><dd className="break-all text-slate-200">{currentSnapshot.intentSigner}</dd></div>
                    </dl>
                </div>
            )}

            {currentSnapshot?.installed && (
                <div className="mb-5">
                    <button
                        className="rounded-xl border border-rose-400/40 px-4 py-2.5 text-sm font-semibold text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
                        type="button"
                        disabled={!walletReady || !activeKernelClient || busy || currentSnapshot.revoked}
                        onClick={() => void revokeAgent()}
                    >
                        {busy ? "Revoking..." : currentSnapshot.revoked ? "Agent Revoked" : "Revoke Agent"}
                    </button>
                </div>
            )}

            {walletReady && currentSnapshot && !policyActive && !currentSnapshot.revoked && validatorAddress && (
                <AgentSetupForm
                    ownerKernelClient={activeKernelClient}
                    publicClient={activePublicClient}
                    validatorAddress={validatorAddress}
                    installedTargetToken={currentSnapshot.installed ? currentSnapshot.targetToken : undefined}
                    canSubmit={Boolean(activeKernelClient && activePublicClient && !busy)}
                    disabledReason={activeKernelClient ? undefined : "Preparing the Kernel smart account..."}
                    onConfigured={async () => {
                        if (activeKernelClient && address) {
                            if (activePublicClient) {
                                await refreshPolicy(activeKernelClient, getAddress(address), activePublicClient)
                            }
                        }
                    }}
                />
            )}
        </section>
    )
}
