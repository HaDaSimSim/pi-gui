import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev: Vite(5173) 가 /api 와 /api/.../events(SSE) 를 백엔드(4317)로 프록시.
// SSE 는 버퍼링되면 안 되므로 프록시는 기본 패스스루(스트리밍 유지)로 둔다.
export default defineConfig({
  plugins: [react()],
  root: "web",
  server: {
    port: 5173,
    proxy: {
      // NOTE: key must be "/api/" (trailing slash), NOT "/api".
      // "/api" also matches the frontend's own `api.ts` module URL (`/api.ts`),
      // which Vite would then proxy to the backend → module 404 → white screen.
      // All real endpoints live under "/api/...", so "/api/" is the correct prefix.
      "/api/": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
  },
});
