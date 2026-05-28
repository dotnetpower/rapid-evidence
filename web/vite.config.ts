/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Proxy targets that ALSO have an SPA route (so browser navigations to
// `/batches/:id` must NOT be eaten by the proxy and sent to the backend
// as JSON). The bypass below lets HTML page loads fall through to the
// dev server's index.html so React Router can take over.
function htmlAwareBypass(req: { headers: Record<string, string | string[] | undefined>; method?: string }) {
  const accept = (req.headers["accept"] || req.headers["Accept"] || "") as string;
  if (req.method === "GET" && typeof accept === "string" && accept.includes("text/html")) {
    return "/index.html";
  }
  return null;
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      "/health": "http://localhost:8800",
      "/pool": "http://localhost:8800",
      "/batches": {
        target: "http://localhost:8800",
        bypass: htmlAwareBypass,
      },
      "/metrics": "http://localhost:8800",
      "/dashboard": "http://localhost:8800",
      "/run": "http://localhost:8800",
      "/events": "http://localhost:8800",
      "/scaling": {
        target: "http://localhost:8800",
        bypass: htmlAwareBypass,
      },
      "/quota": {
        target: "http://localhost:8800",
        bypass: htmlAwareBypass,
      },
      "/regions": {
        target: "http://localhost:8800",
        bypass: htmlAwareBypass,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
