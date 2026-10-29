import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the analytics service runs on :8081; the dashboard proxies to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/v1': { target: process.env.ANALYTICS_URL ?? 'http://localhost:8081', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
