import { getRWATokenList } from "../lib/binance.ts"
import { isSpotRwaTokenAddress, parseRwaAssetRecords } from "../lib/spotAssets.ts"

export async function resolveBawSpotAsset(tokenAddress: string) {
    if (!await isSpotRwaTokenAddress(tokenAddress)) return null
    const records = parseRwaAssetRecords(await getRWATokenList())
    const matches = records.filter((asset) =>
        asset.tokenContractAddress.toLowerCase() === tokenAddress.toLowerCase()
    )
    return matches.length === 1 ? matches[0] : null
}
