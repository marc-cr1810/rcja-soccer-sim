import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateSubmission } from '../../src/accounts/submission';
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
from machine import Runtime
from rcja_soccer import coast

rt = Runtime.get()
while True:
    rt.sensors()
    rt.send_command(motors=coast())
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
      'helpers.py': 'def steady():\n    return [0, 0, 0, 0]\n',
      'robot.py':
        ARGPARSE_PREAMBLE +
        `
import time
from helpers import steady
from machine import Runtime

rt = Runtime.get()
while True:
    rt.sensors()
    rt.send_command(motors=steady())
    time.sleep_ms(20)
`,
    });
    const result = await validateSubmission(dir, { pythonLibDir: PYTHON_LIB_DIR });
    expect(result.ok).toBe(true);
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
    const dir = await folder({
      'manifest.json': manifest('robot.py'),
      'robot.py':
        ARGPARSE_PREAMBLE +
        `
import time
from machine import Runtime

rt = Runtime.get()
rt.sensors()
time.sleep(30)
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

from machine import Runtime
rt = Runtime.get()
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
});
