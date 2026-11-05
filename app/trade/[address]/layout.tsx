import type { ReactNode } from "react";
import Providers from "@/app/providers";

export default function TradeAssetLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
