import { defineConfig } from 'vite';

// The referee console only, built as a genuinely separate bundle from the
// spectator viewer (vite.config.ts / dist-viewer) — a different root, a
// different output directory, no shared entry — so the spectator bundle can
// never end up carrying referee code or vice versa.
export default defineConfig({
  root: 'referee',
  // Served from /referee/* on the match server, not the site root — asset
  // URLs in the built HTML have to say so, or they 404 once deployed there
  // even though they work fine from Vite's own dev server.
  base: '/referee/',
  build: { outDir: '../dist-referee', emptyOutDir: true },
});
