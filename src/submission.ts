/**
 * Validating a pushed robot folder before it is kept.
 *
 * Four checks, in order, each one cheaper than the next: the manifest has to
 * parse before there is anything to check the syntax of, the syntax has to
 * be clean before it is worth asking what it imports, and nothing is
 * executed until everything static has already passed. Only the last check
 * runs the submission's own code, and only that one is sandboxed.
 *
 * Every failure is a reason string, not an exception — a push is rejected
 * with something a student can act on, not a stack trace out of this file.
 */

import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

import { AGENT_PATH, AgentGateway } from './gateway';
import { fail, ok, parseManifest, type Manifest, type Result } from './manifest';
import { Senses } from './perception';
import { scanImports, stdlibModules } from './pyimports';
import { sandboxUnavailableReason, spawnSandboxed } from './sandbox';

export interface ValidateOptions {
  /** Absolute path to the repo's python/ directory, for `import rcja_soccer`. */
  pythonLibDir: string;
  connectTimeoutMs?: number;
  tickTimeoutMs?: number;
}

const ALLOWED_EXTRA = new Set(['rcja_soccer']);

/**
 * Validate a robot folder already unpacked on disk at `dir`.
 *
 * `dir` doubles as the sandbox's bound-in folder for the synthetic tick, so
 * this only ever reads real files rather than juggling an in-memory copy
 * alongside one on disk.
 */
export async function validateSubmission(
  dir: string,
  opts: ValidateOptions,
): Promise<Result<Manifest>> {
  const names = await readdir(dir);
  const available = new Set(names);
  const manifestRaw = available.has('manifest.json')
    ? await readFile(join(dir, 'manifest.json'))
    : undefined;

  const manifestResult = parseManifest(manifestRaw, available);
  if (!manifestResult.ok) return manifestResult;
  const manifest = manifestResult.value;

  const staticResult = await checkStatic(dir, manifest, available);
  if (!staticResult.ok) return staticResult;

  const tickResult = await checkSyntheticTick(dir, manifest, opts);
  if (!tickResult.ok) return tickResult;

  return ok(manifest);
}

/**
 * Syntax and imports, transitively over every local module the entry point
 * reaches — never the code itself, and never the other robot's folder,
 * which is not even on disk here.
 */
async function checkStatic(
  dir: string,
  manifest: Manifest,
  available: ReadonlySet<string>,
): Promise<Result<void>> {
  const stdlib = await stdlibModules();
  const localModules = new Set(
    [...available].filter((f) => f.endsWith('.py')).map((f) => f.slice(0, -3)),
  );

  const visited = new Set<string>();
  const queue = [manifest.entry];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = await readFile(join(dir, file), 'utf8');
    const scan = await scanImports(source);
    if ('error' in scan) {
      return fail(`${file} does not parse as Python: ${scan.error}`);
    }

    for (const mod of scan.modules) {
      if (stdlib.has(mod) || ALLOWED_EXTRA.has(mod)) continue;
      if (localModules.has(mod)) {
        queue.push(`${mod}.py`);
        continue;
      }
      return fail(
        `${file} imports "${mod}", which is not available at a venue with no internet and ` +
          'no pip. Only the standard library, rcja_soccer, and files in this same folder are.',
      );
    }
  }

  return ok(undefined);
}

/**
 * The only step that runs the submission.
 *
 * The sandboxed process has no network — that is the point of sandboxing it
 * — so the throwaway gateway it talks to cannot be a TCP port. It listens on
 * a Unix domain socket instead, in a small directory bound into the sandbox
 * read-write for exactly this, which is a filesystem path rather than a
 * network hole and costs the sandbox nothing.
 */
async function checkSyntheticTick(
  dir: string,
  manifest: Manifest,
  opts: ValidateOptions,
): Promise<Result<void>> {
  const unavailable = sandboxUnavailableReason();
  if (unavailable) {
    return fail(`cannot validate a submission: ${unavailable}`);
  }

  const connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
  const tickTimeoutMs = opts.tickTimeoutMs ?? 2000;

  const controlDir = await mkdtemp(join(tmpdir(), 'rcja-validate-'));
  const socketPath = join(controlDir, 'gateway.sock');

  const gateway = new AgentGateway();
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  http.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (socketReady) => gateway.accept(socketReady));
  });
  await new Promise<void>((resolve) => http.listen(socketPath, resolve));
  const url = `unix://${socketPath}?path=${encodeURIComponent(AGENT_PATH)}`;

  const seatId = `violet-${manifest.robot}`;
  const child = spawnSandboxed({
    entry: join(dir, manifest.entry),
    cwd: dir,
    pythonLibDir: opts.pythonLibDir,
    controlDir,
    // No real token exists yet at validation time (one is only minted once a
    // push has passed every check, including this one) — the placeholder
    // value here is checked against nothing, since this scratch gateway
    // never calls `expectToken`. It exists purely so an entry script whose
    // argparse forgot `--token` fails here, at push time, instead of only
    // once it's actually spawned for a match.
    args: [
      '--team',
      'violet',
      '--number',
      String(manifest.robot),
      '--name',
      manifest.team,
      '--url',
      url,
      '--token',
      'validation',
    ],
  });

  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });

  const teardown = async (): Promise<void> => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    gateway.closeAll();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(controlDir, { recursive: true, force: true }).catch(() => {});
  };

  const withStderr = (message: string): string => {
    const tail = stderr.trim();
    return tail ? `${message}\n\n${tail.split('\n').slice(-8).join('\n')}` : message;
  };

  try {
    await pollUntil(connectTimeoutMs, () => gateway.transports()[seatId]?.connected === true);
  } catch {
    await teardown();
    return fail(
      withStderr(
        `${manifest.entry} did not connect within ${(connectTimeoutMs / 1000).toFixed(0)}s.`,
      ),
    );
  }

  const transport = gateway.transports()[seatId]!;
  transport.send(syntheticFrame(manifest.robot));

  try {
    await pollUntil(tickTimeoutMs, () => transport.take() !== null);
  } catch {
    await teardown();
    return fail(
      withStderr(
        `${manifest.entry} connected but never answered a sensor frame within ` +
          `${(tickTimeoutMs / 1000).toFixed(0)}s. Check the tick function returns quickly.`,
      ),
    );
  }

  await teardown();
  return ok(undefined);
}

function syntheticFrame(robotNumber: number) {
  const senses = new Senses(1, 4, true);
  const self = { id: `violet-${robotNumber}`, team: 'violet', number: robotNumber, x: -500, z: 0, heading: 0 };
  return senses.read({
    view: {
      clock: 0,
      playing: false,
      ball: { x: 0, z: 0 },
      robots: [self],
      kickoff: { pending: false, team: null, countdown: 0 },
    },
    self,
    wheelSpeeds: [0, 0, 0, 0],
    omega: 0,
    held: false,
    messages: [],
    attackDirection: 1,
    dt: 0.02,
  });
}

function pollUntil(timeoutMs: number, check: () => boolean, everyMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('timed out'));
        return;
      }
      setTimeout(poll, everyMs);
    };
    poll();
  });
}
