import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 100000,
  },
  optimizeDeps: {
    exclude: ['opencascade.js'],
  },
  assetsInclude: ['**/*.wasm'],
});
