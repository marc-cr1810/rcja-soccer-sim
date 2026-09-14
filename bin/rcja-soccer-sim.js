#!/usr/bin/env node
// Thin wrapper so `rcja-soccer-sim <command>` (after `npm link`) is the same
// as `npm run serve -- <command>` — tsx runs src/cli.ts directly, there is
// no compiled build of the CLI itself.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const cli = join(root, 'src', 'cli.ts');

const result = spawnSync(tsx, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
