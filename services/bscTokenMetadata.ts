import "server-only"
import {
    createPublicClient,
    defineChain,
    getAddress,
    http,
    type Address,
    type PublicClient,
} from "viem"
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN } from "../lib/apiValidation.ts"
import { isSpotEligibleAsset } from "../lib/compliance.ts"
import { resolvePublicRpcUrl } from "../lib/publicRpcUrl.ts"
import type { RwaAssetRecord } from "../lib/spotAssets.ts"

const SUPPORTED_DECIMALS_MAX = 18
const DECIMALS_ABI = [{
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
}] as const
const trustedCatalogueAsset = Symbol("trusted-catalogue-asset")
type TrustedCatalogueAsset = RwaAssetRecord & { [trustedCatalogueAsset]: true }

export type BscTokenDecimalMetadata = {
    chainId: "56"
    tokenAddress: string
    decimals: number
    resolutionSource: "BSC_ETH_CALL"
    blockNumber: string
    resolvedAt: number
    validationStatus: "VALIDATED"
}

export class BscTokenMetadataError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "BscTokenMetadataError"
    }
}

export function selectTrustedBawSpotAsset(
    records: RwaAssetRecord[],
    tokenAddress: string,
): TrustedCatalogueAsset | null {
    if (!EVM_ADDRESS_PATTERN.test(tokenAddress)) return null
    const matches = records.filter((asset) =>
        asset.tokenContractAddress.toLowerCase() === tokenAddress.toLowerCase()
    )
    return matches.length === 1 && isSpotEligibleAsset(matches[0])
        ? { ...matches[0], [trustedCatalogueAsset]: true }
        : null
}

export type BscMetadataClient = Pick<
    PublicClient,
    "getChainId" | "getBlockNumber" | "getBytecode" | "readContract"
>

const rpcUrl = process.env.BSC_RPC_URL
    ? requireServerRpcUrl(process.env.BSC_RPC_URL)
    : resolvePublicRpcUrl(
        process.env.NEXT_PUBLIC_BSC_RPC_URL,
        "https://bsc-dataseed.bnbchain.org",
        "NEXT_PUBLIC_BSC_RPC_URL",
    )
const bsc = defineChain({
    id: 56,
    name: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
})
const defaultClient = createPublicClient({
    chain: bsc,
    transport: http(rpcUrl, { timeout: 5_000 }),
})

function requireServerRpcUrl(value: string): string {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error("BSC_RPC_URL must be a valid server-side HTTP(S) RPC URL.")
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hash) {
        throw new Error("BSC_RPC_URL must be a server-side HTTP(S) RPC URL.")
    }
    return url.toString()
}

export async function resolveBscTokenMetadata(
    asset: TrustedCatalogueAsset,
    dependencies: { client?: BscMetadataClient; now?: () => number } = {},
): Promise<{ token: BscTokenDecimalMetadata; usdt: BscTokenDecimalMetadata }> {
    if (
        !asset ||
        asset[trustedCatalogueAsset] !== true ||
        typeof asset.tokenContractAddress !== "string" ||
        !EVM_ADDRESS_PATTERN.test(asset.tokenContractAddress) ||
        !isSpotEligibleAsset(asset)
    ) {
        throw new BscTokenMetadataError("The asset is not a valid, eligible BSC catalogue token.")
    }

    const client = dependencies.client ?? defaultClient
    const chainId = await client.getChainId()
    if (chainId !== 56) {
        throw new BscTokenMetadataError("The configured read-only RPC is not connected to BNB Smart Chain mainnet.")
    }
    const blockNumber = await client.getBlockNumber()
    const resolvedAt = (dependencies.now ?? Date.now)()
    let tokenAddress: Address
    try {
        tokenAddress = getAddress(asset.tokenContractAddress)
    } catch {
        throw new BscTokenMetadataError("The catalogue token address has an invalid checksum.")
    }
    const usdtAddress = getAddress(BSC_USDT_ADDRESS)
    const [token, usdt] = await Promise.all([
        readTokenMetadata(client, tokenAddress, blockNumber, resolvedAt),
        readTokenMetadata(client, usdtAddress, blockNumber, resolvedAt),
    ])
    return { token, usdt }
}

async function readTokenMetadata(
    client: BscMetadataClient,
    tokenAddress: Address,
    blockNumber: bigint,
    resolvedAt: number,
): Promise<BscTokenDecimalMetadata> {
    let code: string | undefined
    try {
        code = await client.getBytecode({ address: tokenAddress, blockNumber })
    } catch {
        throw new BscTokenMetadataError(`Contract code could not be verified for ${tokenAddress}.`)
    }
    if (!code || code === "0x") {
        throw new BscTokenMetadataError(`No deployed contract code exists at ${tokenAddress}.`)
    }

    let decimals: unknown
    try {
        decimals = await client.readContract({
            address: tokenAddress,
            abi: DECIMALS_ABI,
            functionName: "decimals",
            blockNumber,
        })
    } catch {
        throw new BscTokenMetadataError(`The decimals() read failed for ${tokenAddress}.`)
    }
    if (
        typeof decimals !== "number" ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > SUPPORTED_DECIMALS_MAX
    ) {
        throw new BscTokenMetadataError(`The decimals() value for ${tokenAddress} is outside WOLV's supported range.`)
    }

    return {
        chainId: "56",
        tokenAddress,
        decimals,
        resolutionSource: "BSC_ETH_CALL",
        blockNumber: blockNumber.toString(),
        resolvedAt,
        validationStatus: "VALIDATED",
    }
}
