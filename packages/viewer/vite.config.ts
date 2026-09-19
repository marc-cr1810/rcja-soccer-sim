import { defineConfig } from 'vite';

// The viewer only. Tests live in packages/server/tests and are run with `bun test`.
// Relative base so the bundle is right wherever it is mounted — the same reason
// the practice and workspace bundles are. A match server serves it at `/`, a
// league server at `/live/` and a practice field at `/f/<id>/`, and an
// absolute base makes the last two fetch the *site's* /assets and arrive as
// an unstyled page stuck on "connecting…".
export default defineConfig({
  base: './',
  build: { outDir: '../../dist/viewer', emptyOutDir: true },
});
