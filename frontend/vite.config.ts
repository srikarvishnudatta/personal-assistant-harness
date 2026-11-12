import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Backend address only; never load backend credentials into Vite's environment.
const backend = process.env.HARNESS_API_ORIGIN || "http://127.0.0.1:8787";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/oauth": { target: backend, changeOrigin: true },
      "/health": { target: backend, changeOrigin: true },
    },
  },
});
