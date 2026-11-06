import { bsc, bscTestnet } from "viem/chains"
import { resolvePublicRpcUrl } from "./publicRpcUrl.ts"

export type SupportedBscChainId = 56 | 97

export function getBscChain(chainId: number) {
    if (chainId === 56) return bsc
    if (chainId === 97) return bscTestnet
    throw new Error("BSC chain ID must be 56 (BSC mainnet) or 97 (BSC testnet).")
}

export function getConfiguredBscChain() {
    return getBscChain(Number(
        process.env.NEXT_PUBLIC_BSC_CHAIN_ID
        ?? process.env.NEXT_PUBLIC_CHAIN_ID
        ?? "56"
    ))
}

export function isSupportedBscChainId(chainId: number): chainId is SupportedBscChainId {
    return chainId === 56 || chainId === 97
}

export function isBscNetworkAllowedOnPath(pathname: string, chainId: number): boolean {
    return chainId === 56 || (normalizePathname(pathname) === "/agent" && chainId === 97)
}

export function getWalletConnectChainId(pathname: string): SupportedBscChainId {
    return normalizePathname(pathname) === "/agent" ? getConfiguredBscChain().id : 56
}

function normalizePathname(pathname: string): string {
    return pathname.replace(/\/+$/, "") || "/"
}

export function getBscRpcUrl(chainId: SupportedBscChainId): string {
    if (chainId === 56) {
        return resolvePublicRpcUrl(
            process.env.NEXT_PUBLIC_BSC_RPC_URL,
            "https://bsc-dataseed.binance.org/",
            "NEXT_PUBLIC_BSC_RPC_URL",
        )
    }

    return resolvePublicRpcUrl(
        process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL,
        "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
        "NEXT_PUBLIC_BSC_TESTNET_RPC_URL",
    )
}
