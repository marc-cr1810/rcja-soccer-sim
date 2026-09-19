import { defineConfig } from 'vite';

// The practice console. Unauthenticated — a practice field is open to whoever
// has the link — but still a separate bundle from the spectator viewer.
// Relative base: a field opened on its own port is at /practice/, and the same
// field reached through a venue server is at /f/<id>/practice/.
export default defineConfig({
  base: './',
  build: { outDir: '../../dist/practice', emptyOutDir: true },
});
