import { defineConfig } from 'vite';

// The referee console only, built as a genuinely separate bundle from the
// spectator viewer (vite.config.ts / dist/viewer) — a different root, a
// different output directory, no shared entry — so the spectator bundle can
// never end up carrying referee code or vice versa.
export default defineConfig({
  root: 'referee',
  // Relative, like the viewer and the two other consoles. It used to be
  // `/referee/`, which was right while a server had exactly one world and the
  // console had exactly one address. Phase 7 moved every world into a child
  // arena, so the same bundle is also served at `/a/<id>/referee/` — and an
  // absolute base there fetches `/referee/assets/…` from the hub, which is a
  // *page* route, so the browser gets HTML back where it asked for JavaScript
  // and the console never starts. This is the third time this exact bug has
  // been found by opening a bundle somewhere new; relative is the answer every
  // time, because the bundle does not get to know where it is mounted.
  base: './',
  build: { outDir: '../dist/referee', emptyOutDir: true },
});
