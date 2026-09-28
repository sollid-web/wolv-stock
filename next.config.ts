import type { NextConfig } from "next";
import { resolve } from "path";

const nextConfig: NextConfig = {
  // Trace files from the project folder (works on the phone and on Vercel)
  outputFileTracingRoot: process.cwd(),
  webpack: (config) => {
    config.resolve.alias['@'] = resolve(process.cwd());
    return config;
  },
};

export default nextConfig;
