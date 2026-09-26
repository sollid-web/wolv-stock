"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import {
  connectWallet,
  getWalletAddress,
  signTypedData,
  signTransaction,
  disconnectWallet,
} from "@/lib/wallet";

export function useWallet() {
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Connect wallet
  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);

    try {
      const walletProvider = await connectWallet();
      if (walletProvider) {
        setProvider(walletProvider);
        const walletAddress = await getWalletAddress(walletProvider);
        if (walletAddress) {
          setAddress(walletAddress);
        }
      } else {
        setError("Failed to connect wallet");
      }
    } catch (err: any) {
      setError(err.message || "Unknown error");
    } finally {
      setIsConnecting(false);
    }
  }, []);

  // Disconnect wallet
  const disconnect = useCallback(() => {
    setProvider(null);
    setAddress(null);
    disconnectWallet();
  }, []);

  // Silent auto-reconnect on page load — only checks injected wallet,
  // never triggers WalletConnect modal
  useEffect(() => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any;
    const storedAddress = win.localStorage.getItem("walletAddress");
    if (!storedAddress || address || isConnecting) return;
    if (!win.ethereum) return;

    (async () => {
      try {
        const accounts: string[] = await win.ethereum.request({
          method: "eth_accounts",
        });
        if (accounts.length === 0) {
          win.localStorage.removeItem("walletAddress");
          return;
        }
        const { ethers } = await import("ethers");
        const p = new ethers.BrowserProvider(win.ethereum);
        const signer = await p.getSigner();
        const addr = await signer.getAddress();
        setProvider(p);
        setAddress(addr);
      } catch {
        win.localStorage.removeItem("walletAddress");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for account changes
  useEffect(() => {
    if (provider) {
      const handleAccountsChanged = (accounts: string[]) => {
        if (accounts.length === 0) {
          // User disconnected or switched accounts
          setAddress(null);
          window.localStorage.removeItem("walletAddress");
        } else if (accounts[0] !== address) {
          // User switched to a different account
          setAddress(accounts[0]);
          window.localStorage.setItem("walletAddress", accounts[0]);
        }
      };

      const handleChainChanged = () => {
        // Recommend reload on chain change
        window.location.reload();
      };

      if (provider.provider?.on) {
        provider.provider.on("accountsChanged", handleAccountsChanged);
        provider.provider.on("chainChanged", handleChainChanged);
      }

      return () => {
        if (provider.provider?.off) {
          provider.provider.off("accountsChanged", handleAccountsChanged);
          provider.provider.off("chainChanged", handleChainChanged);
        }
      };
    }
  }, [provider, address]);

  // Store address when it changes
  useEffect(() => {
    if (address) {
      window.localStorage.setItem("walletAddress", address);
    }
  }, [address]);

  const isConnected = !!address && !!provider;

  return {
    provider,
    address,
    isConnected,
    isConnecting,
    error,
    connect,
    disconnect,
    signTypedData: (typedData: Record<string, any>) =>
      provider ? signTypedData(provider, typedData) : Promise.resolve(null),
    signTransaction: (transaction: ethers.TransactionRequest) =>
      provider ? signTransaction(provider, transaction) : Promise.resolve(null),
  };
}