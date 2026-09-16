import { defineConfig } from 'vite';

// The team workspace, built as its own bundle for the same reasons the referee
// and practice consoles are: a different root, a different output directory,
// no shared entry with anything under viewer/.
//
// Like those two it is a window onto something happening on the server, not a
// thing in its own right. A team's code lives on the venue server, runs there
// under the same sandbox a match uses, and is watched here over the same
// socket a spectator watches a match through. Nothing about a robot runs in
// this tab — which is the point: a rehearsal that ran the student's code on a
// different Python, without the CPU and memory ceilings, would be rehearsing a
// different sport.
export default defineConfig({
  root: 'workspace',
  // Relative, so the bundle is right wherever the venue mounts it.
  base: './',
  build: { outDir: '../dist/workspace', emptyOutDir: true },
});
