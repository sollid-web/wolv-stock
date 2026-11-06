"use client"

import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator"
import {
    KERNEL_V3_1,
    getEntryPoint
} from "@zerodev/sdk/constants"
import {
    createKernelAccount,
    toKernelPluginManager
} from "@zerodev/sdk/accounts"
import { createKernelAccountClient } from "@zerodev/sdk/clients"
import {
    createPublicClient,
    http,
    type WalletClient
} from "viem"
import { estimateFeesPerGas } from "viem/actions"
import { toAccount } from "viem/accounts"
import { getBscRpcUrl, getConfiguredBscChain } from "./bscChain.ts"

const BSC_ENTRY_POINT_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
const ENTRY_POINT = getEntryPoint("0.7")

if (ENTRY_POINT.address.toLowerCase() !== BSC_ENTRY_POINT_ADDRESS.toLowerCase()) {
    throw new Error("ZeroDev SDK EntryPoint v0.7 does not match the configured BSC EntryPoint.")
}

export function getAgentPublicClient() {
    const chain = getConfiguredBscChain()
    return createPublicClient({
        chain,
        transport: http(getBscRpcUrl(chain.id))
    })
}

export function estimateKernelUserOperationFees(
    publicClient: ReturnType<typeof getAgentPublicClient>
) {
    return estimateFeesPerGas(publicClient, { type: "eip1559" })
}

export async function getKernelAccountContext(signer: WalletClient) {
    const chain = getConfiguredBscChain()
    const signerAccount = signer.account
    if (!signerAccount) {
        throw new Error("Connect a wallet account before configuring an agent policy.")
    }
    if (signer.chain?.id !== chain.id) {
        throw new Error("Switch your wallet to the configured BNB Chain network.")
    }

    const publicClient = getAgentPublicClient()
    const ownerSigner = toAccount({
        address: signerAccount.address,
        async signMessage({ message }) {
            return signer.signMessage({ account: signerAccount, message })
        },
        async signTypedData() {
            throw new Error("The Kernel owner validator does not use typed-data signing.")
        },
        async signTransaction() {
            throw new Error("The Kernel owner validator does not sign transactions.")
        }
    })
    const ownerValidator = await signerToEcdsaValidator(publicClient, {
        signer: ownerSigner,
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_1
    })
    const plugins = await toKernelPluginManager(publicClient, {
        sudo: ownerValidator,
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_1
    })
    const account = await createKernelAccount(publicClient, {
        plugins,
        entryPoint: ENTRY_POINT,
        kernelVersion: KERNEL_V3_1
    })

    return { account, chain, publicClient }
}

export function createKernelClientFromContext(
    context: Awaited<ReturnType<typeof getKernelAccountContext>>
) {
    const { account, chain, publicClient } = context
    const bundlerVariable = chain.id === 56
        ? "NEXT_PUBLIC_BSC_BUNDLER_RPC_URL"
        : "NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL"
    const bundlerUrl = chain.id === 56
        ? process.env.NEXT_PUBLIC_BSC_BUNDLER_RPC_URL
        : process.env.NEXT_PUBLIC_BSC_TESTNET_BUNDLER_RPC_URL
    if (!bundlerUrl) {
        throw new Error(`Configure ${bundlerVariable} before submitting agent policies.`)
    }

    return createKernelAccountClient({
        account,
        chain,
        client: publicClient,
        bundlerTransport: http(bundlerUrl),
        userOperation: {
            estimateFeesPerGas: async () => estimateKernelUserOperationFees(publicClient)
        }
    })
}

export async function getKernelClient(signer: WalletClient) {
    return createKernelClientFromContext(await getKernelAccountContext(signer))
}

export type AgentKernelClient = Awaited<ReturnType<typeof getKernelClient>>
