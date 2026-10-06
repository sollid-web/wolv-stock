import { existsSync } from "node:fs";
import { join } from "node:path";

export type PublicAssetDirectory =
  | "branding"
  | "companies"
  | "platforms"
  | "backgrounds"
  | "icons"
  | "illustrations";

const extensions = ["svg", "webp", "png", "jpg", "jpeg"] as const;

export function getPublicAssetPath(
  directory: PublicAssetDirectory,
  name: string
): string | undefined {
  const assetName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!assetName) return undefined;

  for (const extension of extensions) {
    const filePath = join(process.cwd(), "public", "assets", directory, `${assetName}.${extension}`);
    if (existsSync(filePath)) {
      return `/assets/${directory}/${assetName}.${extension}`;
    }
  }

  return undefined;
}
