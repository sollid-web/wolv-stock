"use client";

import { useState, useEffect, useRef } from "react";
import { isValidUsdtAmount, meetsMinimumOrderAmount, MINIMUM_ORDER_USDT, usdtAmountToWei } from "@/lib/apiValidation";
import { useWallet, type WalletHookValue } from "@/hooks/useWallet";
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
  quoteBinding: string;
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
const ORDER_POLL_INTERVAL_MS = 5_000;
const MAX_ORDER_POLLS = 12;

type ExecutionPhase = "idle" | "signing" | "broadcasting" | "confirming" | "submitting";

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

function humanTransactionStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "pending": return "Waiting for confirmation";
    case "confirmed": return "Confirmed";
    case "failed": return "Failed";
    case "unverified": return "Needs verification";
    default: return status;
  }
}

function isFreshQuote(quote: QuoteData | null, now: number): boolean {
  return !!quote?.quoteFetchedAt && now - quote.quoteFetchedAt < QUOTE_TTL_MS;
}

function errorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error && error.message ? error.message : fallback;
  if (/unknown rpc|failed to publish payload|user rejected|user denied/i.test(message)) {
    return "Your wallet could not approve this request. Check that it is connected to BSC Mainnet, then try again.";
  }
  if (/timeout|temporarily unavailable|network request failed|fetch failed/i.test(message)) {
    return "The service is taking too long to respond. No transaction was sent; please try again.";
  }
  return message;
}

function displayTokenAmount(value: string | undefined): string {
  if (!value) return "—";
  try {
    const raw = BigInt(value);
    const scale = BigInt("1000000000000000000");
    const whole = raw / scale;
    const fraction = (raw % scale).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
    return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
  } catch {
    return value;
  }
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
      <div className="font-medium">{title}: {result.status}</div>
      <div style={{ marginTop: "0.25rem" }}>Preflight passed. No transaction has been sent yet.</div>
      <details style={{ marginTop: "0.35rem", color: "#a7f3d0" }}>
        <summary style={{ cursor: "pointer" }}>Technical details</summary>
        <div style={{ marginTop: "0.35rem" }}>
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
      </details>
    </div>
  );
}

export default function TradeButton({ token }: { token: TokenInfo }) {
  const wallet = useWallet();
  return <TradeSession key={`${token.address}:${wallet.address ?? ""}`} token={token} wallet={wallet} />;
}

function TradeSession({ token, wallet }: { token: TokenInfo; wallet: WalletHookValue }) {
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
    disconnect,
    switchToBscMainnet,
    signTypedData,
    signTransaction,
    broadcastTransaction,
    waitForTransaction,
  } = wallet;

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
  const [executionPhase, setExecutionPhase] = useState<ExecutionPhase>("idle");
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
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

    if (!meetsMinimumOrderAmount(usdtAmount)) {
      setQuoteError(`The minimum order is ${MINIMUM_ORDER_USDT} USDT (approximately $${MINIMUM_ORDER_USDT}).`);
      return;
    }

    setIsLoading(true);
    setQuoteError(null);
    setQuoteData(null);
    setQuoteNow(0);
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
    setExecutionPhase("idle");

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
      if (typeof quoteResult?.quoteBinding !== "string" || !quoteResult.quoteBinding) {
        throw new Error("Quote failed — no server quote binding returned. Refresh and retry.");
      }

      const quoteFetchedAt = typeof quoteResult?.quoteFetchedAt === "number" ? quoteResult.quoteFetchedAt : 0;
      const nextQuoteData = { ...quoteResult, quoteId: rawQuoteId, quoteFetchedAt } as QuoteData;
      setQuoteData(nextQuoteData);
      setQuoteNow(quoteFetchedAt);
      quoteIdRef.current = rawQuoteId;

      const executionMode = quoteResult?.executionMode ?? quoteResult?.data?.executionMode;
      if (executionMode === "SWAP") {
        if (await checkApproval(amountInWei, undefined, nextQuoteData)) return;
      } else if (executionMode === "RFQ") {
        const vendorName = quoteResult?.vendorName ?? quoteResult?.data?.vendorName;
        if (typeof vendorName !== "string" || !vendorName) {
          throw new Error("RFQ quote is missing the vendor name required for approval");
        }
        if (await checkApproval(amountInWei, vendorName, nextQuoteData)) return;
      } else {
        throw new Error("Quote returned an unsupported execution mode");
      }

      // Get swap details
      const swapParams = new URLSearchParams({
        toToken: token.address,
        amount: amountInWei,
        userWalletAddress: address ?? "",
        quoteId: rawQuoteId,
        quoteBinding: quoteResult.quoteBinding,
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
    } catch (error: unknown) {
      setQuoteError(errorMessage(error, "Failed to fetch quote"));
      console.error("Trade error:", error);
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

    if (!quoteData || !isFreshQuote(quoteData, quoteNow)) {
      setRequiresFreshQuote(true);
      setSubmitError("This price has expired. Get a fresh quote before signing.");
      return;
    }

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
    } catch (error: unknown) {
      setSubmitError(errorMessage(error, "Failed to sign typed data"));
    }
  };

  // Check if approval is needed and get approval transaction data
  const checkApproval = async (amount?: string, vendor?: string, quote?: QuoteData): Promise<boolean> => {
    if (!isConnected || !provider || !token.address || !usdtAmount) {
      setApprovalError("Connect a wallet and enter a USDT amount before checking approval");
      return true;
    }

    setIsApproving(true);
    setApprovalError(null);
    setApprovalData(null);

    try {
      const activeQuote = quote ?? quoteData;
      if (!activeQuote?.quoteId || !activeQuote.quoteBinding) {
        throw new Error("Get a fresh quote before checking approval");
      }
      // Convert USDT amount to wei (18 decimals)
      const amountInWei = amount ?? usdtAmountToWei(usdtAmount);
      const params = new URLSearchParams({
        tokenContractAddress: "0x55d398326f99059ff775485246999027b3197955",
        toToken: token.address,
        approveAmount: amountInWei,
        userWalletAddress: address ?? "",
        quoteId: activeQuote.quoteId,
        quoteBinding: activeQuote.quoteBinding,
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
    } catch (error: unknown) {
      setApprovalError(errorMessage(error, "Failed to get approval transaction"));
      console.error("Approval error:", error);
      return true;
    } finally {
      setIsApproving(false);
    }
  };

  // Sign and submit approval transaction
  const handleApprove = async () => {
    if (!approvalData || !provider) return;

    if (!quoteData || !isFreshQuote(quoteData, quoteNow)) {
      setRequiresFreshQuote(true);
      setApprovalError("This quote has expired. Get a fresh quote before approving anything.");
      return;
    }

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
    } catch (error: unknown) {
      setApprovalError(errorMessage(error, "Failed to submit approval transaction"));
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
        setExecutionPhase("signing");
        const signedTransaction = await signTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          gas: tx.gas,
          gasPrice: tx.gasPrice,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        });
        if (!signedTransaction) throw new Error("Wallet did not sign the swap transaction");
        setExecutionPhase("broadcasting");
        const transactionHash = await broadcastTransaction(signedTransaction);
        if (!transactionHash) throw new Error("Binance did not return a transaction hash for the swap");

        setTransactionStatus({
          status: "pending",
          transactionHash,
        });
        setExecutionPhase("confirming");
        void waitForTransaction(transactionHash).then((receiptStatus) => {
          setTransactionStatus((current) =>
            current?.transactionHash === transactionHash
              ? { ...current, status: receiptStatus }
              : current
          );
          setExecutionPhase("idle");
        });
      } catch (error: unknown) {
        setSubmitError(errorMessage(error, "Failed to submit swap transaction"));
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
    setExecutionPhase("submitting");

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
          toToken: token.address,
          amount: usdtAmountToWei(usdtAmount),
          userWalletAddress: address,
          quoteBinding: quoteData.quoteBinding,
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
      setExecutionPhase("confirming");

      startPollingTransactionStatus(order.orderId);

    } catch (error: unknown) {
      setSubmitError(errorMessage(error, "Failed to submit order"));
      console.error("Order submission error:", error);
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

    let pollCount = 0;

    // Set up bounded polling every 5 seconds. A pending order must not leave
    // the UI in an indefinite confirmation state when an upstream indexer is
    // delayed or unavailable.
    const interval = setInterval(async () => {
      pollCount += 1;
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
          setExecutionPhase("idle");
        } else if (pollCount >= MAX_ORDER_POLLS) {
          clearInterval(interval);
          if (pollIntervalRef.current === interval) pollIntervalRef.current = null;
          setTransactionStatus((current) => current?.orderId === orderId
            ? { ...current, status: "unverified" }
            : current);
          setExecutionPhase("idle");
        }
      } catch (err) {
        console.error("Error polling transaction status:", err);
        if (pollCount >= MAX_ORDER_POLLS) {
          clearInterval(interval);
          if (pollIntervalRef.current === interval) pollIntervalRef.current = null;
          setTransactionStatus((current) => current?.orderId === orderId
            ? { ...current, status: "unverified" }
            : current);
          setExecutionPhase("idle");
        }
      }
    }, ORDER_POLL_INTERVAL_MS);

    pollIntervalRef.current = interval;
  };

  // A manual recovery check is read-only: it never signs, broadcasts, or
  // resubmits an order. This gives the user a safe path after a timeout.
  const handleRefreshStatus = async () => {
    if (!transactionStatus?.transactionHash && !transactionStatus?.orderId) return;

    setIsRefreshingStatus(true);
    setSubmitError(null);
    try {
      if (transactionStatus.orderId) {
        const response = await fetch(`/api/order/${encodeURIComponent(transactionStatus.orderId)}`, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || "Order status lookup failed");
        const order = result?.data;
        if (!order || typeof order.status !== "string") throw new Error("Order status response is missing its status");
        const status = order.status.toUpperCase();
        setTransactionStatus((current) => {
          if (!current || current.orderId !== transactionStatus.orderId) return current;
          return {
            ...current,
            status: ["FILLED", "FAILED"].includes(status) ? displayOrderStatus(status) : "unverified",
            transactionHash: order.txHash ?? current.transactionHash,
          };
        });
      } else if (transactionStatus.transactionHash) {
        const response = await fetch(`/api/transaction-status?txHash=${encodeURIComponent(transactionStatus.transactionHash)}`, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || "Transaction status lookup failed");
        const status = result.status === "success" ? "confirmed" : result.status === "reverted" ? "failed" : "unverified";
        setTransactionStatus((current) => current?.transactionHash === transactionStatus.transactionHash
          ? { ...current, status }
          : current);
      }
    } catch (error: unknown) {
      setSubmitError(errorMessage(error, "Status lookup is temporarily unavailable"));
    } finally {
      setIsRefreshingStatus(false);
    }
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

  useEffect(() => {
    const quoteFetchedAt = quoteData?.quoteFetchedAt;
    if (!quoteFetchedAt) return;

    const startedAt = Date.now();
    const updateQuoteClock = () => setQuoteNow(quoteFetchedAt + Date.now() - startedAt);
    const interval = setInterval(updateQuoteClock, 1000);
    document.addEventListener("visibilitychange", updateQuoteClock);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", updateQuoteClock);
    };
  }, [quoteData?.quoteFetchedAt]);

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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
        <h3 style={{ margin: 0, fontSize: "1.125rem" }}>Trade {token.symbol}</h3>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "0.875rem", color: isConnected ? "#10b981" : "#ef4444" }}>
            {isConnected ? "Connected" : "Disconnected"}
          </span>
          <button
            type="button"
            onClick={disconnect}
            aria-label="Disconnect wallet"
            style={{
              background: "transparent",
              border: "1px solid #4b5563",
              borderRadius: "0.35rem",
              color: "#cbd5e1",
              padding: "0.35rem 0.5rem",
              fontSize: "0.7rem",
              cursor: "pointer",
            }}
          >
            Disconnect
          </button>
        </div>
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
            disabled={isLoading || !isConnected || !isValidUsdtAmount(usdtAmount) || !meetsMinimumOrderAmount(usdtAmount) || executionPending}
            style={{
              backgroundColor: isLoading || !isConnected || !isValidUsdtAmount(usdtAmount) || !meetsMinimumOrderAmount(usdtAmount) || executionPending ? "#374151" : "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: "0.25rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: (isLoading || !isConnected || !isValidUsdtAmount(usdtAmount) || !meetsMinimumOrderAmount(usdtAmount) || executionPending) ? "not-allowed" : "pointer"
            }}
          >
            {isLoading ? "Fetching..." : "Get Quote"}
          </button>
        </div>
        {isValidUsdtAmount(usdtAmount) && !meetsMinimumOrderAmount(usdtAmount) && (
          <div role="status" style={{ color: "#fbbf24", fontSize: "0.75rem", marginTop: "0.5rem" }}>
            Minimum order: {MINIMUM_ORDER_USDT} USDT (approximately ${MINIMUM_ORDER_USDT}).
          </div>
        )}
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
          <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>Your trade quote</div>
          <div style={{ fontSize: "0.875rem", marginBottom: "0.25rem" }}>
            {displayTokenAmount(quoteData.fromTokenAmount)} USDT → approximately {displayTokenAmount(quoteData.toTokenAmount)} {token.symbol}
          </div>
          {quoteData.priceImpactPercent !== undefined && (
            <div style={{ fontSize: "0.75rem", color: "#fbbf24", marginTop: "0.25rem" }}>
              Price Impact: {quoteData.priceImpactPercent}%
            </div>
          )}
          {quoteAgeSeconds !== null && (
            <div role="status" style={{ fontSize: "0.75rem", color: quoteIsFresh ? "#9ca3af" : "#fbbf24", marginTop: "0.25rem" }}>
              {quoteIsFresh ? `Price locked for about ${Math.max(0, Math.ceil((QUOTE_TTL_MS - quoteAgeSeconds * 1000) / 1000))} more seconds.` : "This price has expired. Get a fresh quote before continuing."}
              {!quoteIsFresh && (
                <button type="button" onClick={fetchQuote} disabled={isLoading} style={{ display: "block", marginTop: "0.5rem", backgroundColor: "#f0b90b", color: "#111827", border: "none", borderRadius: "0.25rem", padding: "0.5rem 0.75rem", fontWeight: 700, cursor: isLoading ? "not-allowed" : "pointer" }}>
                  {isLoading ? "Getting fresh price…" : "Get fresh quote"}
                </button>
              )}
            </div>
          )}
          {swapData?.executionMode && (
            <details style={{ fontSize: "0.7rem", marginTop: "0.35rem", color: "#94a3b8" }}>
              <summary style={{ cursor: "pointer" }}>Show route details</summary>
              <div style={{ marginTop: "0.25rem" }}>Execution route: {swapData.executionMode}</div>
              {swapData.executionMode === "SWAP" && swapData.tx?.to && <div style={{ wordBreak: "break-all" }}>Transaction destination: {swapData.tx.to}</div>}
              {swapData.rfq?.vendor && <div>Liquidity provider: {swapData.rfq.vendor}</div>}
            </details>
          )}
          {swapSimulation && <SimulationSummary title="Binance transaction preflight" result={swapSimulation} />}
        </div>
      )}

      {/* Approval Section (if needed) */}
      {approvalData && quoteIsFresh && !isApproving && (
        <div style={{ backgroundColor: "#1f2937", borderRadius: "0.25rem", padding: "0.75rem", marginBottom: "0.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>Approval Required</div>
          <p style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.5rem" }}>
            To buy {token.symbol}, your wallet needs permission to use up to {usdtAmount} USDT. You stay in control and must approve this in your wallet.
          </p>
          <p style={{ fontSize: "0.75rem", color: "#fbbf24", marginBottom: "0.5rem" }}>
            Approval limit: {usdtAmount} USDT
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
          <p style={{ fontSize: "0.75rem", color: "#9ca3af", margin: "0.35rem 0 0.5rem" }}>
            Your wallet will show the exact order details before you approve the signature. This does not send funds by itself.
          </p>
          <details style={{ fontSize: "0.7rem", color: "#94a3b8", marginBottom: "0.5rem" }}>
            <summary style={{ cursor: "pointer" }}>Show technical signing data</summary>
            <pre style={{ margin: "0.35rem 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "150px", overflowY: "auto" }}>
              {JSON.stringify(typedDataToSign, null, 2)}
            </pre>
          </details>
          <button
            onClick={handleSign}
            disabled={isLoading || !!userSignature || !quoteIsFresh}
            style={{
              backgroundColor: !userSignature && quoteIsFresh ? "#3b82f6" : "#374151",
              color: "white",
              border: "none",
              borderRadius: "0.25rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: !userSignature && quoteIsFresh ? "pointer" : "not-allowed"
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
            {isSubmitting ? (executionPhase === "submitting" ? "Submitting order..." : "Executing...") : "Sign & Execute Trade"}
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
      {(transactionStatus || executionPhase !== "idle") && (
        <div style={{ backgroundColor: "#1f2937", borderRadius: "0.25rem", padding: "0.75rem", marginTop: "1rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>Transaction Status</div>
          {executionPhase !== "idle" && (
            <div role="status" style={{ fontSize: "0.875rem", color: "#f0b90b", marginBottom: "0.25rem" }}>
              {executionPhase === "signing" && "Waiting for wallet signature..."}
              {executionPhase === "broadcasting" && "Broadcasting signed transaction through Binance..."}
              {executionPhase === "submitting" && "Submitting signed RFQ order..."}
              {executionPhase === "confirming" && "Waiting for Binance/on-chain confirmation..."}
            </div>
          )}
          <div style={{ fontSize: "0.875rem", marginBottom: "0.25rem" }}>
              Status: {humanTransactionStatus(transactionStatus?.status ?? executionPhase)}
          </div>
          {transactionStatus?.orderId && (
            <details style={{ fontSize: "0.7rem", color: "#94a3b8", marginBottom: "0.25rem" }}>
              <summary style={{ cursor: "pointer" }}>Show order reference</summary>
              <div style={{ marginTop: "0.25rem", wordBreak: "break-all" }}>{transactionStatus.orderId}</div>
            </details>
          )}
          {transactionStatus?.transactionHash && (
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
          {transactionStatus?.status === "confirmed" && (
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
          {transactionStatus?.status === "failed" && (
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
          {transactionStatus?.status === "unverified" && (
            <div style={{
              backgroundColor: "#78350f",
              color: "#fef3c7",
              borderRadius: "0.25rem",
              padding: "0.5rem",
              fontSize: "0.75rem",
              marginTop: "0.5rem"
            }}>
              Confirmation could not be verified yet. Check BscScan before retrying. You can safely refresh status below; this will not sign or rebroadcast the trade.
              <button
                type="button"
                onClick={handleRefreshStatus}
                disabled={isRefreshingStatus}
                style={{
                  display: "block",
                  marginTop: "0.5rem",
                  backgroundColor: isRefreshingStatus ? "#92400e" : "#f59e0b",
                  color: "#1c1917",
                  border: "none",
                  borderRadius: "0.25rem",
                  padding: "0.4rem 0.65rem",
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  cursor: isRefreshingStatus ? "not-allowed" : "pointer"
                }}
              >
                {isRefreshingStatus ? "Refreshing status…" : "Refresh status"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
