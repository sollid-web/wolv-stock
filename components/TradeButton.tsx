"use client";

import { useState, useEffect, useRef } from "react";
import { isValidUsdtAmount, usdtAmountToWei } from "@/lib/apiValidation";
import { useWallet } from "@/hooks/useWallet";
import WalletSelector from "@/components/WalletSelector";
import NetworkSwitchModal from "@/components/NetworkSwitchModal";
import { useIsHydrated } from "@/hooks/useIsHydrated";

type TokenInfo = {
  address: string;
  symbol: string;
  name: string;
};

type QuoteData = {
  quoteId: string;
  fromTokenAmount: string;
  toTokenAmount: string;
  priceImpactPercent?: number | string;
  quoteFetchedAt?: number;
  executionMode: string;
  vendorName?: string;
  rfq?: {
    vendor: string;
    orderId: string;
    typedDataToSign: Record<string, unknown>;
  };
};

type SwapData = {
  executionMode: string;
  tx?: {
    from: string;
    to: string;
    data: string;
    value?: string;
    gas?: string;
    gasPrice?: string;
    maxPriorityFeePerGas?: string;
  };
  rfq?: {
    vendor: string;
    orderId: string;
  };
};

type ApprovalData = {
  tokenContractAddress: string;
  spender: string;
  calldata: string;
  approveAmount: string;
  gasLimit?: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string;
};

type TransactionStatus = {
  status: string; // pending, confirmed, failed
  transactionHash?: string;
  orderId?: string;
};

type SimulationResult = {
  status: string;
  failReason: string | null;
  balanceChanges: { contractAddress?: string; tokenType?: string; change?: string; owner?: string }[];
  allowanceChanges: { tokenAddress?: string; owner?: string; spender?: string; preAmount?: string; postAmount?: string }[];
};

const QUOTE_TTL_MS = 30_000;

function displayOrderStatus(status: string): string {
  switch (status.toUpperCase()) {
    case "FILLED":
      return "confirmed";
    case "FAILED":
      return "failed";
    default:
      return status.toLowerCase();
  }
}

function isFreshQuote(quote: QuoteData | null, now: number): boolean {
  return !!quote?.quoteFetchedAt && now - quote.quoteFetchedAt < QUOTE_TTL_MS;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function simulateTransaction(from: string, to: string, data: string, value = "0"): Promise<SimulationResult> {
  const response = await fetch("/api/transaction-simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, data, value }),
  });
  const result = await response.json() as SimulationResult & { error?: string };
  if (!response.ok) {
    throw new Error(result.error || "Transaction preflight is unavailable; no transaction was sent");
  }
  if (result.status.toUpperCase() !== "SUCCESS") {
    throw new Error(result.failReason || "Transaction preflight failed; no transaction was sent");
  }
  return result;
}

function SimulationSummary({ title, result }: { title: string; result: SimulationResult }) {
  return (
    <div role="status" style={{ backgroundColor: "#064e3b", color: "#dcfce7", borderRadius: "0.25rem", padding: "0.5rem", margin: "0.5rem 0", fontSize: "0.75rem" }}>
      <div>{title}: {result.status}</div>
      {result.balanceChanges.map((change, index) => (
        <div key={`${change.owner ?? "owner"}-${change.contractAddress ?? "native"}-${index}`} style={{ wordBreak: "break-all" }}>
          Balance change: {change.change ?? "unknown"} raw units · {change.contractAddress || "native asset"}
        </div>
      ))}
      {result.allowanceChanges.map((change, index) => (
        <div key={`${change.owner ?? "owner"}-${change.spender ?? "spender"}-${index}`} style={{ wordBreak: "break-all" }}>
          Allowance: {change.preAmount ?? "?"} → {change.postAmount ?? "?"} raw units · {change.tokenAddress || "token"} · spender {change.spender || "unknown"}
        </div>
      ))}
    </div>
  );
}

export default function TradeButton({ token }: { token: TokenInfo }) {
  const isHydrated = useIsHydrated();
  const {
    provider,
    address,
    chainId,
    isConnected,
    isCorrectNetwork,
    isConnecting,
    isInitializing,
    error,
    walletConnectAvailable,
    connect,
    switchToBscMainnet,
    signTypedData,
    signTransaction,
    broadcastTransaction,
    waitForTransaction,
  } = useWallet();

  // State variables
  const [usdtAmount, setUsdtAmount] = useState("10"); // Default 10 USDT
  const [quoteData, setQuoteData] = useState<QuoteData | null>(null);
  const [swapData, setSwapData] = useState<SwapData | null>(null);
  const [swapSimulation, setSwapSimulation] = useState<SimulationResult | null>(null);
  const [approvalSimulation, setApprovalSimulation] = useState<SimulationResult | null>(null);
  const [typedDataToSign, setTypedDataToSign] = useState<Record<string, unknown> | null>(null);
  const [userSignature, setUserSignature] = useState<string | null>(null);
  const [approvalData, setApprovalData] = useState<ApprovalData | null>(null);
  const [transactionStatus, setTransactionStatus] = useState<TransactionStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isSwitchingNetwork, setIsSwitchingNetwork] = useState(false);
  const [requiresFreshQuote, setRequiresFreshQuote] = useState(false);
  const [quoteNow, setQuoteNow] = useState(0);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rfqRequestIdRef = useRef<string | null>(null);

  // Ref to store the latest quote ID for polling
  const quoteIdRef = useRef<string | null>(null);

  // Fetch quote when manually requested (not automatic)
  const fetchQuote = async () => {
    if (!isConnected || !provider || !token.address || !usdtAmount) {
      setQuoteError("Please connect wallet and enter USDT amount");
      return;
    }

    if (!isCorrectNetwork) {
      setQuoteError("Switch to Binance Smart Chain Mainnet to continue.");
      return;
    }

    setIsLoading(true);
    setQuoteError(null);
    setQuoteData(null);
    setSwapData(null);
    setSwapSimulation(null);
    setApprovalSimulation(null);
    setRequiresFreshQuote(false);
    setTypedDataToSign(null);
    setUserSignature(null);
    setApprovalData(null);
    setTransactionStatus(null);
    setSubmitError(null);
    setApprovalError(null);

    // Clear any existing poll interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    try {
      const amountInWei = usdtAmountToWei(usdtAmount);
      rfqRequestIdRef.current = null;
      const quoteParams = new URLSearchParams({
        toToken: token.address,
        amount: amountInWei,
        userWalletAddress: address ?? "",
      });
      const quoteResponse = await fetch(`/api/quote?${quoteParams}`);
      const quoteResult = await quoteResponse.json();

      if (quoteResult.error) {
        throw new Error(quoteResult.error);
      }
      const rawQuoteId = quoteResult?.quoteId ?? quoteResult?.data?.quoteId;
      if (typeof rawQuoteId !== "string" || !rawQuoteId) {
        throw new Error("Quote failed — no quoteId returned. Check API key and clock sync.");
      }

      const quoteFetchedAt = typeof quoteResult?.quoteFetchedAt === "number" ? quoteResult.quoteFetchedAt : 0;
      setQuoteData({ ...quoteResult, quoteId: rawQuoteId, quoteFetchedAt } as QuoteData);
      setQuoteNow(quoteFetchedAt);
      quoteIdRef.current = rawQuoteId;

      const executionMode = quoteResult?.executionMode ?? quoteResult?.data?.executionMode;
      if (executionMode === "SWAP") {
        if (await checkApproval(amountInWei)) return;
      } else if (executionMode === "RFQ") {
        const vendorName = quoteResult?.vendorName ?? quoteResult?.data?.vendorName;
        if (typeof vendorName !== "string" || !vendorName) {
          throw new Error("RFQ quote is missing the vendor name required for approval");
        }
        if (await checkApproval(amountInWei, vendorName)) return;
      } else {
        throw new Error("Quote returned an unsupported execution mode");
      }

      // Get swap details
      const swapParams = new URLSearchParams({
        toToken: token.address,
        amount: amountInWei,
        userWalletAddress: address ?? "",
        quoteId: rawQuoteId,
      });
      const swapResponse = await fetch(`/api/swap?${swapParams}`);
      const rawSwapObject = await swapResponse.json();
      const swapResult = rawSwapObject?.data ?? rawSwapObject;

      if (!swapResponse.ok || swapResult?.error) {
        throw new Error(swapResult?.error || "Swap service is temporarily unavailable");
      }
      if (swapResult?.executionMode !== executionMode) {
        throw new Error("Quote and swap returned different execution modes");
      }

      setSwapData(swapResult);

      if (swapResult?.executionMode === "SWAP") {
        const transaction = swapResult.tx;
        if (!address || !transaction?.from || !transaction.to || !transaction.data || transaction.from.toLowerCase() !== address.toLowerCase()) {
          throw new Error("Swap response is missing valid transaction details for this wallet");
        }
        setSwapSimulation(await simulateTransaction(address, transaction.to, transaction.data, transaction.value ?? "0"));
      }

      // If this is an RFQ, extract the typed data for signing
      if (swapResult?.executionMode === "RFQ" && swapResult.rfq && swapResult.rfq.typedDataToSign) {
        setTypedDataToSign(swapResult.rfq.typedDataToSign);
      } else {
        setTypedDataToSign(null);
      }
    } catch (err: unknown) {
      setQuoteError(errorMessage(err, "Failed to fetch quote"));
      console.error("Trade error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle USDT amount change
  const handleUsdtAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUsdtAmount(e.target.value);
    setQuoteError(null);
    setQuoteData(null);
    setQuoteNow(0);
    setSwapData(null);
    setSwapSimulation(null);
    setApprovalSimulation(null);
    setApprovalData(null);
    setTypedDataToSign(null);
    setUserSignature(null);
    setSubmitError(null);
    setApprovalError(null);
    rfqRequestIdRef.current = null;
  };

  // Sign the typed data
  const handleSign = async () => {
    if (!typedDataToSign || !provider) return;

    if (chainId !== 56) {
      setSubmitError("Switch to BNB Smart Chain before signing");
      return;
    }

    setSubmitError(null);
    try {
      const signature = await signTypedData(typedDataToSign);
      if (signature) {
        setUserSignature(signature);
      } else {
        setSubmitError("Failed to sign typed data");
      }
    } catch (err: unknown) {
      setSubmitError(errorMessage(err, "Failed to sign typed data"));
    }
  };

  // Check if approval is needed and get approval transaction data
  const checkApproval = async (amount?: string, vendor?: string): Promise<boolean> => {
    if (!isConnected || !provider || !token.address || !usdtAmount) {
      setApprovalError("Connect a wallet and enter a USDT amount before checking approval");
      return true;
    }

    setIsApproving(true);
    setApprovalError(null);
    setApprovalData(null);

    try {
      // Convert USDT amount to wei (18 decimals)
      const amountInWei = amount ?? usdtAmountToWei(usdtAmount);
      const params = new URLSearchParams({
        tokenContractAddress: "0x55d398326f99059ff775485246999027b3197955",
        toToken: token.address,
        approveAmount: amountInWei,
        userWalletAddress: address ?? "",
      });
      if (vendor) params.set("vendor", vendor);

      const approveResponse = await fetch(`/api/approve-transaction?${params}`);
      const approveResult = await approveResponse.json();

      if (approveResult.error) {
        throw new Error(approveResult.error);
      }

      const approvalTransaction = Array.isArray(approveResult.data)
        ? approveResult.data[0]
        : approveResult.data;
      if (
        approvalTransaction?.dexContractAddress &&
        approvalTransaction?.data
      ) {
        const tokenContractAddress = "0x55d398326f99059ff775485246999027b3197955";
        if (!address) throw new Error("Connect a wallet before simulating approval");
        const simulation = await simulateTransaction(
          address,
          tokenContractAddress,
          approvalTransaction.data
        );
        const allowanceChange = simulation.allowanceChanges.find((change) =>
          change.tokenAddress?.toLowerCase() === tokenContractAddress.toLowerCase() &&
          change.owner?.toLowerCase() === address.toLowerCase() &&
          change.spender?.toLowerCase() === approvalTransaction.dexContractAddress.toLowerCase()
        );
        if (!allowanceChange || typeof allowanceChange.preAmount !== "string") {
          throw new Error("Binance simulation did not return the current USDT allowance");
        }
        let currentAllowance: bigint;
        try {
          currentAllowance = BigInt(allowanceChange.preAmount);
        } catch {
          throw new Error("Binance simulation returned an invalid USDT allowance");
        }
        if (currentAllowance >= BigInt(amountInWei)) {
          setApprovalData(null);
          setApprovalSimulation(null);
          return false;
        }

        setApprovalSimulation(simulation);

        setApprovalData({
          tokenContractAddress,
          spender: approvalTransaction.dexContractAddress,
          calldata: approvalTransaction.data,
          approveAmount: amountInWei,
          gasLimit: approvalTransaction.gasLimit,
          gasPrice: approvalTransaction.gasPrice,
          maxPriorityFeePerGas: approvalTransaction.maxPriorityFeePerGas,
        });
        return true;
      } else {
        throw new Error("Binance did not return a valid USDT approval transaction");
      }
    } catch (err: unknown) {
      setApprovalError(errorMessage(err, "Failed to get approval transaction"));
      console.error("Approval error:", err);
      return true;
    } finally {
      setIsApproving(false);
    }
  };

  // Sign and submit approval transaction
  const handleApprove = async () => {
    if (!approvalData || !provider) return;

    if (!address || chainId !== 56) {
      setApprovalError("Reconnect on BNB Smart Chain before approving");
      return;
    }

    setIsApproving(true);
    setApprovalError(null);
    try {
      // Create a transaction request for the approval
      const transactionRequest = {
        to: approvalData.tokenContractAddress,
        data: approvalData.calldata,
        gas: approvalData.gasLimit,
        gasPrice: approvalData.gasPrice,
        maxPriorityFeePerGas: approvalData.maxPriorityFeePerGas,
      };

      setApprovalSimulation(await simulateTransaction(address, transactionRequest.to, transactionRequest.data));

      const signedTransaction = await signTransaction(transactionRequest);
      if (!signedTransaction) throw new Error("Wallet did not sign the approval transaction");
      const transactionHash = await broadcastTransaction(signedTransaction);
      if (!transactionHash) throw new Error("Binance did not return a transaction hash for the approval");
      const approvalStatus = await waitForTransaction(transactionHash);

      if (approvalStatus === "confirmed") {
        setApprovalData(null);
        setApprovalSimulation(null);
        setSwapSimulation(null);
        setRequiresFreshQuote(true);
      } else if (approvalStatus === "failed") {
        setApprovalError("The approval transaction failed on-chain. Review it in your wallet, then request a new quote.");
      } else {
        setApprovalError("Binance has not indexed the approval yet. Verify its status with Binance before continuing.");
      }
    } catch (err: unknown) {
      setApprovalError(errorMessage(err, "Failed to submit approval transaction"));
    } finally {
      setIsApproving(false);
    }
  };

  // Submit the signed order
  const handleSubmitOrder = async () => {
    if (!quoteData || !swapData || !provider || !address) return;

    if (chainId !== 56) {
      setSubmitError("Switch to BNB Smart Chain before executing this trade");
      return;
    }

    if (!isFreshQuote(quoteData, quoteNow)) {
      setRequiresFreshQuote(true);
      setSubmitError("This quote is stale. Get a fresh quote before signing or submitting a trade.");
      return;
    }

    if (swapData.executionMode === "SWAP") {
      const tx = swapData.tx;
      if (!tx?.from || !tx.to || !tx.data) {
        setSubmitError("Swap response is missing its transaction details");
        return;
      }
      if (tx.from.toLowerCase() !== address.toLowerCase()) {
        setSubmitError("Swap transaction wallet does not match the connected wallet");
        return;
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(tx.to) || !/^0x(?:[a-fA-F0-9]{2})+$/.test(tx.data)) {
        setSubmitError("Swap response contains invalid transaction data");
        return;
      }

      setIsSubmitting(true);
      setSubmitError(null);
      setTransactionStatus(null);

      try {
        setSwapSimulation(await simulateTransaction(address, tx.to, tx.data, tx.value ?? "0"));
        const signedTransaction = await signTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          gas: tx.gas,
          gasPrice: tx.gasPrice,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        });
        if (!signedTransaction) throw new Error("Wallet did not sign the swap transaction");
        const transactionHash = await broadcastTransaction(signedTransaction);
        if (!transactionHash) throw new Error("Binance did not return a transaction hash for the swap");

        setTransactionStatus({
          status: "pending",
          transactionHash,
        });
        void waitForTransaction(transactionHash).then((receiptStatus) => {
          setTransactionStatus((current) =>
            current?.transactionHash === transactionHash
              ? { ...current, status: receiptStatus }
              : current
          );
        });
      } catch (err: unknown) {
        setSubmitError(errorMessage(err, "Failed to submit swap transaction"));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (swapData.executionMode !== "RFQ" || !userSignature) {
      setSubmitError("This swap execution mode is not supported");
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    setTransactionStatus(null);

    try {
      const requestId = rfqRequestIdRef.current ?? crypto.randomUUID();
      rfqRequestIdRef.current = requestId;

      // Extract required data from swap response
      const vendor = swapData.rfq?.vendor;
      const quoteId = swapData.rfq?.orderId;

      if (!vendor || !quoteId) {
        throw new Error("RFQ swap response is missing its vendor or order ID");
      }

      const submitResponse = await fetch(`/api/order/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId,
          userSignature,
          vendor,
          quoteId,
          toToken: token.address
        }),
      });

      const submitResult = await submitResponse.json();

      if (!submitResponse.ok || submitResult.error) {
        throw new Error(submitResult.error || "Order submission failed");
      }
      const order = submitResult.data;
      if (typeof order?.orderId !== "string" || !order.orderId) {
        throw new Error("Order submission response is missing its order ID");
      }

      setTransactionStatus({
        status: typeof order.status === "string" ? displayOrderStatus(order.status) : "pending",
        orderId: order.orderId,
      });

      startPollingTransactionStatus(order.orderId);

    } catch (err: unknown) {
      setSubmitError(errorMessage(err, "Failed to submit order"));
      console.error("Order submission error:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Poll for transaction status
  const startPollingTransactionStatus = (orderId: string) => {
    // Clear any existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    // Set up polling every 5 seconds
    const interval = setInterval(async () => {
      try {
        const statusResponse = await fetch(`/api/order/${orderId}`);
        const statusResult = await statusResponse.json();

        if (statusResult.error) {
          throw new Error(statusResult.error);
        }

        const order = statusResult?.data;
        if (!order || typeof order.status !== "string") {
          throw new Error("Order status response is missing its status");
        }
        const status = order.status.toUpperCase();
        setTransactionStatus((current) => current ? {
          ...current,
          status: displayOrderStatus(status),
          transactionHash: order.txHash ?? current.transactionHash,
        } : current);

        if (status === "FILLED" || status === "FAILED") {
          clearInterval(interval);
          if (pollIntervalRef.current === interval) pollIntervalRef.current = null;
        }
      } catch (err) {
        console.error("Error polling transaction status:", err);
        // Continue polling despite errors
      }
    }, 5000);

    pollIntervalRef.current = interval;
  };

  // Clean up poll interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  // Reset state when token or address changes
  useEffect(() => {
    if (!quoteData?.quoteFetchedAt) return;
    const interval = setInterval(() => setQuoteNow((current) => current + 1000), 1000);
    return () => clearInterval(interval);
  }, [quoteData?.quoteFetchedAt]);

  useEffect(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    // Asset and account changes must clear the prior quote before a new trade can begin.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuoteData(null);
    setQuoteNow(0);
    setSwapData(null);
    setTypedDataToSign(null);
    setUserSignature(null);
    setApprovalData(null);
    setTransactionStatus(null);
    setSubmitError(null);
    setApprovalError(null);
    setQuoteError(null);
    rfqRequestIdRef.current = null;
  }, [token.address, address]);

  // Whether THIS quote's execution mode requires an EIP-712 signature at
  // all. RFQ quotes do (typedDataToSign comes back from /api/swap); a
  // direct-execution quote does not, and never will have typedDataToSign
  // set. The old code required !!userSignature unconditionally, which made
  // the button impossible to enable whenever typedDataToSign was still
  // null - i.e. exactly the case the button is rendered for.
  const requiresTypedDataSignature = !!typedDataToSign;
  const executionPending = !!transactionStatus &&
    !["confirmed", "failed"].includes(transactionStatus.status.toLowerCase());
  const quoteAgeSeconds = quoteData?.quoteFetchedAt
    ? Math.max(0, Math.floor((quoteNow - quoteData.quoteFetchedAt) / 1000))
    : null;
  const quoteIsFresh = isFreshQuote(quoteData, quoteNow);

  const canExecute =
    isConnected &&
    isCorrectNetwork &&
    !!address &&
    !!provider &&
    !!quoteData &&
    !!swapData &&
    quoteIsFresh &&
    (swapData.executionMode !== "SWAP" || swapSimulation?.status.toUpperCase() === "SUCCESS") &&
    !requiresFreshQuote &&
    !isLoading &&
    !isSubmitting &&
    !isApproving &&
    !transactionStatus &&
    !approvalError &&
    (!requiresTypedDataSignature || !!userSignature);

  if (process.env.NODE_ENV !== "production") {
    // Dev-only visibility into the gating logic. No signatures or other
    // sensitive wallet data are logged - only booleans/flags.
    // eslint-disable-next-line no-console
    console.debug("[TradeButton] canExecute inputs", {
      hasAddress: !!address,
      hasProvider: !!provider,
      hasQuote: !!quoteData,
      hasSwapData: !!swapData,
      hasTypedData: !!typedDataToSign,
      hasUserSignature: !!userSignature,
      isLoading,
      isSubmitting,
      isApproving,
      requiresTypedDataSignature,
      canExecute,
    });
  }

  // Show connection status and errors.
  // isInitializing covers the brief silent "do we already have an
  // authorized wallet?" check on first mount - it must never be confused
  // with isConnecting (which only reflects an explicit user-clicked
  // Connect in progress), or refreshing the page would flash the
  // WalletSelector / "Connecting..." UI before settling.
  if (!isHydrated || isInitializing) {
    return (
      <div style={{ textAlign: "center", padding: "2rem" }}>
        <div className="animate-spin w-8 h-8 border-2 border-[#f0b90b] border-t-transparent rounded-full mx-auto mb-2"></div>
        <p className="text-xs text-[#64748b]">Checking wallet connection...</p>
      </div>
    );
  }

  if (isConnecting) {
    return (
      <div style={{ textAlign: "center", padding: "2rem" }}>
        <div className="animate-spin w-8 h-8 border-2 border-[#f0b90b] border-t-transparent rounded-full mx-auto mb-2"></div>
        <p className="text-xs text-[#64748b]">Connecting to wallet...</p>
      </div>
    );
  }

  // If there's an error and we're not connecting, show wallet selector instead of just error
  if (error && !isConnecting) {
    return (
      <div style={{ textAlign: "center", padding: "2rem" }}>
        <WalletSelector
          isConnecting={isConnecting}
          error={error}
          walletConnectAvailable={walletConnectAvailable}
          onConnect={connect}
        />
      </div>
    );
  }

  // If not connected and no error, show wallet selector to help user connect
  if (!isConnected) {
    return (
      <div style={{ textAlign: "center", padding: "2rem" }}>
        <WalletSelector
          isConnecting={isConnecting}
          error={error}
          walletConnectAvailable={walletConnectAvailable}
          onConnect={connect}
        />
      </div>
    );
  }

  const handleNetworkSwitch = async () => {
    setIsSwitchingNetwork(true);
    try {
      await switchToBscMainnet();
    } finally {
      setIsSwitchingNetwork(false);
    }
  };

  return (
    <div style={{ border: "1px solid #374151", borderRadius: "0.5rem", padding: "1rem", margin: "0.5rem 0" }}>
      <NetworkSwitchModal
        open={isConnected && !isCorrectNetwork}
        isSwitching={isSwitchingNetwork}
        onSwitch={handleNetworkSwitch}
        onClose={() => undefined}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <h3 style={{ margin: 0, fontSize: "1.125rem" }}>Trade {token.symbol}</h3>
        <span style={{ fontSize: "0.875rem", color: isConnected ? "#10b981" : "#ef4444" }}>
          {isConnected ? "Connected" : "Disconnected"}
        </span>
      </div>

      <div style={{ fontSize: "0.875rem", color: "#9ca3af", marginBottom: "0.5rem" }}>
        Wallet: {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Not connected"}
      </div>
      {!isCorrectNetwork && (
        <div style={{ marginBottom: "0.75rem", padding: "0.5rem 0.75rem", borderRadius: "0.5rem", backgroundColor: "#7f1d1d", color: "#fecaca", fontSize: "0.75rem", fontWeight: 700 }}>
          Unsupported network detected. Switch to Binance Smart Chain Mainnet before trading.
        </div>
      )}

      {/* USDT Amount Input */}
      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.25rem" }}>
          USDT Amount
        </label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            type="text"
            inputMode="decimal"
            value={usdtAmount}
            onChange={handleUsdtAmountChange}
            placeholder="Enter USDT amount"
            disabled={isLoading || isApproving || isSubmitting || executionPending}
            style={{
              flex: 1,
              padding: "0.5rem",
              borderRadius: "0.25rem",
              border: "1px solid #374151",
              backgroundColor: "#1f2937",
              color: "white",
              fontSize: "0.875rem"
            }}
          />
          <button
            onClick={fetchQuote}
            disabled={isLoading || !isConnected || !isValidUsdtAmount(usdtAmount) || executionPending}
            style={{
              backgroundColor: isLoading || !isConnected || !isValidUsdtAmount(usdtAmount) || executionPending ? "#374151" : "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: "0.25rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: (isLoading || !isConnected || !isValidUsdtAmount(usdtAmount) || executionPending) ? "not-allowed" : "pointer"
            }}
          >
            {isLoading ? "Fetching..." : "Get Quote"}
          </button>
        </div>
        {quoteError && (
          <div style={{
            backgroundColor: "#7f1d1d",
            color: "#fecaca",
            borderRadius: "0.25rem",
            padding: "0.5rem",
            fontSize: "0.75rem",
            marginTop: "0.5rem"
          }}>
            {quoteError}
          </div>
        )}
      </div>

      {/* Quote Details */}
      {quoteData && (
        <div style={{ backgroundColor: "#1f2937", borderRadius: "0.25rem", padding: "0.75rem", marginBottom: "0.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>Quote Details</div>
          <div style={{ fontSize: "0.875rem", fontFamily: "monospace", marginBottom: "0.25rem" }}>
            Quote ID: {quoteData.quoteId}
          </div>
          <div style={{ fontSize: "0.875rem", marginBottom: "0.25rem" }}>
            {quoteData.fromTokenAmount} USDT → {quoteData.toTokenAmount} {token.symbol}
          </div>
          {quoteData.priceImpactPercent !== undefined && (
            <div style={{ fontSize: "0.75rem", color: "#fbbf24", marginTop: "0.25rem" }}>
              Price Impact: {quoteData.priceImpactPercent}%
            </div>
          )}
          {quoteAgeSeconds !== null && (
            <div style={{ fontSize: "0.75rem", color: quoteIsFresh ? "#9ca3af" : "#fbbf24", marginTop: "0.25rem" }}>
              Quote age: {quoteAgeSeconds}s {quoteIsFresh ? "· fresh" : "· stale — refresh before signing"}
            </div>
          )}
          {swapData && swapData.executionMode && (
            <div style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
              Execution Mode: {swapData.executionMode}
            </div>
          )}
          {swapData?.executionMode === "SWAP" && swapData.tx?.to && (
            <div style={{ fontSize: "0.75rem", marginTop: "0.25rem", wordBreak: "break-all" }}>
              Transaction destination: {swapData.tx.to}
            </div>
          )}
          {swapSimulation && <SimulationSummary title="Binance transaction preflight" result={swapSimulation} />}
          {swapData && swapData.rfq && swapData.rfq.vendor && (
            <div style={{ fontSize: "0.75rem", marginTop: "0.125rem" }}>
              Vendor: {swapData.rfq.vendor}
            </div>
          )}
        </div>
      )}

      {/* Approval Section (if needed) */}
      {approvalData && !isApproving && (
        <div style={{ backgroundColor: "#1f2937", borderRadius: "0.25rem", padding: "0.75rem", marginBottom: "0.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>Approval Required</div>
          <p style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.5rem" }}>
            To trade {token.symbol}, you need to approve the USDT token for spending by the trading contract.
          </p>
          <p style={{ fontSize: "0.75rem", color: "#fbbf24", marginBottom: "0.5rem", wordBreak: "break-all" }}>
            Spender: {approvalData.spender} · Allowance: {usdtAmount} USDT
          </p>
          {approvalSimulation && <SimulationSummary title="Approval preflight" result={approvalSimulation} />}
          <button
            onClick={handleApprove}
            disabled={isApproving}
            style={{
              backgroundColor: isApproving ? "#374151" : "#10b981",
              color: "white",
              border: "none",
              borderRadius: "0.25rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: isApproving ? "not-allowed" : "pointer"
            }}
          >
            {isApproving ? "Approving..." : "Approve USDT"}
          </button>
          {approvalError && (
            <div style={{
              backgroundColor: "#7f1d1d",
              color: "#fecaca",
              borderRadius: "0.25rem",
              padding: "0.5rem",
              fontSize: "0.75rem",
              marginTop: "0.5rem"
            }}>
              {approvalError}
            </div>
          )}
        </div>
      )}

      {approvalError && !approvalData && !isApproving && (
        <div role="alert" style={{ backgroundColor: "#7f1d1d", color: "#fecaca", borderRadius: "0.25rem", padding: "0.5rem", fontSize: "0.75rem", marginTop: "0.5rem" }}>
          {approvalError}
        </div>
      )}

      {/* Approval in progress */}
      {isApproving && (
        <div style={{
          backgroundColor: "#1f2937",
          borderRadius: "0.25rem",
          padding: "0.75rem",
          marginBottom: "0.5rem",
          textAlign: "center"
        }}>
          <div style={{ fontSize: "0.875rem", color: "#6b7280" }}>Approving...</div>
        </div>
      )}

      {/* Typed Data to Sign */}
      {typedDataToSign && !approvalData && (
        <div style={{ backgroundColor: "#1f2937", borderRadius: "0.25rem", padding: "0.75rem", marginBottom: "0.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>EIP-712 Typed Data to Sign</div>
          <div style={{ fontSize: "0.75rem", color: "#d1d5db", fontFamily: "monospace", overflowX: "auto", maxHeight: "150px" }}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {JSON.stringify(typedDataToSign, null, 2)}
            </pre>
          </div>
          <button
            onClick={handleSign}
            disabled={isLoading || !!userSignature}
            style={{
              backgroundColor: !userSignature ? "#3b82f6" : "#374151",
              color: "white",
              border: "none",
              borderRadius: "0.25rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: !userSignature ? "pointer" : "not-allowed"
            }}
          >
            {!userSignature ? "Sign Typed Data" : "Signature Obtained"}
          </button>
          {userSignature && (
            <div style={{
              backgroundColor: "#064e3b",
              color: "#dcfce7",
              borderRadius: "0.25rem",
              padding: "0.5rem",
              fontSize: "0.75rem",
              marginTop: "0.5rem"
            }}>
              Signature obtained: {userSignature.substring(0, 66)}...
            </div>
          )}
          {submitError && (
            <div style={{
              backgroundColor: "#7f1d1d",
              color: "#fecaca",
              borderRadius: "0.25rem",
              padding: "0.5rem",
              fontSize: "0.75rem",
              marginTop: "0.5rem"
            }}>
              {submitError}
            </div>
          )}
        </div>
      )}

      {/* Submit Order Button.
          Rendered whenever we have a quote to act on, regardless of
          whether this quote requires typed-data signing - the typed-data
          panel above (when present) and canExecute together gate whether
          it's actually clickable. Previously this required
          !typedDataToSign, which meant the button was rendered ONLY in
          the case where canExecute's `!!typedDataToSign` term made it
          permanently false - i.e. the button could be visible but could
          never become enabled. */}
      {!approvalData && quoteData && swapData && (
        <div style={{ marginTop: "1rem" }}>
          {requiresFreshQuote && (
            <div role="status" style={{ backgroundColor: "#064e3b", color: "#dcfce7", borderRadius: "0.25rem", padding: "0.5rem", fontSize: "0.75rem", marginBottom: "0.5rem" }}>
              USDT approval confirmed. Get a fresh quote to continue the trade.
            </div>
          )}
          <button
            onClick={handleSubmitOrder}
            disabled={!canExecute || isSubmitting}
            style={{
              width: "100%",
              backgroundColor: canExecute && !isSubmitting ? "#10b981" : "#374151",
              color: "white",
              border: "none",
              borderRadius: "0.25rem",
              padding: "0.75rem",
              fontSize: "1rem",
              fontWeight: "600",
              cursor: canExecute && !isSubmitting ? "pointer" : "not-allowed"
            }}
          >
            {isSubmitting ? "Submitting..." : "Sign & Execute Trade"}
          </button>
          {submitError && (
            <div style={{
              backgroundColor: "#7f1d1d",
              color: "#fecaca",
              borderRadius: "0.25rem",
              padding: "0.5rem",
              fontSize: "0.75rem",
              marginTop: "0.5rem"
            }}>
              {submitError}
            </div>
          )}
        </div>
      )}

      {/* Transaction Status */}
      {transactionStatus && (
        <div style={{ backgroundColor: "#1f2937", borderRadius: "0.25rem", padding: "0.75rem", marginTop: "1rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>Transaction Status</div>
          <div style={{ fontSize: "0.875rem", marginBottom: "0.25rem" }}>
            Status: {transactionStatus.status}
          </div>
          {transactionStatus.orderId && (
            <div style={{ fontSize: "0.875rem", marginBottom: "0.25rem" }}>
              Order ID: {transactionStatus.orderId}
            </div>
          )}
          {transactionStatus.transactionHash && (
            <div style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.25rem"
            }}>
              <div style={{ fontSize: "0.875rem", fontFamily: "monospace", wordBreak: "break-all" }}>
                Transaction Hash: {transactionStatus.transactionHash}
              </div>
              <a
                href={`https://bscscan.com/tx/${transactionStatus.transactionHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: "0.75rem",
                  color: "#3b82f6",
                  textDecoration: "underline"
                }}
              >
                View on BSCScan
              </a>
            </div>
          )}
          {transactionStatus.status === "confirmed" && (
            <div style={{
              backgroundColor: "#064e3b",
              color: "#dcfce7",
              borderRadius: "0.25rem",
              padding: "0.5rem",
              fontSize: "0.75rem",
              marginTop: "0.5rem"
            }}>
              Transaction confirmed successfully!
            </div>
          )}
          {transactionStatus.status === "failed" && (
            <div style={{
              backgroundColor: "#7f1d1d",
              color: "#fecaca",
              borderRadius: "0.25rem",
              padding: "0.5rem",
              fontSize: "0.75rem",
              marginTop: "0.5rem"
            }}>
              Transaction failed.
            </div>
          )}
          {transactionStatus.status === "unverified" && (
            <div style={{
              backgroundColor: "#78350f",
              color: "#fef3c7",
              borderRadius: "0.25rem",
              padding: "0.5rem",
              fontSize: "0.75rem",
              marginTop: "0.5rem"
            }}>
              Confirmation could not be verified yet. Check BscScan before retrying.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
