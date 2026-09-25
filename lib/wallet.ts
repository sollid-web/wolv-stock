import { ethers } from "ethers";

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
 * @returns Promise with signed transaction or null if signing failed
 */
export async function signTransaction(
  provider: ethers.BrowserProvider,
  transaction: ethers.TransactionRequest
): Promise<string | null> {
  try {
    const signer = await provider.getSigner();
    const signedTx = await signer.signTransaction(transaction);
    return signedTx;
  } catch (error) {
    console.error("Failed to sign transaction:", error);
    return null;
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
