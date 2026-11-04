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
import { toAccount } from "viem/accounts"
import { bsc, bscTestnet } from "viem/chains"

const BSC_ENTRY_POINT_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
const ENTRY_POINT = getEntryPoint("0.7")

if (ENTRY_POINT.address.toLowerCase() !== BSC_ENTRY_POINT_ADDRESS.toLowerCase()) {
    throw new Error("ZeroDev SDK EntryPoint v0.7 does not match the configured BSC EntryPoint.")
}

function getConfiguredChain() {
    const chainId = Number(process.env.NEXT_PUBLIC_BSC_CHAIN_ID ?? "56")
    if (chainId === 56) return bsc
    if (chainId === 97) return bsc
    throw new Error("NEXT_PUBLIC_BSC_CHAIN_ID must be 56 (BSC mainnet) or 97 (BSC testnet).")
}

export function getAgentPublicClient() {
    const chain = getConfiguredChain()
    const rpcUrl = process.env.NEXT_PUBLIC_BSC_RPC_URL
    if (!rpcUrl) {
        throw new Error("Configure NEXT_PUBLIC_BSC_RPC_URL before using agent policies.")
    }

    return createPublicClient({
        chain,
        transport: http(rpcUrl)
    })
}

export async function getKernelClient(signer: WalletClient) {
    const chain = getConfiguredChain()
    const signerAccount = signer.account
    if (!signerAccount) {
        throw new Error("Connect a wallet account before configuring an agent policy.")
    }
    if (signer.chain?.id !== chain.id) {
        throw new Error("Switch your wallet to the configured BNB Chain network.")
    }

    const bundlerUrl = process.env.NEXT_PUBLIC_BSC_BUNDLER_RPC_URL
    if (!bundlerUrl) {
        throw new Error("Configure NEXT_PUBLIC_BSC_BUNDLER_RPC_URL before submitting agent policies.")
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

    return createKernelAccountClient({
        account,
        chain,
        client: publicClient,
        bundlerTransport: http(bundlerUrl)
    })
}

export type AgentKernelClient = Awaited<ReturnType<typeof getKernelClient>>
