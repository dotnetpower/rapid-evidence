/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      "/health": "http://localhost:8800",
      "/pool": "http://localhost:8800",
      "/batches": "http://localhost:8800",
      "/metrics": "http://localhost:8800",
      "/dashboard": "http://localhost:8800",
      "/run": "http://localhost:8800",
      "/events": "http://localhost:8800",
      "/scaling/timeline": "http://localhost:8800",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
