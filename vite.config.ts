import { defineConfig } from 'vite';

// The viewer only. Tests are configured separately in vitest.config.ts, because
// this root points at the browser client and the suite lives in src/.
export default defineConfig({
  root: 'viewer',
  // Relative, so the bundle is right wherever it is mounted — the same reason
  // the practice and workspace bundles are. A match server serves it at `/`, a
  // league server at `/live/` and a practice field at `/f/<id>/`, and an
  // absolute base makes the last two fetch the *site's* /assets and arrive as
  // an unstyled page stuck on "connecting…".
  base: './',
  build: { outDir: '../dist-viewer', emptyOutDir: true },
});
