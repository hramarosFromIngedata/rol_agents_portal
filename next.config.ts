import type { NextConfig } from "next";

// Single source of truth for the base path: used below for Next's own
// basePath/assetPrefix, and re-exposed as NEXT_PUBLIC_BASE_PATH so
// client-side code (fetch calls to our own API routes, plain <img> src
// attributes) can prefix itself the same way, since Next only auto-prefixes
// next/link, next/router and next/image — not raw fetch()/<img> strings.
const basePath = "/rol";

const nextConfig: NextConfig = {
  output: "standalone",
  basePath,
  assetPrefix: basePath,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
