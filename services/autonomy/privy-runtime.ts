import { createPrivateKey, createSign } from "node:crypto";
import {
  createPrivyEip712Signer,
  type Eip712TypedData,
  type PrivyEip712SignRequest,
  type PrivyEip712SigningClient,
} from "./privy-eip712-signer";

type FetchLike = typeof fetch;

interface PrivyRpcResponse {
  method?: unknown;
  data?: { encoding?: unknown; signature?: unknown };
}

function requiredEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(key + " is required for the Privy signer");
  return value;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Privy authorization payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return "{" + keys.map((key) => {
      if (record[key] === undefined) throw new Error("Privy authorization payload contains an undefined value");
      return JSON.stringify(key) + ":" + canonicalize(record[key]);
    }).join(",") + "}";
  }
  throw new Error("Privy authorization payload contains an unsupported value");
}

export function canonicalizePrivyAuthorizationRequest(input: {
  version: 1;
  method: "POST";
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}): string {
  return canonicalize(input);
}

export function createPrivyHttpEip712SigningClient(input: {
  appId: string;
  appSecret: string;
  authorizationPrivateKey: string;
  apiUrl?: string;
  fetchImpl?: FetchLike;
  requestExpiryMs?: number;
}): PrivyEip712SigningClient {
  const appId = input.appId.trim();
  const appSecret = input.appSecret.trim();
  if (!appId || !appSecret) throw new Error("Privy app ID and app secret are required");
  const apiBase = (input.apiUrl ?? "https://api.privy.io").replace(/\/$/, "");
  const parsedApiBase = new URL(apiBase);
  if (parsedApiBase.protocol !== "https:") throw new Error("Privy API URL must use HTTPS");
  if (parsedApiBase.username || parsedApiBase.password) throw new Error("Do not embed credentials in the Privy API URL");

  let authorizationKey;
  try {
    authorizationKey = createPrivateKey({
      key: Buffer.from(input.authorizationPrivateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new Error("PRIVY_AUTHORIZATION_PRIVATE_KEY must be base64 PKCS8 P-256 private-key material");
  }
  if (authorizationKey.asymmetricKeyType !== "ec" ||
      authorizationKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Privy authorization key must be an EC P-256 key");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const requestExpiryMs = input.requestExpiryMs ?? 60_000;
  if (!Number.isSafeInteger(requestExpiryMs) || requestExpiryMs < 5_000 || requestExpiryMs > 300_000) {
    throw new Error("Privy request expiry must be between 5 and 300 seconds");
  }

  return {
    async signTypedData(request: {
      walletId: string;
      walletAddress: string;
      typedData: Eip712TypedData;
      idempotencyKey: string;
    }): Promise<{ signature: string }> {
      if (!request.walletId || request.walletId.length > 256) throw new Error("Privy wallet ID is invalid");
      if (!/^0x[0-9a-f]{40}$/i.test(request.walletAddress)) throw new Error("Privy wallet address is invalid");
      if (!request.idempotencyKey || request.idempotencyKey.length < 8 || request.idempotencyKey.length > 128) {
        throw new Error("Privy signer idempotency key is invalid");
      }

      const url = apiBase + "/v1/wallets/" + encodeURIComponent(request.walletId) + "/rpc";
      const body = {
        method: "eth_signTypedData_v4",
        chain_type: "ethereum",
        caip2: "eip155:56",
        address: request.walletAddress,
        params: {
          typed_data: {
            domain: request.typedData.domain,
            message: request.typedData.message,
            primary_type: request.typedData.primaryType,
            types: request.typedData.types,
          },
        },
      };
      const expiry = String(Date.now() + requestExpiryMs);
      const headersToSign = {
        "privy-app-id": appId,
        "privy-idempotency-key": request.idempotencyKey,
        "privy-request-expiry": expiry,
      };
      const authorizationPayload = canonicalizePrivyAuthorizationRequest({
        version: 1,
        method: "POST",
        url,
        body,
        headers: headersToSign,
      });
      const signer = createSign("sha256");
      signer.update(authorizationPayload);
      signer.end();
      const authorizationSignature = signer.sign({
        key: authorizationKey,
        dsaEncoding: "der",
      }).toString("base64");

      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(appId + ":" + appSecret).toString("base64"),
          "content-type": "application/json",
          "privy-app-id": appId,
          "privy-authorization-signature": authorizationSignature,
          "privy-idempotency-key": request.idempotencyKey,
          "privy-request-expiry": expiry,
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });

      const responseBody = await response.text();
      if (!response.ok) {
        throw new Error("Privy signing request failed with HTTP " + response.status);
      }

      let parsed: PrivyRpcResponse;
      try {
        parsed = JSON.parse(responseBody) as PrivyRpcResponse;
      } catch {
        throw new Error("Privy returned a non-JSON signing response");
      }
      const data = parsed.data;
      if (parsed.method !== "eth_signTypedData_v4" ||
          !data || data.encoding !== "hex" ||
          typeof data.signature !== "string" ||
          !/^0x[0-9a-f]{130}$/i.test(data.signature)) {
        throw new Error("Privy returned an invalid EIP-712 RPC response");
      }
      return { signature: data.signature };
    },
  };
}

/**
 * Server-only production signer. It creates no wallets, exports no keys and
 * pins every signing call to the wallet configured by the operator.
 */
export function createPrivyEip712SignerFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchLike = fetch,
) {
  const appId = requiredEnv(env, "PRIVY_APP_ID");
  const appSecret = requiredEnv(env, "PRIVY_APP_SECRET");
  const authorizationPrivateKey = requiredEnv(env, "PRIVY_AUTHORIZATION_PRIVATE_KEY");
  const walletId = requiredEnv(env, "PRIVY_WALLET_ID");
  const walletAddress = requiredEnv(env, "PRIVY_WALLET_ADDRESS");

  if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) {
    throw new Error("PRIVY_WALLET_ADDRESS must be a valid EVM address");
  }

  const signer = createPrivyEip712Signer(createPrivyHttpEip712SigningClient({
    appId,
    appSecret,
    authorizationPrivateKey,
    apiUrl: env.PRIVY_API_URL,
    fetchImpl,
  }));

  return {
    async sign(request: PrivyEip712SignRequest): Promise<string> {
      if (request.walletId !== walletId) {
        throw new Error("Requested Privy wallet ID does not match the deployment-bound wallet");
      }
      if (request.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error("Requested signer address does not match the deployment-bound wallet");
      }
      return signer.sign(request);
    },
  };
}
