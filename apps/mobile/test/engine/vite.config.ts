import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: { alias: { '@starblitz/shared': fileURLToPath(new URL('../../../shared/src/index.ts', import.meta.url)) } },
  build: { outDir: process.env.SB_TEST_OUT || 'dist-test', emptyOutDir: true, target: 'chrome110', chunkSizeWarningLimit: 20000 },
  server: { fs: { allow: ['../../..'] } },
});
