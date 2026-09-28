"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";
import {
  connectWallet,
  getWalletAddress,
  signTypedData,
  signTransaction,
  disconnectWallet,
} from "@/lib/wallet";

export type WalletStatus = "initializing" | "connected" | "disconnected";

export function useWallet() {
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletStatus, setWalletStatus] = useState<WalletStatus>("initializing");

  // Refs to track if we're mounted and avoid state updates after unmount
  const isMountedRef = useRef(true);
  const initializationCompleteRef = useRef(false);

  // Connect wallet (explicit user action)
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
          setWalletStatus("connected");
        }
      } else {
        setError("Failed to connect wallet");
        setWalletStatus("disconnected");
      }
    } catch (err: any) {
      setError(err.message || "Unknown error");
      setWalletStatus("disconnected");
    } finally {
      if (isMountedRef.current) {
        setIsConnecting(false);
      }
    }
  }, []);

  // Disconnect wallet
  const disconnect = useCallback(() => {
    setProvider(null);
    setAddress(null);
    setWalletStatus("disconnected");
    disconnectWallet();
  }, []);

  // Restore wallet from injected provider (silent rehydration on mount)
  const restoreWallet = useCallback(async () => {
    if (typeof window === "undefined") {
      setWalletStatus("disconnected");
      return;
    }

    const win = window as any;

    // Check if injected provider exists
    if (!win.ethereum) {
      setWalletStatus("disconnected");
      return;
    }

    try {
      // Get accounts without triggering connection modal
      const accounts: string[] = await win.ethereum.request({
        method: "eth_accounts",
      });

      // Also check chain ID
      const chainId: string = await win.ethereum.request({
        method: "eth_chainId",
      });

      if (accounts.length === 0) {
        // No authorized account
        win.localStorage.removeItem("walletAddress");
        setAddress(null);
        setProvider(null);
        setWalletStatus("disconnected");
        return;
      }

      // Account exists - restore connection
      const { ethers } = await import("ethers");
      const p = new ethers.BrowserProvider(win.ethereum);
      const signer = await p.getSigner();
      const addr = await signer.getAddress();

      if (isMountedRef.current) {
        setProvider(p);
        setAddress(addr);
        setWalletStatus("connected");
        win.localStorage.setItem("walletAddress", addr);

        // Check if we need to switch to BSC (chain ID 56 = 0x38)
        if (chainId !== "0x38") {
          try {
            await win.ethereum.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: "0x38" }],
            });
          } catch (switchError: any) {
            if (switchError.code === 4902) {
              // Chain not added, try to add it
              await win.ethereum.request({
                method: "wallet_addEthereumChain",
                params: [{
                  chainId: "0x38",
                  chainName: "Binance Smart Chain Mainnet",
                  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
                  rpcUrls: ["https://bsc-dataseed.binance.org/"],
                  blockExplorerUrls: ["https://bscscan.com"],
                }],
              });
            }
          }
        }
      }
    } catch (err) {
      console.error("Failed to restore wallet:", err);
      if (isMountedRef.current) {
        win.localStorage.removeItem("walletAddress");
        setAddress(null);
        setProvider(null);
        setWalletStatus("disconnected");
      }
    } finally {
      if (isMountedRef.current) {
        initializationCompleteRef.current = true;
      }
    }
  }, []);

  // Auto-restore on mount
  useEffect(() => {
    isMountedRef.current = true;
    initializationCompleteRef.current = false;

    // Run silent auto-reconnect
    restoreWallet();

    return () => {
      isMountedRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Restore wallet state when user returns to page after wallet app switch
  useEffect(() => {
    const handleVisibility = async () => {
      if (document.visibilityState !== "visible") return;
      if (address || isConnecting) return;
      const win = window as any;
      if (!win.ethereum) return;
      try {
        const accounts: string[] = await win.ethereum.request({ method: "eth_accounts" });
        if (accounts.length === 0) return;
        const { ethers } = await import("ethers");
        const p = new ethers.BrowserProvider(win.ethereum);
        const signer = await p.getSigner();
        setProvider(p);
        setAddress(await signer.getAddress());
      } catch { /* silent */ }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, isConnecting]);

  // Listen for account changes
  useEffect(() => {
    if (provider && initializationCompleteRef.current) {
      const handleAccountsChanged = (accounts: string[]) => {
        if (!isMountedRef.current) return;

        if (accounts.length === 0) {
          // User disconnected or switched accounts
          setAddress(null);
          window.localStorage.removeItem("walletAddress");
          setWalletStatus("disconnected");
        } else if (accounts[0] !== address) {
          // User switched to a different account
          setAddress(accounts[0]);
          window.localStorage.setItem("walletAddress", accounts[0]);
        }
      };

      const handleChainChanged = () => {
        if (!isMountedRef.current) return;
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
    walletStatus,
    connect,
    disconnect,
    signTypedData: (typedData: Record<string, any>) =>
      provider ? signTypedData(provider, typedData) : Promise.resolve(null),
    signTransaction: (transaction: ethers.TransactionRequest, skipEstimateGas?: boolean) =>
      provider ? signTransaction(provider, transaction, skipEstimateGas) : Promise.resolve(null),
  };
}