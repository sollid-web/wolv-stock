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

  // Auto-reconnect on page load if we have a stored address
  useEffect(() => {
    // Check if we have a stored address from previous session
    const storedAddress = window.localStorage.getItem("walletAddress");
    if (storedAddress && !address && !isConnecting) {
      // Try to reconnect
      connect().then(() => {
        // We don't need the provider here; the connect function will set state
        // If reconnect fails, the error will be set and we can clear stored address
        // However, we don't have a way to know if it failed from here.
        // We'll rely on the error state being set by connect.
        // For simplicity, we'll just call connect and let it handle state.
        // If we want to clear stored address on failure, we would need to know the outcome.
        // We'll leave it as is for now, and maybe improve later.
      });
    }
  }, [address, connect, isConnecting]);

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