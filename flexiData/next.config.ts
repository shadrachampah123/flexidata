import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Perceived performance: lean runtime, faster hydration
  compress: true,
  poweredByHeader: false,
  reactStrictMode: true,

  // Trim JS sent to the phone — lucide-react is large without this.
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
