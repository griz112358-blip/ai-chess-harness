import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 前端构建配置。
 * - 开发：vite dev server（默认 5178），把 /api 代理到本地后端 8787；
 * - 构建：产物输出到 apps/chess/web/dist，由后端直接托管（npm start 即可单进程访问）。
 */
export default defineConfig({
  root: resolve(here, "web"),
  plugins: [react()],
  server: {
    port: Number(process.env["PORT"] ?? 5178),
    proxy: {
      // VITE_API_TARGET 可以把前端指向别的后端（比如本地 mock 实例）
      "/api": {
        target: process.env["VITE_API_TARGET"] ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(here, "web", "dist"),
    emptyOutDir: true,
  },
});
