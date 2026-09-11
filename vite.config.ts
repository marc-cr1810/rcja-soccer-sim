import { defineConfig } from 'vite';

// The viewer only. Tests are configured separately in vitest.config.ts, because
// this root points at the browser client and the suite lives in src/.
export default defineConfig({
  root: 'viewer',
  build: { outDir: '../dist-viewer', emptyOutDir: true },
});
