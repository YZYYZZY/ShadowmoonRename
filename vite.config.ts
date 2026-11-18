import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 需要固定端口；packages/ 在工作区根目录，需放行上一级。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1427,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      allow: ["../.."],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
  },
});
