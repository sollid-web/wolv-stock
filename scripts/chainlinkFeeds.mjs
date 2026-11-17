// Official Chainlink EACAggregatorProxy addresses on BNB Smart Chain Testnet (chain 97).
// Source: Chainlink reference data directory (feeds-bsc-testnet.json), cross-checked on-chain
// (description(), aggregator(), fresh latestRoundData) on 2026-11-17. Re-verify against
// https://docs.chain.link/data-feeds/price-feeds/addresses before adding entries.
//
// A feed description string is NOT proof of authenticity: a self-deployed mock can return
// "BNB / USD". Guardian scripts therefore accept only pinned proxies.
import { getAddress, parseAbi } from "viem";

export const BSC_TESTNET_CHAINLINK_USD_FEEDS = Object.freeze({
  [getAddress("0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526")]: { pair: "BNB / USD", heartbeatSeconds: 3600 },
  [getAddress("0x143db3CEEfbdfe5631aDD3E50f7614B6ba708BA7")]: { pair: "ETH / USD", heartbeatSeconds: 86400 },
  [getAddress("0x5741306c21795FdCBb9b265Ea0255F499DFe515C")]: { pair: "BTC / USD", heartbeatSeconds: 86400 },
  [getAddress("0xEca2605f0BCF2BA5966372C99837b1F182d3D620")]: { pair: "USDT / USD", heartbeatSeconds: 86400 },
  [getAddress("0xE4eE17114774713d2De0eC0f035d4F7665fc025D")]: { pair: "DAI / USD", heartbeatSeconds: 86400 },
  [getAddress("0x1B329402Cb1825C6F30A0d92aB9E2862BE47333f")]: { pair: "LINK / USD", heartbeatSeconds: 86400 },
  [getAddress("0x81faeDDfeBc2F8Ac524327d70Cf913001732224C")]: { pair: "CAKE / USD", heartbeatSeconds: 86400 },
});

export const BSC_TESTNET_BNB_USD_FEED = getAddress("0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526");

const proxyAbi = parseAbi([
  "function description() view returns (string)",
  "function aggregator() view returns (address)",
]);

/**
 * Fail closed unless `feed` is a pinned official proxy whose on-chain description matches the
 * expected pair and which exposes a non-zero aggregator.
 */
export async function requirePinnedChainlinkFeed(publicClient, feedAddress, expectedPair) {
  const feed = getAddress(feedAddress);
  const pinned = BSC_TESTNET_CHAINLINK_USD_FEEDS[feed];
  if (!pinned) {
    throw new Error(`Feed ${feed} is not a pinned official Chainlink BSC Testnet proxy. Mock or self-deployed feeds are rejected.`);
  }
  if (expectedPair && pinned.pair !== expectedPair) {
    throw new Error(`Feed ${feed} is the ${pinned.pair} proxy, not ${expectedPair}.`);
  }
  const [description, aggregator] = await Promise.all([
    publicClient.readContract({ address: feed, abi: proxyAbi, functionName: "description" }),
    publicClient.readContract({ address: feed, abi: proxyAbi, functionName: "aggregator" }),
  ]);
  if (description.trim() !== pinned.pair || /mock/i.test(description)) {
    throw new Error(`Feed ${feed} reports "${description}", expected "${pinned.pair}".`);
  }
  if (!aggregator || /^0x0{40}$/i.test(aggregator)) {
    throw new Error(`Feed ${feed} has no underlying Chainlink aggregator.`);
  }
  return pinned;
}
