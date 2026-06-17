import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config for the read-only dashboard (PRD §4.6).
 *
 * In dev, `/api` is proxied to the `plugsmith serve` API (default port 4575) so
 * the SPA hits the same read-only core. Production build emits to `dist/`, which
 * `plugsmith serve` serves statically from `defaultWebRoot()`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4575",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
