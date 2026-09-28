import { ethers } from "ethers";

// Module-level reference to WalletConnect provider for transaction routing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wcProvider: any = null;

/**
 * Connect to user's wallet (MetaMask, WalletConnect, etc.)
 * @returns Promise with wallet provider or null if connection failed
 */
export async function connectWallet(): Promise<ethers.BrowserProvider | null> {
  // First, try to connect to injected wallets (MetaMask, Trust Wallet, etc.)
  if ((window as any).ethereum) {
    try {
      // Request account access
      await (window as any).ethereum.request({ method: "eth_requestAccounts" });
      const provider = new ethers.BrowserProvider((window as any).ethereum);

      // Ensure we're on BSC Mainnet (chain ID 56)
      const network = await provider.getNetwork();
      // Compare as strings to avoid bigint/number issues
      if (network.chainId.toString() !== "56") {
        try {
          await (window as any).ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x38" }], // 56 in hex
          });
        } catch (switchError: any) {
          // If the chain hasn't been added to MetaMask
          if (switchError.code === 4902) {
            try {
              await (window as any).ethereum.request({
                method: "wallet_addEthereumChain",
                params: [
                  {
                    chainId: "0x38",
                    chainName: "Binance Smart Chain Mainnet",
                    nativeCurrency: {
                      name: "BNB",
                      symbol: "BNB",
                      decimals: 18,
                    },
                    rpcUrls: ["https://bsc-dataseed.binance.org/"],
                    blockExplorerUrls: ["https://bscscan.com"],
                  },
                ],
              });
            } catch (addError) {
              console.error("Failed to add BSC network:", addError);
              return null;
            }
          } else {
            console.error("Failed to switch to BSC network:", switchError);
            return null;
          }
        }
      }

      return provider;
    } catch (error) {
      console.error("Failed to connect to injected wallet:", error);
      // Fall through to try WalletConnect
    }
  }

  // If no injected wallet or connection failed, try WalletConnect
  try {
    // Check if WalletConnect is available
    if (typeof window !== 'undefined') {
      // Check if WalletConnect project ID is configured
      if (!process.env.NEXT_PUBLIC_WALLET_PROJECT_ID) {
        console.error('WalletConnect project ID is not configured. Set NEXT_PUBLIC_WALLET_PROJECT_ID environment variable.');
        return null;
      }

      // Dynamically import WalletConnect Ethereum Provider to avoid SSR issues
      const WalletConnectProvider = (await import('@walletconnect/ethereum-provider')).default;

      // Initialize WalletConnect Provider with required options
      const walletConnectProvider = await WalletConnectProvider.init({
        projectId: process.env.NEXT_PUBLIC_WALLET_PROJECT_ID, // WalletConnect project ID from environment variable
        chains: [56], // BSC Mainnet
        optionalChains: [],
        rpcMap: {
          56: "https://bsc-dataseed.binance.org/"
        },
        showQrModal: true,
        // Optional: metadata for WalletConnect modal
        metadata: {
          name: "WOLv Stock Terminal",
          description: "WOLv Stock Terminal - Trade tokenized assets",
          url: "https://wolv-stock.vercel.app/", // TODO: replace with actual URL
          icons: ["https://wolv-stock.vercel.app/logo.png"],
        },
      });

      // Connect to WalletConnect (this will trigger the QR modal)
      await walletConnectProvider.connect();

      // Store raw WC provider so signTransaction can route through it
      wcProvider = walletConnectProvider;

      // Wrap the WalletConnect provider with ethers BrowserProvider
      const provider = new ethers.BrowserProvider(walletConnectProvider);
      return provider;
    }
  } catch (wcError) {
    console.error("Failed to connect via WalletConnect:", wcError);
    // Fall through to return null
  }

  // If we get here, no wallet connection method worked
  return null;
}

/**
 * Get the connected wallet's address
 * @param provider - Ethereum provider
 * @returns Promise with wallet address or null if not connected
 */
export async function getWalletAddress(
  provider: ethers.BrowserProvider
): Promise<string | null> {
  try {
    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    return address;
  } catch (error) {
    console.error("Failed to get wallet address:", error);
    return null;
  }
}

/**
 * Sign EIP-712 typed data (for RFQ signing)
 * @param provider - Ethereum provider
 * @param typedData - The EIP-712 typed data to sign
 * @returns Promise with signature or null if signing failed
 */
export async function signTypedData(
  provider: ethers.BrowserProvider,
  typedData: Record<string, any>
): Promise<string | null> {
  try {
    const signer = await provider.getSigner();
    const signature = await signer.signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message
    );
    return signature;
  } catch (error) {
    console.error("Failed to sign typed data:", error);
    return null;
  }
}

/**
 * Sign a transaction (for approval or other transactions)
 * @param provider - Ethereum provider
 * @param transaction - Transaction to sign
 * @param skipEstimateGas - Optional flag to skip gas estimation (for SWAP transactions)
 * @returns Promise with signed transaction or null if signing failed
 */
export async function signTransaction(
  provider: ethers.BrowserProvider,
  transaction: ethers.TransactionRequest,
  skipEstimateGas = false
): Promise<string | null> {
  try {
    const signer = await provider.getSigner();
    const address = await signer.getAddress();

    // --- DIAGNOSTIC: wallet connection context ---
    console.log("[DIAG] === signTransaction start ===");
    console.log("[DIAG] wcProvider initialized:", wcProvider !== null);
    console.log("[DIAG] window.ethereum exists:", !!(window as any).ethereum);
    console.log("[DIAG] wallet address:", address);

    // Create base transaction object for estimation and sending
    const baseTx = {
      from: address,
      to: transaction.to as string,
      data: transaction.data as string,
      value: transaction.value
        ? "0x" + BigInt(transaction.value.toString()).toString(16)
        : "0x0",
    };

    // --- DIAGNOSTIC: estimateGas stage ---
    // For SWAP mode, skip the mandatory estimateGas call because it throws
    // CALL_EXCEPTION before the wallet UI ever opens, blocking eth_sendTransaction.
    // The wallet will estimate gas internally when the user confirms the tx.
    let txParams: any[];

    if (skipEstimateGas) {
      console.log("[DIAG] estimateGas SKIPPED (skipEstimateGas=true for SWAP mode)");
      txParams = [{
        from: baseTx.from,
        to: baseTx.to,
        data: baseTx.data,
        value: baseTx.value,
      }];
    } else {
      console.log("[DIAG] estimateGas START");
      console.log("[DIAG] estimateGas input fields:", {
        from: baseTx.from,
        to: baseTx.to,
        dataLength: baseTx.data ? baseTx.data.length : 0,
        value: baseTx.value,
      });

      let gasLimit;
      try {
        gasLimit = await provider.estimateGas(baseTx);
        console.log("[DIAG] estimateGas SUCCESS:", gasLimit.toString());
      } catch (gasErr: any) {
        console.error("[DIAG] estimateGas FAILED:", gasErr);
        console.error("[DIAG] estimateGas error detail:", {
          message: gasErr?.message,
          code: gasErr?.code,
          name: gasErr?.name,
          stack: gasErr?.stack,
          nested: gasErr?.error ?? gasErr?.data ?? gasErr?.info,
        });
        throw gasErr;
      }

      // Create final transaction object with gas limit
      txParams = [{
        from: baseTx.from,
        to: baseTx.to,
        data: baseTx.data,
        value: baseTx.value,
        gas: "0x" + gasLimit.toString(16), // Convert to hex string
      }];
    }

    // --- DIAGNOSTIC: provider selection for eth_sendTransaction ---
    const requestProvider = wcProvider ?? (window as any).ethereum;
    console.log("[DIAG] requestProvider selected:", wcProvider !== null ? "WalletConnect provider" : "window.ethereum (injected)");
    console.log("[DIAG] requestProvider exists:", !!requestProvider);

    // --- DIAGNOSTIC: eth_sendTransaction stage ---
    console.log("[DIAG] eth_sendTransaction START");
    console.log("[DIAG] eth_sendTransaction params:", {
      from: txParams[0].from,
      to: txParams[0].to,
      dataLength: txParams[0].data ? txParams[0].data.length : 0,
      value: txParams[0].value,
      gas: txParams[0].gas,
    });

    const txHash = await requestProvider.request({
      method: "eth_sendTransaction",
      params: txParams,
    });
    console.log("[DIAG] eth_sendTransaction SUCCESS:", txHash);
    return txHash as string;
  } catch (error: any) {
    // --- DIAGNOSTIC: surface the real error instead of swallowing it ---
    console.error("[DIAG] signTransaction FAILED:", error);
    console.error("[DIAG] signTransaction error detail:", {
      message: error?.message,
      code: error?.code,
      name: error?.name,
      stack: error?.stack,
      nested: error?.error ?? error?.data ?? error?.info,
    });
    throw error;
  }
}

/**
 * Disconnect wallet (clear session)
 */
export function disconnectWallet(): void {
  // Note: MetaMask doesn't provide a direct disconnect method
  // We can only clear our internal state
  // The user would need to manually disconnect from wallet UI or change accounts
  window.localStorage.removeItem("walletAddress");
  // Also disconnect WalletConnect if applicable
  try {
    // This is a simplified approach - in a real app, you'd want to keep track of the WC connector
    // For now, we'll just clear the session storage that WalletConnect might use
    window.sessionStorage.removeItem('walletconnect');
  } catch (e) {
    // Ignore errors on disconnect
  }
  // Return void explicitly to avoid truthiness check issues
  return;
}
