/**
 * Release check and self-update subsystem for rcja-soccer-sim.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getVersion } from './version';

export const GITHUB_REPO = 'marc-cr1810/rcja-soccer-sim';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface ReleaseInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  downloadUrl?: string;
  checkedAt: number;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  assets: GitHubAsset[];
}

/**
 * Normalizes a version string by stripping leading 'v' and whitespace.
 */
export function cleanVersion(v: string): string {
  return v.trim().replace(/^v/, '');
}

/**
 * Compares two versions.
 * Returns true if candidate is newer than current.
 */
export function isNewerVersion(current: string, candidate: string): boolean {
  const cur = cleanVersion(current);
  const cand = cleanVersion(candidate);

  if (cur === cand || cur === 'dev') return false;

  // Try parsing YY.M-hash
  const curMatch = cur.match(/^(\d+)\.(\d+)(?:-([a-f0-9]+))?/);
  const candMatch = cand.match(/^(\d+)\.(\d+)(?:-([a-f0-9]+))?/);

  if (curMatch && candMatch && curMatch[1] && curMatch[2] && candMatch[1] && candMatch[2]) {
    const curYear = parseInt(curMatch[1], 10);
    const curMonth = parseInt(curMatch[2], 10);
    const candYear = parseInt(candMatch[1], 10);
    const candMonth = parseInt(candMatch[2], 10);

    if (candYear > curYear) return true;
    if (candYear < curYear) return false;
    if (candMonth > curMonth) return true;
    if (candMonth < curMonth) return false;

    // Same year and month: check hash difference
    if (curMatch[3] && candMatch[3]) {
      return curMatch[3] !== candMatch[3];
    }
  }

  // Fallback: simple inequality
  return cur !== cand;
}

/**
 * Resolves the expected binary asset name for the current platform and architecture.
 */
export function getPlatformAsset(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'linux' && arch === 'x64') return 'rcja-soccer-sim-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'rcja-soccer-sim-linux-arm64';
  if (platform === 'darwin' && arch === 'arm64') return 'rcja-soccer-sim-darwin-arm64';
  return null;
}

/**
 * Checks for the latest release from GitHub, using a local cache file to avoid frequent requests.
 * Completely silent and non-blocking on failures.
 */
export async function checkLatestRelease(
  cacheDir: string,
  options?: { force?: boolean; timeoutMs?: number; repo?: string },
): Promise<ReleaseInfo | null> {
  const currentVersion = getVersion();
  const cacheFile = join(cacheDir, 'update-check.json');
  const now = Date.now();
  const repo = options?.repo || GITHUB_REPO;

  // Check cache first
  if (!options?.force && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as ReleaseInfo;
      if (now - cached.checkedAt < CACHE_TTL_MS) {
        return {
          ...cached,
          currentVersion,
          updateAvailable: isNewerVersion(currentVersion, cached.latestVersion),
        };
      }
    } catch {}
  }

  // Fetch latest release metadata from GitHub
  try {
    const timeout = options?.timeoutMs ?? 2500;
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        'User-Agent': `rcja-soccer-sim/${currentVersion}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as GitHubRelease;
    const latestVersion = data.tag_name;
    const targetAsset = getPlatformAsset();
    const asset = data.assets?.find((a) => a.name === targetAsset);

    const info: ReleaseInfo = {
      currentVersion,
      latestVersion,
      updateAvailable: isNewerVersion(currentVersion, latestVersion),
      releaseUrl: data.html_url,
      downloadUrl: asset?.browser_download_url,
      checkedAt: now,
    };

    // Save cache
    try {
      writeFileSync(cacheFile, JSON.stringify(info, null, 2));
    } catch {}

    return info;
  } catch {
    // Offline or request timed out — fail silently
    return null;
  }
}

/**
 * Formats a clean ANSI banner notifying the user that an update is available.
 */
export function formatUpdateBanner(info: ReleaseInfo): string {
  const cur = cleanVersion(info.currentVersion);
  const next = cleanVersion(info.latestVersion);
  const line1 = `Update available: ${cur} → \x1b[32m${next}\x1b[0m`;
  const line2 = `Run '\x1b[36mrcja-soccer-sim upgrade\x1b[0m' to update`;

  return [
    '',
    '  ╭────────────────────────────────────────────────────────╮',
    `  │  ${line1.padEnd(62)}│`,
    `  │  ${line2.padEnd(62)}│`,
    '  ╰────────────────────────────────────────────────────────╯',
    '',
  ].join('\n');
}

/**
 * Performs a self-upgrade of the application.
 */
export async function performUpgrade(cacheDir: string): Promise<void> {
  const currentVersion = getVersion();
  console.log(`\n  Checking for latest release of rcja-soccer-sim...`);

  // 1. If running inside a git repository, pull and rebuild
  const isGitRepo = existsSync(join(process.cwd(), '.git')) && existsSync(join(process.cwd(), 'package.json'));
  if (isGitRepo) {
    console.log(`  Running inside git repository: updating via git & bun...`);
    const pull = spawnSync('git', ['pull'], { stdio: 'inherit' });
    if (pull.status !== 0) throw new Error('git pull failed');

    const install = spawnSync('bun', ['install'], { stdio: 'inherit' });
    if (install.status !== 0) throw new Error('bun install failed');

    const build = spawnSync('make', ['build'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('make build failed');

    restartSystemdServiceIfRunning();
    console.log(`\n  \x1b[32m✓\x1b[0m Successfully updated git repository to latest version.\n`);
    return;
  }

  // 2. Standalone binary upgrade via GitHub release
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        'User-Agent': `rcja-soccer-sim/${currentVersion}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err: any) {
    console.error(`  \x1b[31mError:\x1b[0m Could not connect to GitHub (${err.message}).`);
    process.exit(1);
  }

  if (res.status === 404) {
    console.log(`  No releases published on GitHub yet for ${GITHUB_REPO}.`);
    console.log(`  Current version: ${cleanVersion(currentVersion)}\n`);
    return;
  }

  if (!res.ok) {
    console.error(`  \x1b[31mError:\x1b[0m GitHub returned HTTP ${res.status}.`);
    process.exit(1);
  }

  const data = (await res.json()) as GitHubRelease;
  const latestVersion = data.tag_name;
  const targetAsset = getPlatformAsset();
  const asset = data.assets?.find((a) => a.name === targetAsset);

  const info: ReleaseInfo = {
    currentVersion,
    latestVersion,
    updateAvailable: isNewerVersion(currentVersion, latestVersion),
    releaseUrl: data.html_url,
    downloadUrl: asset?.browser_download_url,
    checkedAt: Date.now(),
  };

  try {
    const cacheFile = join(cacheDir, 'update-check.json');
    writeFileSync(cacheFile, JSON.stringify(info, null, 2));
  } catch {}

  if (!info.updateAvailable) {
    console.log(`  ✓ Already up to date (version ${cleanVersion(currentVersion)}).\n`);
    return;
  }

  const assetName = getPlatformAsset();
  if (!info.downloadUrl || !assetName) {
    console.error(`  \x1b[31mError:\x1b[0m No release binary available for ${process.platform}-${process.arch}.`);
    console.error(`  View release at: ${info.releaseUrl}\n`);
    process.exit(1);
  }

  console.log(`  Downloading ${assetName} (${info.latestVersion})...`);
  const response = await fetch(info.downloadUrl);
  if (!response.ok || !response.body) {
    console.error(`  \x1b[31mError:\x1b[0m Failed to download binary (HTTP ${response.status}).`);
    process.exit(1);
  }

  const execPath = process.execPath;
  const tempPath = `${execPath}.download-${Date.now()}`;

  try {
    const arrayBuffer = await response.arrayBuffer();
    writeFileSync(tempPath, Buffer.from(arrayBuffer));
    chmodSync(tempPath, 0o755);

    // Atomic replacement
    renameSync(tempPath, execPath);
    console.log(`  \x1b[32m✓\x1b[0m Successfully updated rcja-soccer-sim to ${cleanVersion(info.latestVersion)}`);

    restartSystemdServiceIfRunning();
    console.log();
  } catch (err: any) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {}
    console.error(`  \x1b[31mError updating binary:\x1b[0m ${err.message}`);
    console.error(`  You may need to run this command with appropriate write permissions.`);
    process.exit(1);
  }
}

/**
 * Restarts the systemd user service if it is currently running.
 */
export function restartSystemdServiceIfRunning(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const check = spawnSync('systemctl', ['--user', 'is-active', 'rcja-soccer-sim'], { encoding: 'utf8' });
    if (check.stdout && check.stdout.trim() === 'active') {
      console.log(`  Restarting systemd service (rcja-soccer-sim)...`);
      const restart = spawnSync('systemctl', ['--user', 'restart', 'rcja-soccer-sim'], { stdio: 'inherit' });
      return restart.status === 0;
    }
  } catch {}
  return false;
}
