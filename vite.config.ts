import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// dev: Vite(5173) 가 /api 와 /api/.../events(SSE) 를 백엔드(4317)로 프록시.
// SSE 는 버퍼링되면 안 되므로 프록시는 기본 패스스루(스트리밍 유지)로 둔다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "web",
  resolve: {
    // shadcn 표준 alias. 소스가 web/ 에 있으므로 @/ → web/ 로 매핑.
    alias: {
      "@": fileURLToPath(new URL("./web", import.meta.url)),
    },
  },
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
      // WebSocket 이벤트 버스(/ws) 프록시. ws:true 가 없으면 업그레이드가 안 된다.
      "/ws": {
        target: "http://127.0.0.1:4317",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 벤더 청크 분리 (Rolldown 은 함수 형태만 허용).
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (id.includes("/react-dom/") || id.includes("/react/") || id.includes("/scheduler/")) return "react";
            if (
              id.includes("/unified/") ||
              id.includes("/remark-") ||
              id.includes("/rehype-") ||
              id.includes("/mdast") ||
              id.includes("/hast") ||
              id.includes("/micromark")
            )
              return "markdown";
          }
          return undefined;
        },
      },
    },
  },
});
