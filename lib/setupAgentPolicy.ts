import type { KernelAccountClient } from "@zerodev/sdk"
import {
    concatHex,
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    type Address,
    type Chain,
    type Hex,
    type PublicClient,
    type Transport
} from "viem"
import type { SmartAccount } from "viem/account-abstraction"
import { hashAgentPolicy } from "./agentPolicyHash.ts"

const HOOK_MODULE_TYPE = BigInt(4)
const MAX_TRADE_VALUE = BigInt("500000000000000000")

export const AGENT_POLICY_HOOK_ABI = [
    {
        type: "function",
        name: "paused",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "bool" }]
    },
    {
        type: "function",
        name: "isInitialized",
        stateMutability: "view",
        inputs: [{ name: "smartAccount", type: "address" }],
        outputs: [{ type: "bool" }]
    },
    {
        type: "function",
        name: "isRevoked",
        stateMutability: "view",
        inputs: [{ name: "smartAccount", type: "address" }],
        outputs: [{ type: "bool" }]
    },
    {
        type: "function",
        name: "getTargetToken",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "address" }]
    },
    {
        type: "function",
        name: "getAccountPolicy",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [
            { name: "configured", type: "bool" },
            { name: "policyHash", type: "bytes32" },
            { name: "maxTradeValue", type: "uint192" },
            { name: "expiresAt", type: "uint64" },
            { name: "intentSigner", type: "address" }
        ]
    },
    {
        type: "function",
        name: "getAccountRiskPolicy",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "uint64" }, { type: "uint16" }, { type: "uint16" }]
    },
    {
        type: "function",
        name: "revokeAccount",
        stateMutability: "nonpayable",
        inputs: [{ name: "smartAccount", type: "address" }],
        outputs: []
    },
    {
        type: "function",
        name: "setAccountPolicy",
        stateMutability: "nonpayable",
        inputs: [
            { name: "smartAccount", type: "address" },
            { name: "intentSigner", type: "address" },
            { name: "policyHash", type: "bytes32" },
            { name: "maxTradeValue", type: "uint192" },
            { name: "expiresAt", type: "uint64" },
            { name: "entryPriceMicros", type: "uint64" },
            { name: "maxSlippageBps", type: "uint16" },
            { name: "maxPriceImpactBps", type: "uint16" }
        ],
        outputs: []
    }
] as const

const kernelModuleInstallAbi = [{
    type: "function",
    name: "installModule",
    stateMutability: "payable",
    inputs: [
        { name: "moduleType", type: "uint256" },
        { name: "module", type: "address" },
        { name: "initData", type: "bytes" }
    ],
    outputs: []
}] as const

type PolicyKernelAccount = SmartAccount
type PolicyKernelClient = KernelAccountClient<Transport, Chain, PolicyKernelAccount>

export type ConfigureAgentPolicyInput = {
    ownerKernelClient: PolicyKernelClient
    publicClient: PublicClient
    validatorAddress: Address
    ownerAddress: Address
    strategyId: string
    targetToken: Address
    intentSigner: Address
    maxTradeValue: bigint
    expiresAt: bigint
    amountBnb: bigint
    entryPriceMicros: bigint
    slippageBps: number
    maxPriceImpactBps: number
    onUserOperationSubmitted?: (step: "install" | "policy", hash: Hex) => void
}

export type ConfigureAgentPolicyResult = {
    account: Address
    policyHash: Hex
    installUserOperationHash?: Hex
    policyUserOperationHash: Hex
}

const NONCE_SYNC_TIMEOUT_MS = 60_000
const NONCE_SYNC_POLL_MS = 1_500

export async function configureAgentPolicy(
    input: ConfigureAgentPolicyInput
): Promise<ConfigureAgentPolicyResult> {
    const account = getAddress(input.ownerKernelClient.account.address)
    const ownerAddress = getAddress(input.ownerAddress)
    const validatorAddress = getAddress(input.validatorAddress)
    const targetToken = getAddress(input.targetToken)
    const intentSigner = getAddress(input.intentSigner)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.strategyId)) {
        throw new TypeError("Policy strategy ID must be 1-64 safe identifier characters.")
    }
    const chainId = input.publicClient.chain?.id
    if (chainId !== 56 && chainId !== 97) {
        throw new Error("Agent policy configuration supports only BSC or BSC testnet.")
    }
    if (input.ownerKernelClient.chain?.id !== chainId) {
        throw new Error("Kernel account client and public client must use the same chain.")
    }
    if (input.maxTradeValue <= BigInt(0) || input.maxTradeValue > MAX_TRADE_VALUE) {
        throw new RangeError("Policy maximum trade value must be between 1 wei and 0.5 BNB.")
    }
    if (input.entryPriceMicros <= BigInt(0) || input.entryPriceMicros > (BigInt(1) << BigInt(64)) - BigInt(1)) throw new RangeError("Entry price threshold must fit a positive uint64 micro-USD value.")
    if (!Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 500 || !Number.isInteger(input.maxPriceImpactBps) || input.maxPriceImpactBps < 1 || input.maxPriceImpactBps > 300) throw new RangeError("Slippage and price-impact limits are outside validator bounds.")
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
    if (input.expiresAt <= nowSeconds || input.expiresAt > (BigInt(1) << BigInt(64)) - BigInt(1)) {
        throw new RangeError("Policy expiry must be a future Unix timestamp that fits uint64.")
    }

    const policyHash = hashAgentPolicy({
        strategyId: input.strategyId,
        ownerAddress,
        account,
        targetToken,
        maxTradeValue: input.maxTradeValue,
        expiresAt: input.expiresAt,
        intentSigner,
        amountBnb: input.amountBnb,
        entryPriceMicros: input.entryPriceMicros,
        slippageBps: input.slippageBps,
        maxPriceImpactBps: input.maxPriceImpactBps
    })
    // Public BSC RPCs are load-balanced and can lag the bundler by several blocks. Every owner
    // UserOperation below is followed by waiting until the EntryPoint nonce visibly advances, so
    // the next operation never reuses a stale nonce and readbacks see post-operation state.
    const waitForNonceAbove = async (previous: bigint) => {
        const deadline = Date.now() + NONCE_SYNC_TIMEOUT_MS
        while (Date.now() < deadline) {
            if (await input.ownerKernelClient.account.getNonce() > previous) return
            await new Promise(resolve => setTimeout(resolve, NONCE_SYNC_POLL_MS))
        }
        throw new Error("The RPC node did not observe the confirmed UserOperation in time. Retry the setup; completed steps are skipped.")
    }

    let installed = await input.publicClient.readContract({
        address: validatorAddress,
        abi: AGENT_POLICY_HOOK_ABI,
        functionName: "isInitialized",
        args: [account]
    })
    let installUserOperationHash: Hex | undefined
    if (!installed) {
        const hookData = concatHex([
            "0x00",
            encodeAbiParameters([{ type: "address" }], [targetToken])
        ])
        const installCall = encodeFunctionData({
            abi: kernelModuleInstallAbi,
            functionName: "installModule",
            args: [HOOK_MODULE_TYPE, validatorAddress, hookData]
        })
        const nonceBeforeInstall = await input.ownerKernelClient.account.getNonce()
        installUserOperationHash = await input.ownerKernelClient.sendUserOperation({
            nonce: nonceBeforeInstall,
            calls: [{ to: account, value: BigInt(0), data: installCall }]
        })
        input.onUserOperationSubmitted?.("install", installUserOperationHash)
        const installReceipt = await input.ownerKernelClient.waitForUserOperationReceipt({
            hash: installUserOperationHash
        })
        if (!installReceipt.success) {
            throw new Error(`Hook installation UserOperation reverted: ${installUserOperationHash}`)
        }
        await waitForNonceAbove(nonceBeforeInstall)
        installed = await input.publicClient.readContract({
            address: validatorAddress,
            abi: AGENT_POLICY_HOOK_ABI,
            functionName: "isInitialized",
            args: [account]
        })
        if (!installed) {
            throw new Error("Hook installation UserOperation succeeded but the hook is not initialized.")
        }
    }

    const installedTarget = await input.publicClient.readContract({
        address: validatorAddress,
        abi: AGENT_POLICY_HOOK_ABI,
        functionName: "getTargetToken",
        args: [account]
    })
    if (getAddress(installedTarget) !== targetToken) {
        throw new Error("Configured target token does not match the installed policy hook.")
    }

    const policyCall = encodeFunctionData({
        abi: AGENT_POLICY_HOOK_ABI,
        functionName: "setAccountPolicy",
        args: [account, intentSigner, policyHash, input.maxTradeValue, input.expiresAt, input.entryPriceMicros, input.slippageBps, input.maxPriceImpactBps]
    })
    const nonceBeforePolicy = await input.ownerKernelClient.account.getNonce()
    const policyUserOperationHash = await input.ownerKernelClient.sendUserOperation({
        nonce: nonceBeforePolicy,
        calls: [{ to: validatorAddress, value: BigInt(0), data: policyCall }]
    })
    input.onUserOperationSubmitted?.("policy", policyUserOperationHash)
    const policyReceipt = await input.ownerKernelClient.waitForUserOperationReceipt({
        hash: policyUserOperationHash
    })
    if (!policyReceipt.success) {
        throw new Error(`Policy configuration UserOperation reverted: ${policyUserOperationHash}`)
    }
    await waitForNonceAbove(nonceBeforePolicy)
    const policyState = await input.publicClient.readContract({
        address: validatorAddress,
        abi: AGENT_POLICY_HOOK_ABI,
        functionName: "getAccountPolicy",
        args: [account]
    })
    const riskState = await input.publicClient.readContract({ address: validatorAddress, abi: AGENT_POLICY_HOOK_ABI, functionName: "getAccountRiskPolicy", args: [account] })
    if (
        riskState[0] !== input.entryPriceMicros || riskState[1] !== input.slippageBps || riskState[2] !== input.maxPriceImpactBps
        || !policyState[0]
        || policyState[1].toLowerCase() !== policyHash.toLowerCase()
        || policyState[2] !== input.maxTradeValue
        || policyState[3] !== input.expiresAt
        || getAddress(policyState[4]) !== intentSigner
    ) {
        throw new Error("On-chain policy readback did not match the requested configuration.")
    }

    return {
        account,
        policyHash,
        installUserOperationHash,
        policyUserOperationHash
    }
}
