import { resolveBawSpotAsset } from "../../../../services/bawAsset.ts"
import { handleBawApprovalPost } from "../../../../services/bawExecutionHttp.ts"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
    return handleBawApprovalPost(request, {
        configuredToken: process.env.BAW_WALLET_API_TOKEN,
        resolveAsset: resolveBawSpotAsset,
    })
}
