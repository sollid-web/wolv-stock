import {
  createPrivyEip712Signer,
  createPrivyNodeEip712SigningClient,
  type PrivyEip712SignRequest,
  type PrivyEip712SigningClient,
} from "./privy-eip712-signer";

type PrivyNodeModule = {
  PrivyClient?: new (input: { appId: string; appSecret: string }) => unknown;
};

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(name + " is required for the Privy server signer");
  return value;
}

export function loadPrivyServerConfig(env: Record<string, string | undefined> = process.env) {
  const walletId = required(env, "PRIVY_WALLET_ID");
  const walletAddress = required(env, "PRIVY_WALLET_ADDRESS");
  if (!/^0x[0-9a-f]{40}$/i.test(walletAddress)) {
    throw new Error("PRIVY_WALLET_ADDRESS must be an EVM address");
  }
  return {
    appId: required(env, "PRIVY_APP_ID"),
    appSecret: required(env, "PRIVY_APP_SECRET"),
    walletId,
    walletAddress: walletAddress.toLowerCase(),
    authorizationPrivateKey: required(env, "PRIVY_AUTHORIZATION_PRIVATE_KEY"),
  };
}

/**
 * Loads the official Privy Node SDK at runtime so the core application can
 * compile without embedding the SDK's generated types into client bundles.
 * The @privy-io/node dependency must be installed in the server environment.
 */
export async function createPrivyServerEip712Signer(
  env: Record<string, string | undefined> = process.env,
): Promise<{
  walletId: string;
  walletAddress: string;
  sign(request: Omit<PrivyEip712SignRequest, "walletId" | "walletAddress">): Promise<string>;
}> {
  const config = loadPrivyServerConfig(env);
  let module: PrivyNodeModule;
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as
      (specifier: string) => Promise<PrivyNodeModule>;
    module = await dynamicImport("@privy-io/node");
  } catch {
    throw new Error("@privy-io/node is not installed in the server runtime. Install the pinned SDK before enabling live signing.");
  }
  if (typeof module.PrivyClient !== "function") {
    throw new Error("@privy-io/node does not export PrivyClient");
  }

  const client = new module.PrivyClient({
    appId: config.appId,
    appSecret: config.appSecret,
  });

  const signingClient: PrivyEip712SigningClient = createPrivyNodeEip712SigningClient({
    client: client as Parameters<typeof createPrivyNodeEip712SigningClient>[0]["client"],
    authorizationPrivateKey: config.authorizationPrivateKey,
  });
  const signer = createPrivyEip712Signer(signingClient);

  return {
    walletId: config.walletId,
    walletAddress: config.walletAddress,
    async sign(request) {
      return signer.sign({
        ...request,
        walletId: config.walletId,
        walletAddress: config.walletAddress,
      });
    },
  };
}
