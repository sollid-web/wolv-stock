"use client"

import { useState, type FormEvent } from "react"
import {
    getAddress,
    isAddress,
    parseEther,
    parseUnits,
    type Address,
    type Hex,
    type PublicClient
} from "viem"
import { hashAgentPolicy } from "@/lib/agentPolicyHash"
import { configureAgentPolicy } from "@/lib/setupAgentPolicy"
import type { AgentKernelClient } from "@/lib/kernelClient"

export type AgentConfiguredStrategy = {
    strategyId: string
    ownerAddress: Address
    account: Address
    targetToken: Address
    amountBnb: string
    entryPriceMicros: string
    slippageBps: number
    maxPriceImpactBps: number
    maxTradeValueWei: string
    expiresAt: string
    intentSigner: Address
    policyHash: Hex
}

type AgentSetupFormProps = {
    ownerKernelClient: AgentKernelClient | null
    ownerAddress: Address
    publicClient: PublicClient | null
    validatorAddress: Address
    installedTargetToken?: Address
    canSubmit: boolean
    disabledReason?: string
    onConfigured: (strategy: AgentConfiguredStrategy) => Promise<void>
}

const DAY_SECONDS = 24 * 60 * 60
const MAX_TRADE_VALUE = parseEther("0.5")
const inputClass = "w-full rounded-xl border border-white/[0.1] bg-white/[0.04] px-3 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-[#d9a80a]/60 focus:bg-white/[0.06]"

class AgentPolicyValidationError extends Error {}

function minimumExpirationDate(): string {
    return new Date(Date.now() + DAY_SECONDS * 1000).toISOString().slice(0, 10)
}

function getFriendlySetupError(error: unknown): string {
    const message = error instanceof Error ? error.message : ""
    const lowerMessage = message.toLowerCase()
    if (/user rejected|user denied|rejected the request|code.?4001/.test(lowerMessage)) {
        return "Wallet approval was declined. No policy change was completed."
    }
    if (error instanceof AgentPolicyValidationError) {
        return error.message
    }
    if (/insufficient funds|aa21|didn't pay prefund|did not pay prefund/.test(lowerMessage)) {
        return "The smart account needs enough testnet BNB to cover UserOperation gas. Fund the smart account and try again."
    }

    const shortMessage = error instanceof Error
        && "shortMessage" in error
        && typeof error.shortMessage === "string"
        ? error.shortMessage
        : ""
    const detail = shortMessage || message
    if (detail) {
        const safeDetail = detail
            .replace(/https?:\/\/[^\s"'<>]+/gi, "[RPC endpoint]")
            .replace(/[\r\n\t]+/g, " ")
            .slice(0, 300)
        return `Agent policy setup failed: ${safeDetail}`
    }
    return "Agent policy setup failed with an unknown wallet or provider error. Check the wallet request and browser console."
}

export default function AgentSetupForm({
    ownerKernelClient,
    ownerAddress,
    publicClient,
    validatorAddress,
    installedTargetToken,
    canSubmit,
    disabledReason,
    onConfigured
}: AgentSetupFormProps) {
    const [targetToken, setTargetToken] = useState(installedTargetToken ?? "")
    const [strategyId, setStrategyId] = useState("")
    const [strategyAmountBnb, setStrategyAmountBnb] = useState("")
    const [entryPriceUsd, setEntryPriceUsd] = useState("")
    const [slippageBps, setSlippageBps] = useState("100")
    const [maxPriceImpactBps, setMaxPriceImpactBps] = useState("300")
    const [maxTradeValue, setMaxTradeValue] = useState("")
    const [intentSigner, setIntentSigner] = useState(process.env.NEXT_PUBLIC_AGENT_SIGNER_ADDRESS ?? "")
    const [expirationDate, setExpirationDate] = useState("")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [success, setSuccess] = useState("")
    const [policyHash, setPolicyHash] = useState<Hex | null>(null)
    const [userOperationHashes, setUserOperationHashes] = useState<Array<{ step: string; hash: Hex }>>([])
    const [minimumDate] = useState(() => minimumExpirationDate())
    const targetTokenLocked = Boolean(installedTargetToken)

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        setBusy(true)
        setError("")
        setSuccess("")
        setPolicyHash(null)
        setUserOperationHashes([])
        try {
            if (!canSubmit || !ownerKernelClient || !publicClient) {
                throw new Error("The connected wallet is not ready for agent policy setup.")
            }
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(strategyId)) {
                throw new AgentPolicyValidationError("Enter the exact strategy ID configured in AGENT_STRATEGIES_JSON (1-64 letters, numbers, dots, underscores, or hyphens).")
            }
            if (!isAddress(targetToken)) {
                throw new AgentPolicyValidationError("Enter a valid target token address.")
            }
            if (!isAddress(intentSigner)) {
                throw new AgentPolicyValidationError("Enter a valid intent signer address.")
            }
            const normalizedTarget = getAddress(targetToken)
            const normalizedSigner = getAddress(intentSigner)
            let maxTradeValueWei: bigint
            try {
                maxTradeValueWei = parseEther(maxTradeValue)
            } catch {
                throw new AgentPolicyValidationError("Enter a trade value with no more than 18 decimal places.")
            }
            if (maxTradeValueWei <= BigInt(0) || maxTradeValueWei > MAX_TRADE_VALUE) {
                throw new AgentPolicyValidationError("Maximum trade value must be greater than zero and no more than 0.5 BNB.")
            }
            let strategyAmountWei: bigint
            let entryPriceMicros: bigint
            try {
                strategyAmountWei = parseEther(strategyAmountBnb)
            } catch {
                throw new AgentPolicyValidationError("Enter a valid strategy trade amount in BNB.")
            }
            try {
                entryPriceMicros = parseUnits(entryPriceUsd, 6)
            } catch {
                throw new AgentPolicyValidationError("Enter a valid entry-price threshold in USD (up to 6 decimal places).")
            }
            const strategySlippageBps = Number(slippageBps)
            const strategyMaxPriceImpactBps = Number(maxPriceImpactBps)
            if (strategyAmountWei <= BigInt(0) || strategyAmountWei > maxTradeValueWei) {
                throw new AgentPolicyValidationError("Strategy trade amount must be positive and no greater than the maximum trade value.")
            }
            if (entryPriceMicros <= BigInt(0)) {
                throw new AgentPolicyValidationError("Entry-price threshold must be greater than zero.")
            }
            if (!Number.isSafeInteger(strategySlippageBps) || strategySlippageBps < 1 || strategySlippageBps > 500) {
                throw new AgentPolicyValidationError("Maximum slippage must be between 1 and 500 basis points.")
            }
            if (!Number.isSafeInteger(strategyMaxPriceImpactBps) || strategyMaxPriceImpactBps < 1 || strategyMaxPriceImpactBps > 300) {
                throw new AgentPolicyValidationError("Maximum price impact must be between 1 and 300 basis points.")
            }
            if (!expirationDate) {
                throw new AgentPolicyValidationError("Choose a policy expiration date.")
            }
            const [year, month, day] = expirationDate.split("-").map(Number)
            const expirySeconds = BigInt(Math.floor(Date.UTC(year, month - 1, day, 23, 59, 59) / 1000))
            if (expirySeconds < BigInt(Math.floor(Date.now() / 1000) + DAY_SECONDS)) {
                throw new AgentPolicyValidationError("Policy expiration must be at least 24 hours from now.")
            }

            const requestedPolicyHash = hashAgentPolicy({
                strategyId,
                ownerAddress: getAddress(ownerAddress),
                account: getAddress(ownerKernelClient.account.address),
                targetToken: normalizedTarget,
                maxTradeValue: maxTradeValueWei,
                expiresAt: expirySeconds,
                intentSigner: normalizedSigner,
                amountBnb: strategyAmountWei,
                entryPriceMicros,
                slippageBps: strategySlippageBps,
                maxPriceImpactBps: strategyMaxPriceImpactBps
            })
            const result = await configureAgentPolicy({
                ownerKernelClient,
                publicClient,
                validatorAddress,
                ownerAddress: getAddress(ownerAddress),
                strategyId,
                targetToken: normalizedTarget,
                intentSigner: normalizedSigner,
                maxTradeValue: maxTradeValueWei,
                expiresAt: expirySeconds,
                amountBnb: strategyAmountWei,
                entryPriceMicros,
                slippageBps: strategySlippageBps,
                maxPriceImpactBps: strategyMaxPriceImpactBps,
                onUserOperationSubmitted: (step, hash) => {
                    setUserOperationHashes((current) => [...current, { step, hash }])
                }
            })
            if (result.policyHash !== requestedPolicyHash) {
                throw new Error("The policy hash did not match the requested configuration.")
            }
            setPolicyHash(result.policyHash)
            setSuccess("Policy configured and verified on-chain.")
            await onConfigured({
                strategyId,
                ownerAddress: getAddress(ownerAddress),
                account: getAddress(ownerKernelClient.account.address),
                targetToken: normalizedTarget,
                amountBnb: strategyAmountBnb,
                entryPriceMicros: entryPriceMicros.toString(),
                slippageBps: strategySlippageBps,
                maxPriceImpactBps: strategyMaxPriceImpactBps,
                maxTradeValueWei: maxTradeValueWei.toString(),
                expiresAt: expirySeconds.toString(),
                intentSigner: normalizedSigner,
                policyHash: requestedPolicyHash
            })
        } catch (cause) {
            setError(getFriendlySetupError(cause))
        } finally {
            setBusy(false)
        }
    }

    return (
        <form className="space-y-4 rounded-xl border border-slate-800 bg-[#0e0e1c] p-4 sm:p-5" onSubmit={submit}>
            <div>
                <h3 className="text-lg font-bold text-white">Configure agent policy</h3>
                <p className="mt-1 text-sm text-slate-400">
                    The connected owner wallet authorizes hook installation and policy configuration as separate Kernel UserOperations.
                </p>
            </div>

            <label className="block space-y-1.5 text-sm text-slate-300">
                <span>Authorized Strategy ID</span>
                <input
                    className={inputClass}
                    value={strategyId}
                    onChange={(event) => setStrategyId(event.target.value)}
                    placeholder="e.g. aapl-entry"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={64}
                    required
                />
                <span className="block text-xs text-slate-500">Must exactly match the strategy ID in the autonomous worker configuration. Unregistered labels will fail the on-chain policy hash check.</span>
            </label>

            <label className="block space-y-1.5 text-sm text-slate-300">
                <span>Strategy Trade Amount (BNB)</span>
                <input className={inputClass} type="number" inputMode="decimal" min="0" max="0.5" step="any" value={strategyAmountBnb} onChange={(event) => setStrategyAmountBnb(event.target.value)} placeholder="0.1" required />
            </label>

            <label className="block space-y-1.5 text-sm text-slate-300">
                <span>Entry Price Threshold (USD)</span>
                <input className={inputClass} type="number" inputMode="decimal" min="0" step="0.000001" value={entryPriceUsd} onChange={(event) => setEntryPriceUsd(event.target.value)} placeholder="e.g. 100.00" required />
                <span className="block text-xs text-slate-500">The worker&apos;s price trigger is included in the policy hash. Enter the same threshold used by the strategy.</span>
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5 text-sm text-slate-300">
                    <span>Maximum Slippage (BPS)</span>
                    <input className={inputClass} type="number" min="1" max="500" step="1" value={slippageBps} onChange={(event) => setSlippageBps(event.target.value)} required />
                </label>
                <label className="block space-y-1.5 text-sm text-slate-300">
                    <span>Maximum Price Impact (BPS)</span>
                    <input className={inputClass} type="number" min="1" max="300" step="1" value={maxPriceImpactBps} onChange={(event) => setMaxPriceImpactBps(event.target.value)} required />
                </label>
            </div>

            <label className="block space-y-1.5 text-sm text-slate-300">
                <span>Target Token Address</span>
                <input
                    className={inputClass}
                    value={targetToken}
                    onChange={(event) => setTargetToken(event.target.value)}
                    placeholder="0x..."
                    autoComplete="off"
                    spellCheck={false}
                    required
                    readOnly={targetTokenLocked}
                />
            </label>

            <label className="block space-y-1.5 text-sm text-slate-300">
                <span>Maximum Trade Value (BNB)</span>
                <input
                    className={inputClass}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="0.5"
                    step="any"
                    value={maxTradeValue}
                    onChange={(event) => setMaxTradeValue(event.target.value)}
                    placeholder="0.5"
                    required
                />
            </label>

            <label className="block space-y-1.5 text-sm text-slate-300">
                <span>Intent Signer Address</span>
                <input
                    className={inputClass}
                    value={intentSigner}
                    onChange={(event) => setIntentSigner(event.target.value)}
                    placeholder="0x..."
                    autoComplete="off"
                    spellCheck={false}
                    required
                />
            </label>

            <label className="block space-y-1.5 text-sm text-slate-300">
                <span>Policy Expiration</span>
                <input
                    className={inputClass}
                    type="date"
                    min={minimumDate}
                    value={expirationDate}
                    onChange={(event) => setExpirationDate(event.target.value)}
                    required
                />
                <span className="block text-xs text-slate-500">Expiration is set to the end of the selected UTC date.</span>
            </label>

            {!canSubmit && disabledReason && (
                <p className="text-sm text-amber-300">{disabledReason}</p>
            )}
            {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
            {success && <p role="status" className="text-sm text-emerald-300">{success}</p>}

            {userOperationHashes.map(({ step, hash }) => (
                <p key={`${step}-${hash}`} className="break-all text-xs text-slate-400">
                    {step === "install" ? "Hook installation" : "Policy configuration"} UserOperation: {hash}
                </p>
            ))}
            {policyHash && <p className="break-all text-xs text-slate-400">Policy hash: {policyHash}</p>}

            <button
                className="rounded-xl bg-[#d9a80a] px-4 py-3 text-sm font-black text-[#101010] transition hover:bg-[#f2c94c] disabled:cursor-not-allowed disabled:opacity-50"
                type="submit"
                disabled={!canSubmit || busy}
            >
                {busy ? "Configuring policy..." : "Configure Agent"}
            </button>
            {installedTargetToken && targetTokenLocked && (
                <p className="text-xs text-slate-500">
                    This hook is already installed for {getAddress(installedTargetToken)}; its target token cannot be changed here.
                </p>
            )}
        </form>
    )
}
