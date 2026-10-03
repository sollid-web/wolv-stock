"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSignTypedData,
  useSwitchChain,
  useWalletClient,
} from "wagmi";

interface TxRequest {
  to: string;
  data: string;
  value?: bigint | string;
  gas?: bigint | string;
  gasPrice?: bigint | string;
  maxPriorityFeePerGas?: bigint | string;
}

type TypedData = Record<string, unknown>;

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export interface WalletHookValue {
  /** Kept as `provider` for source-compat with existing call sites, which
   *  only ever used it as a truthy "do we have a signer ready" gate. Its
   *  real type is now a viem WalletClient (from wagmi), not an
   *  ethers.BrowserProvider. */
  provider: ReturnType<typeof useWalletClient>["data"] | null;
  address: string | null;
  chainId: number | undefined;
  isConnected: boolean;
  isCorrectNetwork: boolean;
  /** True only while an explicit, user-initiated connect() is in flight. */
  isConnecting: boolean;
  /** True only during wagmi's automatic reconnect-from-storage on mount. */
  isInitializing: boolean;
  error: string | null;
  walletConnectAvailable: boolean;
  connect: (wallet?: "injected" | "walletConnect") => Promise<void>;
  disconnect: () => void;
  switchToBscMainnet: () => Promise<void>;
  signTypedData: (typedData: TypedData) => Promise<string | null>;
  signTransaction: (transaction: TxRequest) => Promise<string | null>;
  broadcastTransaction: (signedTransaction: string) => Promise<string | null>;
  waitForTransaction: (hash: string) => Promise<"confirmed" | "failed" | "unverified">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConnectionError(error: unknown): string {
  const messages: string[] = [];
  let current = error;

  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    } else if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      for (const key of ["message", "shortMessage", "details"]) {
        if (typeof record[key] === "string") messages.push(record[key]);
      }
      current = record.cause;
    } else if (typeof current === "string") {
      messages.push(current);
      break;
    } else {
      break;
    }
  }

  return messages.join(" ").toLowerCase();
}

function getConnectionErrorMessage(error: unknown): string | null {
  if (!error) return null;

  const message = readConnectionError(error);
  if (/user rejected|user denied|request rejected|user cancelled|user canceled|code.?4001/.test(message)) {
    return "Connection request was declined. Reopen your wallet and approve the connection.";
  }
  if (/metamask(?: extension)? not found|no injected|injected provider|provider not found|no provider|connector not found/.test(message)) {
    return "No browser-wallet provider was found. Open this page in your wallet app's built-in browser, or choose WalletConnect in a regular browser.";
  }
  if (/walletconnect|relay|websocket|web socket|failed to fetch|network|timed? ?out|connection reset|connection request reset|proposal expired/.test(message)) {
    return "WalletConnect could not reach its relay. Check your connection and retry, or use the Browser wallet option inside your wallet app.";
  }
  return "Wallet connection failed. Retry, or switch between Browser wallet and WalletConnect.";
}

function getWalletTransactionError(error: unknown): string {
  const messages: string[] = [];
  let current = error;

  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "string") {
      messages.push(current);
      break;
    }
    if (typeof current !== "object") break;

    const record = current as Record<string, unknown>;
    for (const key of ["shortMessage", "message", "details"]) {
      if (typeof record[key] === "string" && record[key].trim()) {
        messages.push(record[key]);
      }
    }
    current = record.cause;
  }

  const distinctMessages = Array.from(new Set(messages));
  return (distinctMessages.join("; ") || "Wallet could not broadcast the transaction").slice(0, 500);
}

/**
 * Thin wrapper around wagmi's hooks.
 *
 * All connection state, silent reconnect-on-mount, accountsChanged /
 * chainChanged / disconnect handling, and single-source-of-truth state
 * sharing across components now live inside wagmi itself (via the single
 * <WagmiProvider> in app/providers.tsx, see lib/wagmi.ts for the config).
 * This file no longer contains ANY eth_requestAccounts / eth_accounts
 * calls, listener registration, or localStorage bookkeeping - wagmi's
 * connectors own all of that, which is what "removing the custom wallet
 * connection handler" means here. The custom implementation this replaces
 * (hand-rolled useState/useEffect + lib/wallet.ts) is gone.
 *
 * The return shape is intentionally identical to the previous
 * hand-rolled version so TradeButton.tsx, WalletSelector.tsx, and
 * app/wallet/page.tsx did not need to change.
 */
export function useWallet(): WalletHookValue {
  const { address, chainId, isConnected, isReconnecting } = useAccount();
  const {
    connectors,
    connectAsync,
    error: connectError,
    isPending: isConnectPending,
  } = useConnect();
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const { signTypedDataAsync } = useSignTypedData();
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Prefer an already-injected wallet (MetaMask, Trust Wallet, etc.);
  // otherwise fall back to WalletConnect. Mirrors the old lib/wallet.ts
  // fallback order, but the actual eth_requestAccounts call, BSC chain
  // enforcement (chainId: 56 below), and QR-modal flow are all handled by
  // wagmi's connectors, not by hand-rolled window.ethereum calls.
  const connect = useCallback(async (wallet?: "injected" | "walletConnect") => {
    setConnectionError(null);
    const injectedConnector = connectors.find((c) => c.type === "injected");
    const walletConnectConnector = connectors.find(
      (c) => c.type === "walletConnect"
    );
    const target = wallet === "walletConnect"
      ? walletConnectConnector
      : wallet === "injected"
        ? injectedConnector
        : injectedConnector ?? walletConnectConnector ?? connectors[0];
    if (!target) {
      setConnectionError(wallet === "walletConnect"
        ? "WalletConnect is not configured for this deployment. Use the Browser wallet option inside your wallet app."
        : "No browser-wallet provider was found. Open this page in your wallet app's built-in browser, or choose WalletConnect.");
      return;
    }
    try {
      await connectAsync({ connector: target, chainId: 56 });
      setConnectionError(null);
    } catch (err) {
      setConnectionError(getConnectionErrorMessage(err));
    }
  }, [connectors, connectAsync]);

  const disconnect = useCallback(() => {
    setConnectionError(null);
    wagmiDisconnect();
  }, [wagmiDisconnect]);

  const switchToBscMainnet = useCallback(async () => {
    try {
      if (switchChainAsync) {
        await switchChainAsync({ chainId: 56 });
        return;
      }
    } catch {
      // Fall through to direct wallet provider fallback below.
    }

    const ethereum = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
    if (ethereum?.request) {
      try {
        await ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x38" }],
        });
        return;
      } catch (error: unknown) {
        if (!isRecord(error) || error.code !== 4902) {
          throw error;
        }

        await ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x38",
            chainName: "Binance Smart Chain Mainnet",
            nativeCurrency: {
              name: "BNB",
              symbol: "BNB",
              decimals: 18,
            },
            rpcUrls: ["https://bsc-dataseed.binance.org/"],
            blockExplorerUrls: ["https://bscscan.com"],
          }],
        });
      }
    }
  }, [switchChainAsync]);

  const signTypedData = useCallback(
    async (typedData: TypedData): Promise<string | null> => {
      if (!address) return null;
      try {
        if (!isRecord(typedData.domain) || !isRecord(typedData.types) || !isRecord(typedData.message)) {
          throw new Error("Binance returned invalid EIP-712 typed data");
        }
        // EIP-712 typed data needs an explicit primaryType for viem/wagmi's
        // signTypedData, whereas ethers' signer.signTypedData() inferred it.
        // Use it if the API already included one, else derive it as the
        // single non-EIP712Domain key of `types`.
        const primaryType = typeof typedData.primaryType === "string"
          ? typedData.primaryType
          : Object.keys(typedData.types).find((key) => key !== "EIP712Domain");
        if (!primaryType) throw new Error("Binance typed data is missing its primary type");

        return await signTypedDataAsync({
          domain: typedData.domain,
          types: typedData.types,
          primaryType,
          message: typedData.message,
        } as Parameters<typeof signTypedDataAsync>[0]);
      } catch (err) {
        console.error("Failed to sign typed data:", err);
        return null;
      }
    },
    [address, signTypedDataAsync]
  );

  const signTransaction = useCallback(
    async (transaction: TxRequest): Promise<string | null> => {
      if (!address || !walletClient) throw new Error("Wallet account is unavailable; reconnect and retry");
      if (chainId !== 56) throw new Error("Switch to BNB Smart Chain before signing the transaction");

      const hasEip1559Fees = transaction.maxPriorityFeePerGas !== undefined;
      if (hasEip1559Fees && transaction.gasPrice === undefined) {
        throw new Error("Binance swap response is missing the EIP-1559 max fee");
      }

      try {
        return await walletClient.signTransaction({
          account: address as `0x${string}`,
          chain: walletClient.chain,
          to: transaction.to as `0x${string}`,
          data: transaction.data as `0x${string}`,
          value: transaction.value !== undefined ? BigInt(transaction.value) : undefined,
          gas: transaction.gas !== undefined ? BigInt(transaction.gas) : undefined,
          ...(hasEip1559Fees
            ? {
                maxFeePerGas: BigInt(transaction.gasPrice!),
                maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas!),
              }
            : transaction.gasPrice !== undefined
              ? { gasPrice: BigInt(transaction.gasPrice) }
              : {}),
        });
      } catch (err) {
        console.error("Failed to sign transaction:", err);
        const message = getWalletTransactionError(err);
        if (/eth_signtransaction|method not supported/i.test(message)) {
          throw new Error("This wallet cannot sign raw transactions required for Binance broadcast. Connect a wallet that supports eth_signTransaction; wallet-side broadcasting is disabled.");
        }
        throw new Error(message);
      }
    },
    [address, chainId, walletClient]
  );

  const broadcastTransaction = useCallback(
    async (signedTransaction: string): Promise<string | null> => {
      if (!address) return null;
      try {
        const response = await fetch("/api/transaction/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, signedTransaction }),
        });
        const result = await response.json();
        if (!response.ok || result?.code !== 0) {
          throw new Error(result?.error || result?.msg || "Binance broadcast failed");
        }
        return typeof result?.data?.txHash === "string" ? result.data.txHash : null;
      } catch (err) {
        console.error("Failed to broadcast transaction through Binance:", err);
        throw new Error(getWalletTransactionError(err));
      }
    },
    [address]
  );

  const waitForTransaction = useCallback(
    async (hash: string): Promise<"confirmed" | "failed" | "unverified"> => {
      const deadline = Date.now() + 120_000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`/api/transaction-status?txHash=${encodeURIComponent(hash)}`, {
            cache: "no-store",
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Receipt lookup failed");
          if (result.status === "success") return "confirmed";
          if (result.status === "reverted") return "failed";
        } catch (err) {
          lastError = err;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (lastError) console.error("Failed waiting for transaction receipt:", lastError);
      return "unverified";
    },
    []
  );

  return {
    provider: walletClient ?? null,
    address: address ?? null,
    chainId,
    isConnected,
    isCorrectNetwork: chainId === 56,
    isConnecting: isConnectPending,
    isInitializing: isReconnecting,
    error: connectionError ?? getConnectionErrorMessage(connectError),
    walletConnectAvailable: Boolean(process.env.NEXT_PUBLIC_WALLET_PROJECT_ID),
    connect,
    disconnect,
    switchToBscMainnet,
    signTypedData,
    signTransaction,
    broadcastTransaction,
    waitForTransaction,
  };
}
