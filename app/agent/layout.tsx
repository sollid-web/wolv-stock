import type { ReactNode } from "react";
import Providers from "@/app/providers";

export default function AgentLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
