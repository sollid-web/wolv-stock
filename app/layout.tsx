import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const DESCRIPTION = "Compare reference and indicative prices for tokenized stocks on BNB Chain, with market context before user-controlled execution.";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.wolv.space"),
  title: { default: "WOLV — Tokenized Stocks, On-Chain Execution", template: "%s · WOLV" },
  description: DESCRIPTION,
  applicationName: "WOLV",
  openGraph: {
    type: "website",
    siteName: "WOLV",
    url: "/",
    title: "WOLV — Tokenized Stocks, On-Chain Execution",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "WOLV — Tokenized Stocks, On-Chain Execution",
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
