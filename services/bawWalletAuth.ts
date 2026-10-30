import { timingSafeEqual } from "node:crypto"

const MIN_TOKEN_BYTES = 32
const MAX_TOKEN_BYTES = 512
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/

export type BawWalletAuthorization = "authorized" | "unauthorized" | "not_configured"

export function authorizeBawWalletRequest(
    request: Request,
    configuredToken: string | undefined
): BawWalletAuthorization {
    if (!isValidToken(configuredToken)) return "not_configured"

    const authorization = request.headers.get("authorization")
    if (!authorization?.startsWith("Bearer ")) return "unauthorized"

    const providedToken = authorization.slice("Bearer ".length)
    if (!isValidToken(providedToken)) return "unauthorized"

    const expected = Buffer.from(configuredToken)
    const provided = Buffer.from(providedToken)
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        return "unauthorized"
    }

    return "authorized"
}

function isValidToken(value: string | undefined): value is string {
    if (value === undefined) return false
    const token = Buffer.from(value)
    return token.length >= MIN_TOKEN_BYTES
        && token.length <= MAX_TOKEN_BYTES
        && TOKEN_PATTERN.test(value)
}
