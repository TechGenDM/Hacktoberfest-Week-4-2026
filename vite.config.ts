import { defaultClientConditions, defineConfig } from 'vite';

// Production builds are served from GitHub Pages at /DEAD-AIR/; dev stays at /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/DEAD-AIR/' : '/',
  resolve: {
    // Transformers.js points ONNX Runtime at its WASM files on jsDelivr (env.backends.onnx.wasm.wasmPaths).
    // The default `onnxruntime-web/webgpu` build also references a local copy via new URL(..., import.meta.url),
    // so Vite would emit a 27 MB .wasm that is never fetched. This condition selects ORT's own build for
    // externally hosted WASM, which drops that unused copy.
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  worker: { format: 'es' },
  build: { target: 'esnext', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
}));
