/**
 * Tests for release update checks, version comparisons, and systemd service generation.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  cleanVersion,
  isNewerVersion,
  getPlatformAsset,
  formatUpdateBanner,
  checkLatestRelease,
  type ReleaseInfo,
} from '../src/update';
import { generateServiceUnit } from '../src/cli';

describe('version normalization & comparison', () => {
  it('cleans version prefixes and whitespace', () => {
    expect(cleanVersion('v26.9-0f74e6')).toBe('26.9-0f74e6');
    expect(cleanVersion('  26.9-0f74e6  ')).toBe('26.9-0f74e6');
    expect(cleanVersion('dev')).toBe('dev');
  });

  it('correctly compares YY.M versions', () => {
    // Newer month
    expect(isNewerVersion('26.9-0f74e6', '26.10-0f74e6')).toBe(true);
    expect(isNewerVersion('26.9-0f74e6', 'v26.10-0f74e6')).toBe(true);

    // Newer year
    expect(isNewerVersion('26.9-0f74e6', '27.1-0f74e6')).toBe(true);

    // Older month or year
    expect(isNewerVersion('26.9-0f74e6', '26.8-0f74e6')).toBe(false);
    expect(isNewerVersion('26.9-0f74e6', '25.12-0f74e6')).toBe(false);

    // Same version
    expect(isNewerVersion('26.9-0f74e6', '26.9-0f74e6')).toBe(false);
    expect(isNewerVersion('v26.9-0f74e6', '26.9-0f74e6')).toBe(false);

    // Dev version suppresses update notifications
    expect(isNewerVersion('dev', '26.9-0f74e6')).toBe(false);

    // Same year/month, differing hash
    expect(isNewerVersion('26.9-0f74e6', '26.9-1a2b3c')).toBe(true);
  });
});

describe('platform asset resolution', () => {
  it('resolves asset name matching current platform and architecture', () => {
    const asset = getPlatformAsset();
    if (process.platform === 'linux' && process.arch === 'x64') {
      expect(asset).toBe('rcja-soccer-sim-linux-x64');
    } else if (process.platform === 'linux' && process.arch === 'arm64') {
      expect(asset).toBe('rcja-soccer-sim-linux-arm64');
    } else if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(asset).toBe('rcja-soccer-sim-darwin-arm64');
    }
  });
});

describe('update banner formatting', () => {
  it('produces formatted update banner', () => {
    const info: ReleaseInfo = {
      currentVersion: '26.9-0f74e6',
      latestVersion: 'v26.10-1a2b3c',
      updateAvailable: true,
      releaseUrl: 'https://github.com/example/release',
      checkedAt: Date.now(),
    };
    const banner = formatUpdateBanner(info);
    expect(banner).toContain('Update available: 26.9-0f74e6 →');
    expect(banner).toContain('26.10-1a2b3c');
    expect(banner).toContain('rcja-soccer-sim upgrade');
  });
});

describe('release cache behavior', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rcja-test-update-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reads from unexpired cache without making network requests', async () => {
    const cachedData = {
      currentVersion: '26.9-0f74e6',
      latestVersion: 'v26.10-abc123',
      updateAvailable: true,
      releaseUrl: 'https://github.com/example/releases/v26.10',
      downloadUrl: 'https://github.com/example/download',
      checkedAt: Date.now() - 1000 * 60, // 1 minute old
    };

    writeFileSync(join(tmpDir, 'update-check.json'), JSON.stringify(cachedData));

    const res = await checkLatestRelease(tmpDir, { timeoutMs: 100 });
    expect(res).not.toBeNull();
    expect(res?.latestVersion).toBe('v26.10-abc123');
    expect(res?.releaseUrl).toBe('https://github.com/example/releases/v26.10');
  });
});

describe('systemd service unit generation', () => {
  it('generates a valid systemd user service unit with Delegate=yes', () => {
    const unit = generateServiceUnit({
      execPath: '/usr/local/bin/rcja-soccer-sim',
      isCliScript: false,
      workDir: '/home/venue',
      args: '--port 8080 --name state-finals',
    });

    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=RCJA Soccer Sim League Server');
    expect(unit).toContain('WorkingDirectory=/home/venue');
    expect(unit).toContain('ExecStart=/usr/local/bin/rcja-soccer-sim league --port 8080 --name state-finals');
    expect(unit).toContain('Delegate=yes');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('generates a valid service unit for bun development invocation', () => {
    const unit = generateServiceUnit({
      execPath: '/usr/bin/bun',
      isCliScript: true,
      cliScriptPath: '/opt/rcja/src/cli.ts',
      workDir: '/opt/rcja',
    });

    expect(unit).toContain('ExecStart=/usr/bin/bun /opt/rcja/src/cli.ts league');
    expect(unit).toContain('WorkingDirectory=/opt/rcja');
  });
});
