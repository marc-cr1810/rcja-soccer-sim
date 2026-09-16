import { defineConfig } from 'vite';

// The league site: the front page, the schedule, the table, a match's record,
// and the login and team screens behind it. Built as its own bundle like the
// other four, for the same reason — a different root, a different output
// directory, no shared entry with anything that controls a match.
//
// Unlike them it is served from the site root, so `base` is absolute: a
// client-routed page at /m/<id> has to reach the same /assets/… the front page
// does, and a relative base would resolve it one directory down and 404.
export default defineConfig({
  root: 'site',
  base: '/',
  build: { outDir: '../dist/site', emptyOutDir: true },
});
