import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// dev: Vite(5173) proxies /api and /api/.../events(SSE) to the backend(4317).
// SSE must not be buffered, so the proxy is left as default pass-through (keeps streaming).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'web',
  resolve: {
    // shadcn standard alias. Sources live in web/, so map @/ -> web/.
    alias: {
      '@': fileURLToPath(new URL('./web', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // NOTE: key must be "/api/" (trailing slash), NOT "/api".
      // "/api" also matches the frontend's own `api.ts` module URL (`/api.ts`),
      // which Vite would then proxy to the backend → module 404 → white screen.
      // All real endpoints live under "/api/...", so "/api/" is the correct prefix.
      '/api/': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
      },
      // WebSocket event bus (/ws) proxy. Without ws:true the upgrade won't happen.
      '/ws': {
        target: 'http://127.0.0.1:4317',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split vendor chunks (Rolldown only allows the function form).
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/'))
              return 'react';
            if (
              id.includes('/unified/') ||
              id.includes('/remark-') ||
              id.includes('/rehype-') ||
              id.includes('/mdast') ||
              id.includes('/hast') ||
              id.includes('/micromark')
            )
              return 'markdown';
          }
          return undefined;
        },
      },
    },
  },
});
