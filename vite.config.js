import { defineConfig } from 'vite';

export default defineConfig({
  test: { include: ['src/**/*.test.js'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Three.js is the application runtime, so a single cached engine chunk is expected.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: { manualChunks: { three: ['three', 'three/addons/exporters/GLTFExporter.js', 'three/addons/utils/BufferGeometryUtils.js'] } },
    },
  },
});
