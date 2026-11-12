import { createRequire } from "node:module";
import {
  createPrivyNodeEip712Signer,
  type PrivyNodeClientLike,
  type PrivyEip712SignRequest,
} from "./privy-eip712-signer";

interface PrivyNodeSdkModule {
  PrivyClient: new (input: {
    appId: string;
    appSecret: string;
    requestExpiry?: { defaultMs: number };
  }) => PrivyNodeClientLike;
}

type SdkLoader = () => PrivyNodeSdkModule;

function requiredEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(key + " is required for the Privy signer");
  return value;
}

function loadPrivyNodeSdk(): PrivyNodeSdkModule {
  try {
    const require = createRequire(import.meta.url);
    return require("@privy-io/node") as PrivyNodeSdkModule;
  } catch {
    throw new Error("Privy Node SDK is not installed. Install the pinned @privy-io/node dependency before enabling the signer.");
  }
}

/**
 * Server-only Privy signer factory. It creates no wallets and never exports keys.
 * The wallet ID/address are pinned by deployment configuration so a caller
 * cannot use this signer to switch custody accounts at runtime.
 */
export function createPrivyEip712SignerFromEnv(
  env: Record<string, string | undefined> = process.env,
  loadSdk: SdkLoader = loadPrivyNodeSdk,
) {
  const appId = requiredEnv(env, "PRIVY_APP_ID");
  const appSecret = requiredEnv(env, "PRIVY_APP_SECRET");
  const authorizationPrivateKey = requiredEnv(env, "PRIVY_AUTHORIZATION_PRIVATE_KEY");
  const walletId = requiredEnv(env, "PRIVY_WALLET_ID");
  const walletAddress = requiredEnv(env, "PRIVY_WALLET_ADDRESS");

  if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) {
    throw new Error("PRIVY_WALLET_ADDRESS must be a valid EVM address");
  }

  const sdk = loadSdk();
  if (!sdk || typeof sdk.PrivyClient !== "function") {
    throw new Error("Privy Node SDK does not expose the expected PrivyClient constructor");
  }

  const client = new sdk.PrivyClient({
    appId,
    appSecret,
    requestExpiry: { defaultMs: 60_000 },
  });
  const signer = createPrivyNodeEip712Signer({ client, authorizationPrivateKey });

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
