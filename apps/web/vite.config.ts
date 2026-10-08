import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:4000', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], globals: false },
} as never);
