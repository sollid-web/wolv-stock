import type { Metadata } from "next";
import type { ReactNode } from "react";
import Providers from "@/app/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "WOLV — Tokenized Stocks, On-Chain Execution",
  description: "Compare reference and indicative prices for tokenized stocks on BNB Chain, with market context before user-controlled execution.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
