import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // NEXT_DIST_DIR lets staging builds avoid clearing the live in-place .next directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["better-sqlite3"],
  allowedDevOrigins: ["127.0.0.1"],
  // 线上 data/ 是 8.5G+ 的 live 数据库目录（含备份），output tracing 会误将其
  // 复制进 .next/standalone/data/ 导致部署时 ENOSPC；运行时 DB 走 DATA_DIR
  // 绝对路径，不依赖 trace 拷贝，因此全局排除。
  // 注意：instrumentation 的 trace 路由键是没有前导斜杠的 'instrumentation'，
  // '/*' 匹配不上，必须单独列键（对照 next 16.2.10 collect-build-traces 源码）。
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "./**/*.db", "./**/*.db-wal", "./**/*.db-shm"],
    instrumentation: [
      "./data/**/*",
      "./**/*.db",
      "./**/*.db-wal",
      "./**/*.db-shm",
    ],
  },
};

export default nextConfig;
