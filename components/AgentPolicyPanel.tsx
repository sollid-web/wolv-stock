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
import { useAccount, useWalletClient } from "wagmi"
import AgentSetupForm from "@/components/AgentSetupForm"
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

    const refreshPolicy = useCallback(async (
        account: Address,
        currentChainId: number,
        currentOwnerAddress: Address,
        currentPublicClient = getAgentPublicClient()
    ) => {
        if (!validatorAddress) {
            throw new Error("Configure NEXT_PUBLIC_VALIDATOR_ADDRESS with the deployed validator address.")
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

    const walletKey = address ? `${chainId}:${address.toLowerCase()}` : ""
    const currentSnapshot = snapshotOwnerKey === walletKey ? snapshot : null
    const currentDerivedAccount = derivedAccount?.ownerKey === walletKey ? derivedAccount.address : null
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
                        label={readyForExecution ? "Ready for execution" : "Execution unavailable"}
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
            {!chainConfigured && <p className="mb-5 text-sm text-rose-300">NEXT_PUBLIC_BSC_CHAIN_ID must be 56 (BSC mainnet) or 97 (BSC testnet).</p>}
            {isConnected && !validatorAddress && (
                <p className="mb-5 text-sm text-rose-300">Set NEXT_PUBLIC_VALIDATOR_ADDRESS to the deployed validator address.</p>
            )}
            {error && <p role="alert" className="mb-5 text-sm text-rose-300">{error}</p>}
            {notice && <p role="status" className="mb-5 text-sm text-emerald-300">{notice}</p>}
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

            {walletReady && currentSnapshot && !policyActive && !currentSnapshot.revoked && validatorAddress && (
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
                    onConfigured={async () => {
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
