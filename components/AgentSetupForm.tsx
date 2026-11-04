"use client"

import { useState, type FormEvent } from "react"
import {
    getAddress,
    isAddress,
    parseEther,
    type Address,
    type Hex,
    type PublicClient
} from "viem"
import { hashAgentPolicy } from "@/lib/agentPolicyHash"
import { configureAgentPolicy } from "@/lib/setupAgentPolicy"
import type { AgentKernelClient } from "@/lib/kernelClient"

type AgentSetupFormProps = {
    ownerKernelClient: AgentKernelClient | null
    publicClient: PublicClient | null
    validatorAddress: Address
    installedTargetToken?: Address
    canSubmit: boolean
    disabledReason?: string
    onConfigured: () => Promise<void>
}

const DAY_SECONDS = 24 * 60 * 60
const MAX_TRADE_VALUE = parseEther("0.5")
const inputClass = "wolv-glass-control w-full rounded-xl px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-[#FFC700]/60"

class AgentPolicyValidationError extends Error {}

function minimumExpirationDate(): string {
    return new Date(Date.now() + DAY_SECONDS * 1000).toISOString().slice(0, 10)
}

function getFriendlySetupError(error: unknown): string {
    const message = error instanceof Error ? error.message.toLowerCase() : ""
    if (/user rejected|user denied|rejected the request|code.?4001/.test(message)) {
        return "Wallet approval was declined. No policy change was completed."
    }
    if (/chain|network|entrypoint|validator|bundler|rpc/.test(message)) {
        return "The wallet or agent policy service is not configured for this BNB Chain network."
    }
    if (/hook installation|policy configuration|readback|initialized/.test(message)) {
        return "The on-chain policy step could not be verified. Check the transaction status before trying again."
    }
    if (error instanceof AgentPolicyValidationError) {
        return error.message
    }
    return "Agent policy setup failed. Check your wallet and network, then try again."
}

export default function AgentSetupForm({
    ownerKernelClient,
    publicClient,
    validatorAddress,
    installedTargetToken,
    canSubmit,
    disabledReason,
    onConfigured
}: AgentSetupFormProps) {
    const [targetToken, setTargetToken] = useState(installedTargetToken ?? "")
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
            if (!expirationDate) {
                throw new AgentPolicyValidationError("Choose a policy expiration date.")
            }
            const [year, month, day] = expirationDate.split("-").map(Number)
            const expirySeconds = BigInt(Math.floor(Date.UTC(year, month - 1, day, 23, 59, 59) / 1000))
            if (expirySeconds < BigInt(Math.floor(Date.now() / 1000) + DAY_SECONDS)) {
                throw new AgentPolicyValidationError("Policy expiration must be at least 24 hours from now.")
            }

            const requestedPolicyHash = hashAgentPolicy({
                targetToken: normalizedTarget,
                maxTradeValue: maxTradeValueWei,
                expiresAt: expirySeconds,
                intentSigner: normalizedSigner
            })
            const result = await configureAgentPolicy({
                ownerKernelClient,
                publicClient,
                validatorAddress,
                targetToken: normalizedTarget,
                intentSigner: normalizedSigner,
                maxTradeValue: maxTradeValueWei,
                expiresAt: expirySeconds,
                onUserOperationSubmitted: (step, hash) => {
                    setUserOperationHashes((current) => [...current, { step, hash }])
                }
            })
            if (result.policyHash !== requestedPolicyHash) {
                throw new Error("The policy hash did not match the requested configuration.")
            }
            setPolicyHash(result.policyHash)
            setSuccess("Policy configured and verified on-chain.")
            await onConfigured()
        } catch (cause) {
            setError(getFriendlySetupError(cause))
        } finally {
            setBusy(false)
        }
    }

    return (
        <form className="wolv-glass rounded-2xl p-5 space-y-4" onSubmit={submit}>
            <div>
                <h3 className="text-lg font-semibold text-slate-100">Configure Agent Policy</h3>
                <p className="mt-1 text-sm text-slate-400">
                    The connected owner wallet authorizes hook installation and policy configuration as separate Kernel UserOperations.
                </p>
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
                className="rounded-xl bg-[#FFC700] px-4 py-2.5 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
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
