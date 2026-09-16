/**
 * Versioning for rcja-soccer-sim.
 *
 * Uses the short date-hash format: `YY.M-hash` (e.g. `26.9-0f74e6`).
 *
 * Populated at compile time via Bun's `--define APP_VERSION=...`,
 * or dynamically computed from Git commit and date in development.
 */

declare const APP_VERSION: string | undefined;

export function getVersion(): string {
  // If compiled with `--define APP_VERSION="..."` or set in environment:
  if (typeof APP_VERSION !== 'undefined' && APP_VERSION) return APP_VERSION;
  if (process.env.APP_VERSION) return process.env.APP_VERSION;

  // Fallback in local git checkout:
  try {
    const { execSync } = require('node:child_process');
    const hash = execSync('git rev-parse --short=6 HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const m = now.getMonth() + 1;
    if (hash) return `${yy}.${m}-${hash}`;
  } catch {}

  return 'dev';
}
