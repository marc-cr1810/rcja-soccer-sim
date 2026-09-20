import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ALLOWED_EXTRA, validateSubmission } from '../../src/accounts/submission';
import { sandboxAvailable } from '../../src/match/sandbox';

const PYTHON_LIB_DIR = resolve(import.meta.dirname, '../../../../python');
const pythonAvailable = spawnSync('python3', ['--version']).status === 0;
const ready = pythonAvailable && sandboxAvailable();

const ARGPARSE_PREAMBLE = `
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--team", default="violet")
parser.add_argument("--number", type=int, default=1)
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--token", default=None)
args = parser.parse_args()
`;

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rcja-submission-test-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

function manifest(entry: string, robot = 1): string {
  return JSON.stringify({ team: 'Test Team', robot, entry });
}

describe.skipIf(!ready)('validateSubmission', () => {
  it('accepts a robot that connects and answers a sensor frame', async () => {
    const dir = await folder({
      'manifest.json': manifest('robot.py'),
      'robot.py':
        ARGPARSE_PREAMBLE +
        `
import time
from machine import ADC, PWM, Pin

wheel = PWM(Pin(12), freq=1000, duty_u16=0)
ball = ADC(Pin(4))
while True:
    ball.read_u16()
    wheel.duty_u16(0)
    time.sleep_ms(20)
`,
    });
    const result = await validateSubmission(dir, { pythonLibDir: PYTHON_LIB_DIR });
    expect(result).toMatchObject({ ok: true, value: { team: 'Test Team', robot: 1, entry: 'robot.py' } });
  }, 15000);

  it('rejects a folder with no manifest.json', async () => {
    const dir = await folder({ 'robot.py': 'print("hi")\n' });
    const result = await validateSubmission(dir, { pythonLibDir: PYTHON_LIB_DIR });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('manifest.json') });
  });

  it('rejects an entry file with a syntax error', async () => {
    const dir = await folder({
      'manifest.json': manifest('robot.py'),
      'robot.py': 'def broken(:\n',
    });
    const result = await validateSubmission(dir, { pythonLibDir: PYTHON_LIB_DIR });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('does not parse') });
  });

  it('rejects an entry that imports something outside the standard library', async () => {
    const dir = await folder({
      'manifest.json': manifest('robot.py'),
      'robot.py': 'import numpy\n',
    });
    const result = await validateSubmission(dir, { pythonLibDir: PYTHON_LIB_DIR });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('numpy') });
  });

  it('allows importing a local sibling module', async () => {
    const dir = await folder({
      'manifest.json': manifest('robot.py'),
      'helpers.py': 'def steady():\n    return 0\n',
      'robot.py':
        ARGPARSE_PREAMBLE +
        `
import time
from helpers import steady
from machine import PWM, Pin

wheel = PWM(Pin(12), freq=1000, duty_u16=0)
while True:
    wheel.duty_u16(steady())
    time.sleep_ms(20)
`,
    });
    const result = await validateSubmission(dir, { pythonLibDir: PYTHON_LIB_DIR });
    expect(result).toMatchObject({ ok: true });
  }, 15000);

  it('rejects a program that never connects', async () => {
    const dir = await folder({
      'manifest.json': manifest('robot.py'),
      'robot.py': 'import time\ntime.sleep(30)\n',
    });
    const result = await validateSubmission(dir, {
      pythonLibDir: PYTHON_LIB_DIR,
      connectTimeoutMs: 800,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('did not connect') });
  }, 15000);

  it('rejects a program that connects but never answers a tick', async () => {
    /*
     * Blocks on an event rather than on `time.sleep(30)`, which is what this
     * fixture used to do. A sleep no longer describes a silent robot: seconds
     * and milliseconds both flush the actuator frame now, so a sleeping
     * program answers every tick it sleeps through, the same as a board keeps
     * driving. Going quiet has to mean actually blocking on something else.
     */
    const dir = await folder({
      'manifest.json': manifest('robot.py'),
      'robot.py':
        ARGPARSE_PREAMBLE +
        `
import threading
from machine import ADC, Pin

ADC(Pin(4)).read_u16()
threading.Event().wait()
`,
    });
    const result = await validateSubmission(dir, {
      pythonLibDir: PYTHON_LIB_DIR,
      tickTimeoutMs: 800,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('never answered') });
  }, 15000);

  it('rejects an entry script whose argparse has no --token', async () => {
    // Every lineup-spawned seat is given --token at match time; catching an
    // entry script that doesn't accept it here, at push time, beats finding
    // out only once it's actually spawned for a real match.
    const dir = await folder({
      'manifest.json': manifest('robot.py'),
      'robot.py': `
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--team", default="violet")
parser.add_argument("--number", type=int, default=1)
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
args = parser.parse_args()

from machine import ADC, Pin
ADC(Pin(4)).read_u16()
`,
    });
    const result = await validateSubmission(dir, {
      pythonLibDir: PYTHON_LIB_DIR,
      connectTimeoutMs: 800,
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('did not connect') });
  }, 15000);

  it('accepts a pure MicroPython robot using machine and utime', async () => {
    const dir = await folder({
      'manifest.json': manifest('main.py'),
      'main.py': `
from machine import Pin, PWM, ADC
import time

m0 = PWM(Pin(12))
m0_dir = Pin(13, Pin.OUT)
ball = ADC(Pin(4))

while True:
    val = ball.read_u16()
    m0_dir.value(0)
    m0.duty_u16(10000)
    time.sleep_ms(20)
`,
    });
    const result = await validateSubmission(dir, { pythonLibDir: PYTHON_LIB_DIR });
    expect(result).toMatchObject({ ok: true, value: { team: 'Test Team', robot: 1, entry: 'main.py' } });
  }, 15000);

  it('accepts a robot whose first line is "from time import sleep_ms"', async () => {
    /*
     * The spelling a MicroPython book uses, and for a long time the one that
     * could not work: `sleep_ms` is attached to `time` by `machine`, so a file
     * that reached for it before importing `machine` raised ImportError at
     * startup - which arrived here as an unexplained "did not connect within
     * 5s", because nothing in the import check can see it. `pyimports.ts`
     * records an `ImportFrom` as the module name alone and never looks at
     * `node.names`, so this validates whether or not it can actually run.
     * `python/sitecustomize.py` is what makes it run; this is the test that
     * the sandbox's PYTHONPATH really does pick that hook up.
     */
    const dir = await folder({
      'manifest.json': manifest('main.py'),
      'main.py': `
from time import sleep_ms
from machine import Pin, PWM

m0 = PWM(Pin(12))
while True:
    m0.duty_u16(10000)
    sleep_ms(20)
`,
    });
    const result = await validateSubmission(dir, { pythonLibDir: PYTHON_LIB_DIR });
    expect(result).toMatchObject({ ok: true, value: { team: 'Test Team', robot: 1, entry: 'main.py' } });
  }, 15000);

  it('accepts the u* module names a board uses for the standard library', async () => {
    const dir = await folder({
      'manifest.json': manifest('main.py'),
      'main.py': `
import ustruct
import utime
from micropython import const
from machine import Pin, PWM

SPEED = const(10000)
m0 = PWM(Pin(12))
while True:
    ustruct.pack("<h", SPEED)
    m0.duty_u16(SPEED)
    utime.sleep_ms(20)
`,
    });
    const result = await validateSubmission(dir, { pythonLibDir: PYTHON_LIB_DIR });
    expect(result).toMatchObject({ ok: true, value: { team: 'Test Team', robot: 1, entry: 'main.py' } });
  }, 15000);
});

describe('the import allowlist and what the package ships', () => {
  /*
   * Two hand-maintained lists that have to agree: `ALLOWED_EXTRA` in
   * `submission.ts`, and `py-modules` in `python/pyproject.toml`. A name in
   * the first but not the second is a module we let a team import and then do
   * not ship; a name in the second but not the first is one we ship and then
   * refuse to let anybody use - which is how `machine` and `utime` would have
   * behaved had they not been added here by hand.
   */
  it('allows every MicroPython module the wheel ships', async () => {
    const { readFile } = await import('node:fs/promises');
    const pyproject = await readFile(join(PYTHON_LIB_DIR, 'pyproject.toml'), 'utf8');
    const block = pyproject.slice(pyproject.indexOf('py-modules'));
    const shipped = [...block.slice(0, block.indexOf(']')).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

    // Tooling and the startup hook ship in the wheel but are not things a
    // robot imports, so they are deliberately absent from the allowlist.
    const notForRobots = new Set(['join', 'submit', 'rcja_soccer_bootstrap']);
    const importable = shipped.filter((name) => !notForRobots.has(name));

    expect(importable.length).toBeGreaterThan(10);
    expect(importable.filter((name) => !ALLOWED_EXTRA.has(name))).toEqual([]);
  });

  it('does not allow a module that is not shipped at all', () => {
    // `machine` and `rcja_soccer` are packages rather than py-modules, so they
    // are the two names the check above cannot see; everything else in the
    // allowlist has to come from somewhere.
    expect(ALLOWED_EXTRA.has('machine')).toBe(true);
    expect(ALLOWED_EXTRA.has('rcja_soccer')).toBe(true);
    expect(ALLOWED_EXTRA.has('numpy')).toBe(false);
  });
});
