#!/usr/bin/env bun
// Thin wrapper so `rcja-soccer-sim <command>` (after `bun link`) is the same
// as `bun packages/server/src/infra/cli.ts <command>` — Bun runs the CLI
// directly, there is no compiled build of the CLI itself. Importing runs it:
// `process.argv.slice(2)` in the CLI sees the caller's arguments.
import '../packages/server/src/infra/cli.ts';