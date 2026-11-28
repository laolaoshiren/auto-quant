import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = 'http://127.0.0.1:27137';

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
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const norm = id.replace(/\\/g, '/');
          if (!norm.includes('/node_modules/')) return undefined;
          if (
            norm.includes('/node_modules/react/') ||
            norm.includes('/node_modules/react-dom/') ||
            norm.includes('/node_modules/scheduler/') ||
            norm.includes('/node_modules/react-router')
          ) {
            return 'vendor-react';
          }
          if (
            norm.includes('/node_modules/recharts/') ||
            norm.includes('/node_modules/d3-') ||
            norm.includes('/node_modules/victory-vendor/') ||
            norm.includes('/node_modules/lodash')
          ) {
            return 'vendor-recharts';
          }
          if (norm.includes('/node_modules/@radix-ui/') || norm.includes('/node_modules/cmdk/')) {
            return 'vendor-radix';
          }
          if (norm.includes('/node_modules/lucide-react/')) {
            return 'vendor-icons';
          }
          return undefined;
        },
      },
    },
  },
});
