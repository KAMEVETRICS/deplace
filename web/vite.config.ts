/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the board server runs on :8787; the web app proxies its API to it.
const API = ["/auth", "/me", "/bounties", "/specs", "/profiles", "/tx", "/admin", "/contract", "/agents", "/mcp", "/config"];

export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  server: { port: 5173, proxy: Object.fromEntries(API.map((p) => [p, "http://localhost:8787"])) },
  test: { include: ["test/**/*.test.tsx", "test/**/*.test.ts"] },
});
