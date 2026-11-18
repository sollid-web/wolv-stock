import type { MetadataRoute } from "next";
import { getRWATokenList } from "@/lib/binance";
import { isSpotEligibleAsset } from "@/lib/compliance";
import { isRwaToken } from "@/lib/rwaTypes";

const BASE = "https://www.wolv.space";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const pages: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, lastModified: now, changeFrequency: "hourly", priority: 1 },
    { url: `${BASE}/markets`, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${BASE}/gap`, lastModified: now, changeFrequency: "hourly", priority: 0.8 },
    { url: `${BASE}/agent`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE}/trade`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
  ];
  try {
    const list = await getRWATokenList();
    const tokens: unknown[] = Array.isArray(list?.data) ? (list.data as unknown[]) : [];
    const assets = tokens.filter(isRwaToken).filter(isSpotEligibleAsset);
    const seen = new Set<string>();
    for (const token of assets) {
      const address = token.tokenContractAddress.toLowerCase();
      if (seen.has(address)) continue;
      seen.add(address);
      pages.push({ url: `${BASE}/stock/${address}`, lastModified: now, changeFrequency: "daily", priority: 0.5 });
    }
  } catch (error) {
    // The asset list is optional for the sitemap; core pages are always listed.
    console.error("Sitemap asset list unavailable:", error);
  }
  return pages;
}
