import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'esnext', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
