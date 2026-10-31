import {
    createBawWalletSessionChallenge,
    isBawBrowserWalletAllowlistConfigured,
    isBawWalletServerTokenConfigured,
    isSameOriginRequest,
    isValidBawWalletAddress,
    readBawWalletAuthJson,
} from "../../../../../services/bawWalletAuth.ts"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
    const token = process.env.BAW_WALLET_API_TOKEN
    if (!isBawWalletServerTokenConfigured(token)) {
        return Response.json({ error: "Operator wallet access is not configured on this host." }, {
            status: 503,
            headers: { "Cache-Control": "no-store" },
        })
    }
    if (!isBawBrowserWalletAllowlistConfigured()) {
        return Response.json({ error: "Authorized browser-wallet identities are not configured on this host." }, {
            status: 503,
            headers: { "Cache-Control": "no-store" },
        })
    }
    if (!isSameOriginRequest(request)) {
        return Response.json({ error: "A same-origin browser request is required." }, { status: 403 })
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return Response.json({ error: "Content-Type must be application/json." }, { status: 400 })
    }
    const parsedBody = await readBawWalletAuthJson(request, 1_024)
    if (!parsedBody.ok) return Response.json({ error: parsedBody.message }, { status: parsedBody.status })
    const body = parsedBody.value
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return Response.json({ error: "A valid connected browser-wallet address is required." }, { status: 422 })
    }
    const requestBody = body as Record<string, unknown>
    if (
        Object.keys(requestBody).length !== 1 || typeof requestBody.address !== "string" ||
        !isValidBawWalletAddress(requestBody.address)
    ) {
        return Response.json({ error: "A valid connected browser-wallet address is required." }, { status: 422 })
    }
    let challenge
    try {
        challenge = await createBawWalletSessionChallenge(requestBody.address, request, token)
    } catch (error) {
        console.error("BAW browser-wallet challenge could not be persisted:", error)
        return Response.json({ error: "Browser-wallet authentication storage is unavailable." }, {
            status: 503,
            headers: { "Cache-Control": "no-store" },
        })
    }
    if (!challenge) {
        return Response.json({ error: "A wallet authentication challenge could not be created." }, { status: 403 })
    }
    return Response.json(challenge, { headers: { "Cache-Control": "no-store" } })
}
