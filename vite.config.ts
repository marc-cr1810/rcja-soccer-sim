import { defineConfig } from 'vite';

// The viewer only. Tests live in tests/ and are run with `bun test`.
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
