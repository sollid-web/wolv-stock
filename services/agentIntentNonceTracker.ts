import { randomBytes } from "node:crypto";
import { getAddress, toHex, type Address, type Hex } from "viem";

export class AgentIntentNonceError extends Error {
    readonly cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = "AgentIntentNonceError";
        this.cause = cause;
    }
}

/**
 * Generate a cryptographically random EIP-712 nonce.
 *
 * The validator stores every consumed nonce on-chain, so a monotonic Redis
 * counter is unnecessary. A 256-bit CSPRNG nonce avoids an external runtime
 * dependency and remains replay-protected by the contract.
 */
export async function getNextIntentNonce(smartAccount: Address): Promise<Hex> {
    try {
        getAddress(smartAccount);
        return toHex(randomBytes(32));
    } catch (error) {
        throw new AgentIntentNonceError("Could not generate a valid intent nonce.", error);
    }
}

export async function closeIntentNonceTracker(): Promise<void> {
    // Kept as a no-op for graceful compatibility with existing worker shutdown.
}
