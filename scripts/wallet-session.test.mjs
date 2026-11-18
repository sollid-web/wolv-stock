import assert from "node:assert/strict";
import test from "node:test";
import { connectedAddressFromWagmiStore, shortAddress } from "../lib/walletSession.ts";

const ADDRESS = "0xd9E7A9D64E12052d8E4E15Baeb5AF1C57c92eef0";
const store = (current, accounts = [ADDRESS]) => JSON.stringify({
  state: { connections: { __type: "Map", value: [["uid-1", { accounts, chainId: 56, connector: { id: "io.metamask" } }]] }, chainId: 56, current },
  version: 2,
});

test("reads the active account from wagmi's persisted store", () => {
  assert.equal(connectedAddressFromWagmiStore(store("uid-1")), ADDRESS);
});

test("returns null when disconnected, missing, or malformed", () => {
  assert.equal(connectedAddressFromWagmiStore(store(null)), null);
  assert.equal(connectedAddressFromWagmiStore(store("uid-2")), null);
  assert.equal(connectedAddressFromWagmiStore(store("uid-1", ["not-an-address"])), null);
  assert.equal(connectedAddressFromWagmiStore(null), null);
  assert.equal(connectedAddressFromWagmiStore("{bad json"), null);
  assert.equal(connectedAddressFromWagmiStore(JSON.stringify({ state: { current: "uid-1", connections: [] } })), null);
});

test("shortens addresses for display", () => {
  assert.equal(shortAddress(ADDRESS), "0xd9E7…eef0");
});
