// Fork rehearsal of the first autonomous trade (enable mode + V2 hook + swap + verification).
//
// Runs the REAL AgentExecutor against a local anvil fork of BSC testnet. Only two things are
// substituted, and only on the fork:
//   1. The account's ECDSA owner slot is pointed at a throwaway key so this script can produce
//      the one-time Kernel enable signature (the real owner's key is never needed or used).
//   2. The bundler is replaced by a direct EntryPoint.handleOps call from an anvil account.
// Nothing is broadcast to a real network.
//
// Usage: anvil --fork-url <bsc-testnet-rpc> --chain-id 97 --port 8546
//        FORK_RPC_URL=http://127.0.0.1:8546 node --conditions=react-server \
//          --experimental-strip-types scripts/fork-agent-e2e.mjs
import { loadWorkerEnvironment } from "../worker/workerEnvironment.ts"

const FORK_RPC_URL = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8546"
loadWorkerEnvironment()
process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL = FORK_RPC_URL
process.env.NEXT_PUBLIC_CHAIN_ID = "97"

const {
    createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, formatUnits,
    getAddress, http, keccak256, pad, parseAbi, parseEventLogs
} = await import("viem")
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts")
const { bscTestnet } = await import("viem/chains")
const { entryPoint07Abi, getUserOperationHash, toPackedUserOperation } = await import("viem/account-abstraction")
const { getAgentSmartAccountConfig, createAgentSmartAccountClient } = await import("../lib/smartAccount.ts")
const { createOwnerValidatorFromAddress, getAgentSessionEnableTypedData, readKernelEcdsaOwner } = await import("../lib/agentPermission.ts")
const { AgentExecutor } = await import("../services/agentExecutor.ts")
const { hashAgentPolicy } = await import("../lib/agentPolicyHash.ts")

const ACCOUNT = getAddress(process.env.SMART_ACCOUNT_ADDRESS ?? "0x08c35E169B2b62800A62CE14eF11D9195E2502De")
const ECDSA_VALIDATOR = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57"
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"

const config = getAgentSmartAccountConfig()
const transport = http(FORK_RPC_URL)
const publicClient = createPublicClient({ chain: bscTestnet, transport })
const testClient = createTestClient({ chain: bscTestnet, mode: "anvil", transport })
const [relayer] = await testClient.request({ method: "eth_accounts" })
const relayerWallet = createWalletClient({ chain: bscTestnet, transport, account: relayer })

const agentKey = process.env.AGENT_PRIVATE_KEY
if (!agentKey) throw new Error("AGENT_PRIVATE_KEY is required")
const agent = privateKeyToAccount(agentKey.startsWith("0x") ? agentKey : `0x${agentKey}`)

// 1. Fork-only: replace the ECDSA owner with a throwaway key.
const forkOwner = privateKeyToAccount(generatePrivateKey())
const ownerSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ACCOUNT, 0n]))
await testClient.setStorageAt({ address: ECDSA_VALIDATOR, index: ownerSlot, value: pad(forkOwner.address) })
if (await readKernelEcdsaOwner(publicClient, ACCOUNT) !== forkOwner.address) throw new Error("fork owner override failed")

const hookAbi = parseAbi([
    "function getAccountPolicy(address) view returns (bool,bytes32,uint192,uint64,address)",
    "function getAccountRiskPolicy(address) view returns (uint64,uint16,uint16)",
    "function setAccountPolicy(address,address,bytes32,uint192,uint64,uint64,uint16,uint16)",
    "event AgentExecutionSucceeded(address indexed smartAccount, address indexed targetToken, uint256 value, uint256 amountOut, uint256 timestamp)",
])
const [configured, , maxTradeValue, expiresAt, intentSigner] = await publicClient.readContract({ address: config.policyHookAddress, abi: hookAbi, functionName: "getAccountPolicy", args: [ACCOUNT] })
const [entryPriceMicros, maxSlippageBps, maxPriceImpactBps] = await publicClient.readContract({ address: config.policyHookAddress, abi: hookAbi, functionName: "getAccountRiskPolicy", args: [ACCOUNT] })
if (!configured) throw new Error("policy not configured on hook")
if (getAddress(intentSigner) !== agent.address) throw new Error("intent signer mismatch")

// Fork-only: re-bind the SAME on-chain policy values to the throwaway owner (the V4 policy hash
// commits to the owner address), by impersonating the account for setAccountPolicy.
const STRATEGY_ID = "eth-testnet-1"
const AMOUNT_BNB = 10n ** 15n
const policyHash = hashAgentPolicy({
    strategyId: STRATEGY_ID, ownerAddress: forkOwner.address, account: ACCOUNT, targetToken: config.targetTokenAddress,
    maxTradeValue, expiresAt, intentSigner: agent.address, amountBnb: AMOUNT_BNB, entryPriceMicros,
    slippageBps: Number(maxSlippageBps), maxPriceImpactBps: Number(maxPriceImpactBps),
})
await testClient.impersonateAccount({ address: ACCOUNT })
await testClient.setBalance({ address: ACCOUNT, value: 10n ** 18n })
const rebind = await createWalletClient({ chain: bscTestnet, transport, account: ACCOUNT }).writeContract({
    address: config.policyHookAddress, abi: hookAbi, functionName: "setAccountPolicy",
    args: [ACCOUNT, agent.address, policyHash, maxTradeValue, expiresAt, entryPriceMicros, maxSlippageBps, maxPriceImpactBps],
})
await publicClient.waitForTransactionReceipt({ hash: rebind })
await testClient.stopImpersonatingAccount({ address: ACCOUNT })

// 2. One-time enable signature (fork owner), exactly as /agent requests it from the real owner.
const terms = { ...config, permissionValidUntil: expiresAt }
const { alreadyEnabled, typedData } = await getAgentSessionEnableTypedData(publicClient, {
    account: ACCOUNT, ownerAddress: forkOwner.address, agentSignerAddress: agent.address, targets: terms
})
const pluginEnableSignature = alreadyEnabled ? undefined : await forkOwner.signTypedData(typedData)
console.log("enable mode:", !alreadyEnabled)

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"])
const balanceBefore = await publicClient.readContract({ address: config.targetTokenAddress, abi: erc20, functionName: "balanceOf", args: [ACCOUNT] })

// 3. Bundler substitute: same UserOperation, submitted via EntryPoint.handleOps on the fork.
async function createForkAccountClient(...args) {
    const built = await createAgentSmartAccountClient(...args)
    const { account } = built
    const client = {
        ...built.client,
        client: publicClient,
        async sendUserOperation({ calls }) {
            const fees = await publicClient.estimateFeesPerGas()
            const userOperation = {
                sender: account.address,
                nonce: await account.getNonce(),
                callData: await account.encodeCalls(calls),
                callGasLimit: 1_000_000n,
                verificationGasLimit: 2_000_000n,
                preVerificationGas: 100_000n,
                maxFeePerGas: fees.maxFeePerGas,
                maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                signature: "0x",
            }
            userOperation.signature = await account.signUserOperation({ ...userOperation, chainId: 97 })
            const hash = getUserOperationHash({ userOperation, entryPointAddress: ENTRY_POINT, entryPointVersion: "0.7", chainId: 97 })
            // anvil's fork clock drifts behind wall-clock time; the real chain tracks it within ~1s.
            await testClient.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000)) })
            const tx = await relayerWallet.writeContract({
                address: ENTRY_POINT, abi: entryPoint07Abi, functionName: "handleOps",
                args: [[toPackedUserOperation(userOperation)], relayer], gas: 4_000_000n,
            })
            client.lastTx = tx
            return hash
        },
        async waitForUserOperationReceipt({ hash }) {
            const receipt = await publicClient.waitForTransactionReceipt({ hash: client.lastTx })
            console.log("fork handleOps tx", client.lastTx)
            const [event] = parseEventLogs({ abi: entryPoint07Abi, eventName: "UserOperationEvent", logs: receipt.logs })
                .filter(log => log.args.userOpHash === hash)
            if (!event) throw new Error(`UserOperationEvent missing; tx status ${receipt.status}`)
            return {
                userOpHash: hash, success: event.args.success, reason: event.args.success ? undefined : "reverted",
                actualGasUsed: event.args.actualGasUsed, actualGasCost: event.args.actualGasCost,
                logs: receipt.logs, receipt,
            }
        },
    }
    return { account, client }
}

// 4. Real executor, real quote/intent/hook path.
const now = Date.now()
const executor = new AgentExecutor({
    getConfig: () => config,
    isLiveEnabled: () => true,
    resolveAuthorization: async () => ({
        ownerValidator: await createOwnerValidatorFromAddress(publicClient, forkOwner.address),
        sessionKeySigner: agent,
        pluginEnableSignature,
    }),
    createAccountClient: createForkAccountClient,
    log: event => console.log(JSON.stringify(event, (_k, v) => typeof v === "bigint" ? v.toString() : v)),
    receiptTimeoutMs: 60_000,
})
const result = await executor.executeUserOperation({
    strategyId: STRATEGY_ID,
    ownerAddress: forkOwner.address,
    account: ACCOUNT,
    targetToken: config.targetTokenAddress,
    amountBnb: AMOUNT_BNB,
    amountOutMin: 1n,
    priceImpactBps: 0,
    slippageBps: Number(maxSlippageBps),
    maxPriceImpactBps: Number(maxPriceImpactBps),
    sourcePriceMicros: entryPriceMicros,
    entryPriceMicros,
    createdAt: new Date(now).toISOString(),
    policyHash,
})
const balanceAfter = await publicClient.readContract({ address: config.targetTokenAddress, abi: erc20, functionName: "balanceOf", args: [ACCOUNT] })
console.log("RESULT", JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v))
console.log("token balance", formatUnits(balanceBefore, 18), "->", formatUnits(balanceAfter, 18))
