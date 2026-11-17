import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Trace files from the project folder (works on the phone and on Vercel)
  outputFileTracingRoot: process.cwd(),
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "onchainos.bnbstatic.com" },
      { protocol: "https", hostname: "public.bnbstatic.com" },
    ],
  },
  webpack(config) {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
