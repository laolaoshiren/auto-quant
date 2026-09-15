import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = 'http://127.0.0.1:3200';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 explicitly: on Windows `localhost` can resolve to ::1 only,
    // which makes `curl http://127.0.0.1:5173` fail even though Vite is up.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        // The live event stream is a WebSocket on /api/events.
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
