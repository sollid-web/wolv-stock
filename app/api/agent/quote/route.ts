import { resolveBawSpotAsset } from "../../../../services/bawAsset.ts"
import { getBawQuote } from "../../../../services/bawQuote.ts"
import { handleBawQuotePost } from "../../../../services/bawQuoteHttp.ts"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
    return handleBawQuotePost(request, {
        configuredToken: process.env.BAW_WALLET_API_TOKEN,
        quote: (input) => getBawQuote(input, { resolveAsset: resolveBawSpotAsset }),
    })
}
