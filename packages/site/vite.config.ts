import { defineConfig } from 'vite';

// The league site: front page, schedule, table, match records, and login.
// Unlike the other four bundles this is served from the site root, so `base`
// is absolute: a client-routed page at /m/<id> has to reach the same /assets/…
// the front page does, and a relative base resolves it one directory down.
export default defineConfig({
  base: '/',
  build: { outDir: '../../dist/site', emptyOutDir: true },
});
