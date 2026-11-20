import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Bundle the demo snapshot with the server functions (copied to /tmp on Vercel; see lib/db.ts).
  outputFileTracingIncludes: { "/**": ["./seed/**/*"] },
  // Pin the data folder to this project, no matter which directory the server is started from.
  env: { APP_DIR: __dirname },
};

export default nextConfig;
