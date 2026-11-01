import type { getRWATokenList } from "../lib/binance.ts"
import { EVM_ADDRESS_PATTERN } from "../lib/apiValidation.ts"
import { parseRwaAssetRecords } from "../lib/rwaAssetResponse.ts"
import {
    resolveBscTokenMetadata,
    selectTrustedBawSpotAsset,
    type BscMetadataClient,
} from "./bscTokenMetadata.ts"

export type ResolvedBawSpotAsset = Awaited<ReturnType<typeof resolveBawSpotAsset>>

export async function resolveBawSpotAsset(
    tokenAddress: string,
    dependencies: {
        getTokenList?: typeof getRWATokenList
        metadataClient?: BscMetadataClient
        now?: () => number
    } = {},
) {
    if (typeof tokenAddress !== "string" || !EVM_ADDRESS_PATTERN.test(tokenAddress)) return null
    const getTokenList = dependencies.getTokenList ?? (await import("../lib/binance.ts")).getRWATokenList
    const records = parseRwaAssetRecords(await getTokenList())
    const asset = selectTrustedBawSpotAsset(records, tokenAddress)
    if (!asset) return null

    const metadata = await resolveBscTokenMetadata(asset, {
        client: dependencies.metadataClient,
        now: dependencies.now,
    })
    return {
        ...asset,
        decimals: metadata.token.decimals,
        decimalMetadata: metadata.token,
        usdtDecimalMetadata: metadata.usdt,
    }
}
