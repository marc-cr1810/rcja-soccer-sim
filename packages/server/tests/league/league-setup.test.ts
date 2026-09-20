/**
 * Tests for league-setup and team CLI commands.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Accounts } from '../../src/accounts/accounts';
import { getVersion } from '../../src/infra/version';
import { defaultStorageDir } from '../../src/infra/cli';
import { homedir } from 'node:os';

describe('version reporting', () => {
  it('returns a formatted short date-hash string', () => {
    const v = getVersion();
    expect(v).toBeTruthy();
    // Matches either 'dev' or 'YY.M-hash' (e.g. '26.9-0f74e6') or 'vYY.M-hash'
    expect(v).toMatch(/^(dev|v?\d{2}\.\d{1,2}-[a-f0-9]{6,})/);
  });
});

describe('defaultStorageDir', () => {
  /*
   * The repository root, which is two levels above this package. Not
   * `process.cwd()`: these tests run with the cwd set to `packages/server`,
   * and the whole point of what is checked below is that the answer does not
   * depend on where inside the checkout you happen to be standing.
   */
  const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

  it('resolves to <repo>/data/<subdir> when executed inside this repository', () => {
    const dir = defaultStorageDir('league', REPO_ROOT);
    expect(dir).toBe(join(REPO_ROOT, 'data', 'league'));
    expect(defaultStorageDir('tournaments', REPO_ROOT)).toBe(join(REPO_ROOT, 'data', 'tournaments'));
    expect(defaultStorageDir('submissions', REPO_ROOT)).toBe(join(REPO_ROOT, 'data', 'submissions'));
    expect(defaultStorageDir('workspaces', REPO_ROOT)).toBe(join(REPO_ROOT, 'data', 'workspaces'));
  });

  it('gives the same answer from anywhere inside the repository', () => {
    /*
     * The monorepo restructure broke this without breaking anything that
     * looked like a feature. `packages/server/package.json` exists and is
     * named `@rcja/server`, so a check of the current directory alone found a
     * package.json, decided it was some other project, and fell through to
     * `~/.local/share` - meaning a server started from `packages/server`
     * quietly kept its accounts and pushes somewhere different from one
     * started at the root.
     */
    const fromRoot = defaultStorageDir('league', REPO_ROOT);
    expect(defaultStorageDir('league', join(REPO_ROOT, 'packages', 'server'))).toBe(fromRoot);
    expect(defaultStorageDir('league', join(REPO_ROOT, 'packages', 'server', 'src', 'infra'))).toBe(fromRoot);
    expect(defaultStorageDir('league', process.cwd())).toBe(fromRoot);
  });

  it('resolves to XDG directory (~/.local/share/rcja-soccer-sim/<subdir>) outside repository', () => {
    const dir = defaultStorageDir('league', tmpdir());
    const expectedXdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    expect(dir).toBe(join(expectedXdg, 'rcja-soccer-sim', 'league'));
  });
});

describe('league-setup and team CLI commands', () => {
  let tmpDir: string;
  let dataDir: string;
  let workspacesDir: string;
  let submissionsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rcja-test-setup-'));
    dataDir = join(tmpDir, 'league');
    workspacesDir = join(tmpDir, 'workspaces');
    submissionsDir = join(tmpDir, 'submissions');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const cliPath = resolve(import.meta.dirname, '../../src/infra/cli.ts');

  async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(
      ['bun', cliPath, ...args, '--data', dataDir, '--workspaces-dir', workspacesDir, '--submissions', submissionsDir],
      {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  }

  it('initializes data directories and creates the root admin', async () => {
    const res = await runCli(['league-setup', '--name', 'Venue Organizer', '--password', 'test-admin-password-123']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('league initialized');
    expect(res.stdout).toContain('venue-organizer');

    // Check files on disk
    expect(existsSync(join(dataDir, 'league.db'))).toBe(true);
    expect(existsSync(workspacesDir)).toBe(true);
    expect(existsSync(submissionsDir)).toBe(true);

    // Verify account in DB
    const accounts = new Accounts({ file: join(dataDir, 'league.db') });
    try {
      expect(accounts.empty).toBe(false);
      const admin = accounts.bySlug('venue-organizer');
      expect(admin).not.toBeNull();
      expect(admin?.role).toBe('admin');
      expect(accounts.authenticate('venue-organizer', 'test-admin-password-123')).not.toBeNull();
    } finally {
      accounts.close();
    }
  });

  it('detects existing admin on subsequent league-setup runs', async () => {
    await runCli(['league-setup', '--name', 'Organizer', '--password', 'admin-password-123']);
    const second = await runCli(['league-setup', '--name', 'Other', '--password', 'admin-password-456']);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('league already set up');
    expect(second.stdout).toContain('organizer');
  });

  it('creates teams, creates workspaces, and mints push API keys', async () => {
    // Setup league first
    await runCli(['league-setup', '--name', 'Organizer', '--password', 'admin-password-123']);

    // Create a team
    const createRes = await runCli(['team', 'create', 'ACT Robotics']);
    expect(createRes.exitCode).toBe(0);
    expect(createRes.stdout).toContain('Team "ACT Robotics" created');
    expect(createRes.stdout).toContain('Push Key:');
    expect(createRes.stdout).toContain('rcja_');

    // Verify workspace directory created
    expect(existsSync(join(workspacesDir, 'act-robotics'))).toBe(true);

    // List teams
    const listRes = await runCli(['team', 'list']);
    expect(listRes.exitCode).toBe(0);
    expect(listRes.stdout).toContain('ACT Robotics');
    expect(listRes.stdout).toContain('act-robotics');

    // Mint a new key
    const keyRes = await runCli(['team', 'key', 'ACT Robotics']);
    expect(keyRes.exitCode).toBe(0);
    expect(keyRes.stdout).toContain('Minted new push key');

    // Issue an invite
    const inviteRes = await runCli(['team', 'invite', 'NSW Lightning']);
    expect(inviteRes.exitCode).toBe(0);
    expect(inviteRes.stdout).toContain('Registration invite code');
  });
});
