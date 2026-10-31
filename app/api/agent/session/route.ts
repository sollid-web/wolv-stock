import {
    clearBawWalletSessionCookie,
    createBawWalletSession,
    getBawWalletSession,
    isBawBrowserWalletAllowlistConfigured,
    isBawWalletServerTokenConfigured,
    isSameOriginRequest,
    readBawWalletAuthJson,
    revokeBawWalletSession,
} from "../../../../services/bawWalletAuth.ts"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const responseHeaders = { "Cache-Control": "no-store" }

export async function GET(request: Request): Promise<Response> {
    const token = process.env.BAW_WALLET_API_TOKEN
    if (!isBawWalletServerTokenConfigured(token)) {
        return Response.json({ error: "Operator wallet access is not configured on this host." }, {
            status: 503,
            headers: responseHeaders,
        })
    }
    if (!isBawBrowserWalletAllowlistConfigured()) {
        return Response.json({ error: "Authorized browser-wallet identities are not configured on this host." }, {
            status: 503,
            headers: responseHeaders,
        })
    }
    let session
    try {
        session = await getBawWalletSession(request, token)
    } catch (error) {
        console.error("BAW browser session could not be verified:", error)
        return Response.json({ error: "Browser-wallet authentication storage is unavailable." }, {
            status: 503,
            headers: responseHeaders,
        })
    }
    if (!session) return Response.json({ error: "A connected browser wallet must authorize this session." }, {
        status: 401,
        headers: responseHeaders,
    })
    return Response.json({ authenticated: true, ...session }, { headers: responseHeaders })
}

export async function POST(request: Request): Promise<Response> {
    const token = process.env.BAW_WALLET_API_TOKEN
    if (!isBawWalletServerTokenConfigured(token)) {
        return Response.json({ error: "Operator wallet access is not configured on this host." }, {
            status: 503,
            headers: responseHeaders,
        })
    }
    if (!isBawBrowserWalletAllowlistConfigured()) {
        return Response.json({ error: "Authorized browser-wallet identities are not configured on this host." }, {
            status: 503,
            headers: responseHeaders,
        })
    }
    if (!isSameOriginRequest(request)) {
        return Response.json({ error: "A same-origin browser request is required." }, { status: 403, headers: responseHeaders })
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return Response.json({ error: "Content-Type must be application/json." }, { status: 400, headers: responseHeaders })
    }
    const parsedBody = await readBawWalletAuthJson(request, 4_096)
    if (!parsedBody.ok) {
        return Response.json({ error: parsedBody.message }, { status: parsedBody.status, headers: responseHeaders })
    }
    const body = parsedBody.value
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return Response.json({ error: "A valid authentication challenge response is required." }, { status: 422, headers: responseHeaders })
    }
    const requestBody = body as Record<string, unknown>
    if (
        Object.keys(requestBody).length !== 3 ||
        !Object.hasOwn(requestBody, "address") || !Object.hasOwn(requestBody, "message") || !Object.hasOwn(requestBody, "signature") ||
        typeof requestBody.address !== "string" || typeof requestBody.message !== "string" || typeof requestBody.signature !== "string"
    ) {
        return Response.json({ error: "A valid authentication challenge response is required." }, { status: 422, headers: responseHeaders })
    }
    let session
    try {
        session = await createBawWalletSession({
            address: requestBody.address,
            message: requestBody.message,
            signature: requestBody.signature,
        }, request, token)
    } catch (error) {
        console.error("BAW browser session could not be persisted:", error)
        return Response.json({ error: "Browser-wallet authentication storage is unavailable." }, {
            status: 503,
            headers: responseHeaders,
        })
    }
    if (!session) {
        return Response.json({ error: "The browser-wallet signature was invalid or expired." }, { status: 401, headers: responseHeaders })
    }
    return Response.json(
        { authenticated: true, address: session.address, expiresAt: session.expiresAt },
        { headers: { ...responseHeaders, "Set-Cookie": session.cookie } },
    )
}

export async function DELETE(request: Request): Promise<Response> {
    if (!isSameOriginRequest(request)) {
        return Response.json({ error: "A same-origin browser request is required." }, { status: 403, headers: responseHeaders })
    }
    try {
        await revokeBawWalletSession(request, process.env.BAW_WALLET_API_TOKEN)
    } catch (error) {
        console.error("BAW browser session revocation failed:", error)
        return Response.json({ error: "Browser-wallet session revocation could not be verified." }, {
            status: 503,
            headers: { ...responseHeaders, "Set-Cookie": clearBawWalletSessionCookie(request) },
        })
    }
    return new Response(null, {
        status: 204,
        headers: { ...responseHeaders, "Set-Cookie": clearBawWalletSessionCookie(request) },
    })
}
