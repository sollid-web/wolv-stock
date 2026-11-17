// Single source of truth for the delegated agent's Kernel permission validator.
//
// The owner authorizes the agent ONCE by signing Kernel's `Enable` typed data for this exact
// validator (agent signer + TimestampPolicy + V2 policy hook). The browser (to request that
// signature), the schedule API (to verify it) and the worker (to submit the first, enabling
// UserOperation) must all derive byte-identical enable data, so every party builds the
// validator here. Changing anything in this module changes the enable data and invalidates
// previously collected owner signatures.
//
// This module is isomorphic (no server-only imports): it never touches private keys.
import { addressToEmptyAccount, type KernelValidator, type KernelValidatorHook } from "@zerodev/sdk"
import { toKernelPluginManager } from "@zerodev/sdk/accounts"
import { KERNEL_V3_1, getEntryPoint } from "@zerodev/sdk/constants"
import type { Signer } from "@zerodev/sdk/types"
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator"
import { toPermissionValidator } from "@zerodev/permissions"
import { toTimestampPolicy } from "@zerodev/permissions/policies"
import { toECDSASigner } from "@zerodev/permissions/signers"
import {
    concatHex,
    encodeAbiParameters,
    getAddress,
    parseAbi,
    parseEther,
    recoverTypedDataAddress,
    type Address,
    type Client,
    type Hex
} from "viem"
import { readContract } from "viem/actions"

export const AGENT_ENTRY_POINT = getEntryPoint("0.7")
export const AGENT_KERNEL_VERSION = KERNEL_V3_1
export const AGENT_BUY_SELECTOR = "0x7ff36ab5" as const
export const AGENT_MAX_TRADE_VALUE_WEI = parseEther("0.5")

export type AgentPermissionTargets = {
    routerAddress: Address
    policyHookAddress: Address
    targetTokenAddress: Address
}

/**
 * Targets plus the agent key's validator-level expiry. `permissionValidUntil` MUST equal the
 * on-chain policy expiry (`getAccountPolicy(account).expiresAt`) so the browser, API and worker
 * derive byte-identical enable data.
 */
export type AgentPermissionTerms = AgentPermissionTargets & {
    permissionValidUntil: bigint
}

const UINT48_MAX = (BigInt(1) << BigInt(48)) - BigInt(1)

/** The V2 hook paired with the agent validator. Enable data = 0x00 ‖ abi.encode(targetToken). */
export function createAgentPolicyHook(targets: AgentPermissionTargets): KernelValidatorHook {
    const hookAddress = getAddress(targets.policyHookAddress)
    const targetToken = getAddress(targets.targetTokenAddress)
    return {
        getIdentifier: () => hookAddress,
        getEnableData: async () => concatHex([
            "0x00",
            encodeAbiParameters([{ type: "address" }], [targetToken])
        ])
    }
}

/**
 * The agent session validator: the agent key signs; the PAIRED V2 HOOK is the call allowlist,
 * and a ZeroDev TimestampPolicy invalidates the key at validator level after the policy expiry.
 *
 * Kernel v3.1 forces every UserOperation validated by a hooked validator through
 * `executeUserOp`, i.e. through the hook's preCheck/postCheck (a plain `execute` reverts with
 * InvalidValidator), and this validator is only enabled for the `execute` selector. ZeroDev's
 * CallPolicy (every version up to V0_0_5) cannot parse the `executeUserOp` wrapper and reverts
 * on every call, so it cannot be combined with a hook. The V2 hook enforces strictly more than
 * CallPolicy did: single-call mode only, exact calldata length, approved router,
 * `swapExactETHForTokens`, WBNB->target path, recipient = account, value > 0 and <= the owner's
 * cap (<= 0.5 BNB), plus signed intent, nonce, deadline, rolling caps, Chainlink oracle floor
 * and actually delivered amount.
 */
export async function createAgentSessionValidator(
    client: Client,
    agentSigner: Signer,
    terms: AgentPermissionTerms
): Promise<KernelValidator> {
    const validUntil = terms.permissionValidUntil
    if (validUntil <= BigInt(0) || validUntil > UINT48_MAX) {
        throw new RangeError("Agent permission expiry must be a positive uint48 Unix timestamp.")
    }
    return toPermissionValidator(client, {
        entryPoint: AGENT_ENTRY_POINT,
        kernelVersion: AGENT_KERNEL_VERSION,
        signer: await toECDSASigner({ signer: agentSigner }),
        policies: [toTimestampPolicy({ validAfter: 0, validUntil: Number(validUntil) })]
    })
}

/** Owner ECDSA validator from a public address only. It can identify but never sign. */
export function createOwnerValidatorFromAddress(client: Client, ownerAddress: Address) {
    return signerToEcdsaValidator(client, {
        entryPoint: AGENT_ENTRY_POINT,
        kernelVersion: AGENT_KERNEL_VERSION,
        signer: addressToEmptyAccount(getAddress(ownerAddress))
    })
}

/**
 * Plugin manager for agent execution. When the agent validator is not yet enabled on-chain,
 * the first UserOperation runs in Kernel "enable mode" and carries `pluginEnableSignature`,
 * the owner's one-time authorization. After that, UserOperations use the enabled validator.
 */
export async function createAgentPluginManager(
    client: Client,
    input: {
        ownerValidator: KernelValidator
        agentSigner: Signer
        targets: AgentPermissionTerms
        pluginEnableSignature?: Hex
    }
) {
    return toKernelPluginManager(client, {
        sudo: input.ownerValidator,
        regular: await createAgentSessionValidator(client, input.agentSigner, input.targets),
        hook: createAgentPolicyHook(input.targets),
        entryPoint: AGENT_ENTRY_POINT,
        kernelVersion: AGENT_KERNEL_VERSION,
        ...(input.pluginEnableSignature ? { pluginEnableSignature: input.pluginEnableSignature } : {})
    })
}

/** Typed data the owner signs once to authorize the agent validator for `account`. */
export async function getAgentSessionEnableTypedData(
    client: Client,
    input: {
        account: Address
        ownerAddress: Address
        agentSignerAddress: Address
        targets: AgentPermissionTerms
    }
) {
    const plugins = await createAgentPluginManager(client, {
        ownerValidator: await createOwnerValidatorFromAddress(client, input.ownerAddress),
        agentSigner: addressToEmptyAccount(getAddress(input.agentSignerAddress)),
        targets: input.targets
    })
    const enabled = await plugins.isPluginEnabled(getAddress(input.account), AGENT_BUY_SELECTOR)
    return {
        alreadyEnabled: enabled,
        typedData: enabled ? null : await plugins.getPluginsEnableTypedData(getAddress(input.account))
    }
}

const kernelAbi = parseAbi(["function rootValidator() view returns (bytes21)"])
const ecdsaValidatorAbi = parseAbi(["function ecdsaValidatorStorage(address) view returns (address)"])

/**
 * Reads the account's owner from chain: the Kernel root validator must be the canonical
 * ZeroDev ECDSA validator (type 0x01), and its stored owner is authoritative. Never infer
 * ownership from who deployed a contract or from a locally derived address.
 */
export async function readKernelEcdsaOwner(client: Client, account: Address): Promise<Address> {
    const root = await readContract(client, { address: getAddress(account), abi: kernelAbi, functionName: "rootValidator" })
    const expectedValidator = (await createOwnerValidatorFromAddress(client, "0x0000000000000000000000000000000000000001")).address
    const rootType = root.slice(0, 4)
    const rootModule = getAddress(`0x${root.slice(4)}`)
    if (rootType !== "0x01" || rootModule !== getAddress(expectedValidator)) {
        throw new Error(`Account ${account} root validator ${root} is not the ZeroDev Kernel v3.1 ECDSA validator.`)
    }
    const owner = await readContract(client, {
        address: rootModule,
        abi: ecdsaValidatorAbi,
        functionName: "ecdsaValidatorStorage",
        args: [getAddress(account)]
    })
    if (/^0x0{40}$/i.test(owner)) throw new Error(`Account ${account} has no ECDSA owner.`)
    return getAddress(owner)
}

export type AgentSessionAuthorizationCheck =
    | { ok: true; alreadyEnabled: boolean }
    | { ok: false; reason: string }

/**
 * Verifies the owner's one-time enable signature against the CURRENT on-chain owner and the
 * account's current Kernel validator nonce. A signature for a different validator, account,
 * owner, policy hook, token or router does not verify.
 */
export async function verifyAgentSessionEnableSignature(
    client: Client,
    input: {
        account: Address
        ownerAddress: Address
        agentSignerAddress: Address
        targets: AgentPermissionTerms
        signature: Hex | undefined
    }
): Promise<AgentSessionAuthorizationCheck> {
    const onChainOwner = await readKernelEcdsaOwner(client, input.account)
    if (onChainOwner !== getAddress(input.ownerAddress)) {
        return { ok: false, reason: `Wallet ${input.ownerAddress} is not the on-chain owner of ${input.account}.` }
    }
    const { alreadyEnabled, typedData } = await getAgentSessionEnableTypedData(client, input)
    if (alreadyEnabled) return { ok: true, alreadyEnabled: true }
    if (!input.signature || !/^0x[0-9a-fA-F]{130}$/.test(input.signature) || !typedData) {
        return { ok: false, reason: "A 65-byte owner signature authorizing the agent session validator is required." }
    }
    const recovered = await recoverTypedDataAddress({ ...typedData, signature: input.signature })
    if (getAddress(recovered) !== onChainOwner) {
        return { ok: false, reason: "The agent session authorization was not signed by the on-chain account owner for this exact validator." }
    }
    return { ok: true, alreadyEnabled: false }
}

/** Official Chainlink BNB/USD proxies a production policy hook must be wired to. */
export const OFFICIAL_BNB_USD_FEEDS: Readonly<Record<number, Address>> = {
    97: getAddress("0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526"),
    56: getAddress("0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE"),
}

const hookFeedAbi = [{
    type: "function",
    name: "bnbUsdFeed",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
}] as const

/**
 * Rejects a policy hook whose immutable BNB/USD feed is not the official Chainlink proxy for
 * the chain (for example a retired deployment that used a self-deployed mock feed).
 */
export async function assertOfficialPolicyHookFeed(client: Client, hook: Address, chainId: number): Promise<void> {
    const feed = await readContract(client, { address: getAddress(hook), abi: hookFeedAbi, functionName: "bnbUsdFeed" })
    const expected = OFFICIAL_BNB_USD_FEEDS[chainId]
    if (!expected || getAddress(feed) !== expected) {
        throw new Error(`UNOFFICIAL_FEED: Policy hook ${getAddress(hook)} uses BNB/USD feed ${getAddress(feed)}, not the official Chainlink proxy for chain ${chainId}. Set NEXT_PUBLIC_POLICY_HOOK_ADDRESS to the current V2 deployment (exported shell variables override .env files) and restart.`)
    }
}
