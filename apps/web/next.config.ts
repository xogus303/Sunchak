import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  // pnpm 워크스페이스라 apps/web 밖(모노레포 루트)의 node_modules까지 추적해야 한다.
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;
