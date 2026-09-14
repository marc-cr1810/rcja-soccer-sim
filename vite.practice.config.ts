import { defineConfig } from 'vite';

// The practice console, built as its own bundle for the same reason the
// referee console is (vite.referee.config.ts): a different root, a different
// output directory, no shared entry. It is unauthenticated — a practice field
// is open to whoever has the link, which is Phase 4's deliberate position —
// but it is still a different surface from the spectator viewer, and keeping
// the bundles apart is what stops one growing the other's controls by
// accident.
export default defineConfig({
  root: 'practice',
  // Relative, not '/practice/': a field opened straight from its own port is
  // at /practice/, and the same field reached through a venue server is at
  // /f/<id>/practice/. Relative asset URLs are the only ones that are right in
  // both places, and the server redirects /practice to /practice/ so the
  // browser has a directory to resolve them against.
  base: './',
  build: { outDir: '../dist-practice', emptyOutDir: true },
});
