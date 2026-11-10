#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function loadEnvFile(filePath = ".env.local", env = process.env) {
  if (!fs.existsSync(filePath)) return 0;
  let loaded = 0;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && env[match[1]] === undefined) {
      env[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
      loaded += 1;
    }
  }
  return loaded;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const target = process.argv[2];
  if (!target || !/^worker\/[a-zA-Z0-9._-]+\.ts$/.test(target)) {
    console.error("Usage: node scripts/run-worker.mjs worker/<worker-file>.ts");
    process.exitCode = 2;
  } else {
    loadEnvFile(".env");
    loadEnvFile(".env.local");
    await import(pathToFileURL(resolve(process.cwd(), target)).href);
  }
}
