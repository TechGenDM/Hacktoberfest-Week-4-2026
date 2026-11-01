import { defineConfig } from 'vite';

// Production builds are served from GitHub Pages at /DEAD-AIR/; dev stays at /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/DEAD-AIR/' : '/',
  worker: { format: 'es' },
  build: { target: 'esnext', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
}));
