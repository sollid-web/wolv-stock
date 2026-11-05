import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const require = createRequire(import.meta.url)
const { loadEnvConfig } = require("@next/env") as typeof import("@next/env")

export function applyWorkerEnvironmentAliases(env: Record<string, string | undefined>): void {
    const chainId = env.CHAIN_ID ?? env.NEXT_PUBLIC_CHAIN_ID ?? env.NEXT_PUBLIC_BSC_CHAIN_ID
    if (chainId && !env.NEXT_PUBLIC_CHAIN_ID) {
        env.NEXT_PUBLIC_CHAIN_ID = chainId
    }

    if (
        chainId === "97"
        && env.RPC_URL
        && !env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL
    ) {
        env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL = env.RPC_URL
    }
}

export function loadWorkerEnvironment(projectDir = process.cwd()): void {
    loadEnvConfig(projectDir)

    const workerEnvPath = resolve(projectDir, ".env.worker")
    if (existsSync(workerEnvPath)) {
        if (typeof process.loadEnvFile !== "function") {
            throw new Error("Loading .env.worker requires Node.js 20.12.0 or newer.")
        }
        process.loadEnvFile(workerEnvPath)
    }

    applyWorkerEnvironmentAliases(process.env)
}
