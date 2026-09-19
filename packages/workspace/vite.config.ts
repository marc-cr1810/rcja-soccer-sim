import { defineConfig } from 'vite';

// The team workspace: write your robot in a browser, on the venue's server.
// Relative base so the bundle is right wherever the venue mounts it.
export default defineConfig({
  base: './',
  build: { outDir: '../../dist/workspace', emptyOutDir: true },
});
