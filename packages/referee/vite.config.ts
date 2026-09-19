import { defineConfig } from 'vite';

// The referee console, built as a genuinely separate bundle from the
// spectator viewer — different root, different output directory, no shared
// entry — so the spectator bundle can never end up carrying referee code
// or vice versa.
// Relative base: the same bundle is served at /a/<id>/referee/ in multi-arena
// setups — an absolute base would fetch the wrong assets.
export default defineConfig({
  base: './',
  build: { outDir: '../../dist/referee', emptyOutDir: true },
});
