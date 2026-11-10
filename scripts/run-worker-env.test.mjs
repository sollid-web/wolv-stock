import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "./run-worker.mjs";

test("loads local environment values without overriding existing process values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wolv-worker-env-"));
  const file = path.join(dir, ".env.local");
  fs.writeFileSync(file, "BINANCE_API_KEY=local-key\nSUPABASE_SERVICE_ROLE_KEY='local-secret'\n# comment\n");
  const env = { BINANCE_API_KEY: "shell-key" };
  const loaded = loadEnvFile(file, env);
  assert.equal(loaded, 1);
  assert.equal(env.BINANCE_API_KEY, "shell-key");
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "local-secret");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("missing environment file is a safe no-op", () => {
  assert.equal(loadEnvFile("/path/that/does/not/exist", {}), 0);
});
