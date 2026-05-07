import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the client runs on Vite (:5173) and the wrangler dev server runs on
// :8787 hosting the Worker + DOs. Proxying `/api` and `/ws` lets us keep the
// client code path-relative ("/ws/<code>", "/api/rooms"), so the same code
// works in production where the same Worker serves both the SPA and the API.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
