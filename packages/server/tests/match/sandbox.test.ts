import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { sandboxAvailable, spawnSandboxed } from '../../src/match/sandbox';

const PYTHON_LIB_DIR = resolve(import.meta.dirname, '../../../../python');

async function collect(child: Subprocess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [stdout, stderr, code] = await Promise.all([
    child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : '',
    child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : '',
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function scriptDir(source: string, filename = 'main.py'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rcja-sandbox-test-'));
  await writeFile(join(dir, filename), source);
  return dir;
}

describe.skipIf(!sandboxAvailable())('spawnSandboxed', () => {
  it('runs a plain script and returns its output', async () => {
    const dir = await scriptDir('print("hello from the sandbox")\n');
    const child = spawnSandboxed({
      entry: join(dir, 'main.py'),
      cwd: dir,
      pythonLibDir: PYTHON_LIB_DIR,
      args: [],
    });
    const { code, stdout } = await collect(child);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('hello from the sandbox');
  }, 10000);

  it('can import rcja_soccer, which is bound in read-only', async () => {
    const dir = await scriptDir('import rcja_soccer\nprint(rcja_soccer.__version__)\n');
    const child = spawnSandboxed({
      entry: join(dir, 'main.py'),
      cwd: dir,
      pythonLibDir: PYTHON_LIB_DIR,
      args: [],
    });
    const { code, stdout, stderr } = await collect(child);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout.trim().length).toBeGreaterThan(0);
  }, 10000);

  it('has no network', async () => {
    const dir = await scriptDir(
      [
        'import socket',
        'try:',
        '    socket.create_connection(("1.1.1.1", 80), timeout=2)',
        '    print("connected")',
        'except OSError as error:',
        '    print(f"blocked: {error}")',
      ].join('\n'),
    );
    const child = spawnSandboxed({
      entry: join(dir, 'main.py'),
      cwd: dir,
      pythonLibDir: PYTHON_LIB_DIR,
      args: [],
    });
    const { stdout } = await collect(child);
    expect(stdout).toContain('blocked');
  }, 10000);

  it('cannot see a file outside its own folder', async () => {
    const secretDir = await mkdtemp(join(tmpdir(), 'rcja-sandbox-secret-'));
    const secretPath = join(secretDir, 'secret.txt');
    await writeFile(secretPath, 'top secret');

    const dir = await scriptDir(
      [
        'import sys',
        `try:`,
        `    open(${JSON.stringify(secretPath)}).read()`,
        `    print("read it")`,
        `except OSError as error:`,
        `    print(f"blocked: {error}")`,
      ].join('\n'),
    );
    const child = spawnSandboxed({
      entry: join(dir, 'main.py'),
      cwd: dir,
      pythonLibDir: PYTHON_LIB_DIR,
      args: [],
    });
    const { stdout } = await collect(child);
    expect(stdout).toContain('blocked');
  }, 10000);

  /** Genuinely burns a fixed amount of CPU rather than sleeping, so a quota sees it. */
  const burnCpuSeconds = (seconds: number): string =>
    [
      'import time',
      'start = time.process_time()',
      `while time.process_time() - start < ${seconds}:`,
      '    pass',
      'print("finished")',
    ].join('\n');

  it('throttles a CPU-bound script under a tight quota rather than killing it', async () => {
    const tightDir = await scriptDir(burnCpuSeconds(0.6));
    const roomyDir = await scriptDir(burnCpuSeconds(0.6));

    const timed = async (dir: string, cpuQuotaPercent: number): Promise<number> => {
      const start = Date.now();
      const child = spawnSandboxed({
        entry: join(dir, 'main.py'),
        cwd: dir,
        pythonLibDir: PYTHON_LIB_DIR,
        cpuQuotaPercent,
        args: [],
      });
      const { code, stdout } = await collect(child);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe('finished');
      return Date.now() - start;
    };

    const tightMs = await timed(tightDir, 15);
    const roomyMs = await timed(roomyDir, 200);
    // Both finish — the quota throttles, it does not cut the process off —
    // but the tight one visibly takes longer to spend the same CPU budget.
    expect(tightMs).toBeGreaterThan(roomyMs * 1.5);
  }, 20000);

  it('OOM-kills a script that exceeds its memory ceiling', async () => {
    const dir = await scriptDir(
      [
        'buf = bytearray(150 * 1024 * 1024)',
        'buf[0] = 1',
        'print("finished")',
      ].join('\n'),
    );
    const child = spawnSandboxed({
      entry: join(dir, 'main.py'),
      cwd: dir,
      pythonLibDir: PYTHON_LIB_DIR,
      memoryLimitMb: 30,
      args: [],
    });
    const { code, stdout } = await collect(child);
    expect(stdout).not.toContain('finished');
    expect(code).not.toBe(0);
  }, 15000);

  it('passes CLI arguments through to the entry point', async () => {
    const dir = await scriptDir('import sys\nprint(" ".join(sys.argv[1:]))\n');
    const child = spawnSandboxed({
      entry: join(dir, 'main.py'),
      cwd: dir,
      pythonLibDir: PYTHON_LIB_DIR,
      args: ['--team', 'violet', '--number', '1'],
    });
    const { stdout } = await collect(child);
    expect(stdout.trim()).toBe('--team violet --number 1');
  }, 10000);
});
