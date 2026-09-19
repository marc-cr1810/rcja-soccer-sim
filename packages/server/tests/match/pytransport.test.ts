/**
 * The Python library's transport seam, exercised without a socket.
 *
 * `rcja_soccer` has no test suite of its own and deliberately no pytest to run
 * one with — the package's whole argument is that it installs nothing. So the
 * Python is driven the way `pyimports.test.ts` drives it: spawn the
 * interpreter, let it assert against itself, and read the result back as JSON.
 *
 * What is being proved here is the precondition for a robot running in a
 * browser tab: that a host can put its own channel under `Robot.run()` and the
 * program on top never finds out. Everything else in this file is the
 * behaviour that has to survive that substitution, because it is behaviour a
 * match depends on — a crashing tick coasting rather than disconnecting, a
 * kick-off wiping memory, the channel being closed even when the match ended
 * badly.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const pythonAvailable = spawnSync('python3', ['--version']).status === 0;
const PYTHON_DIR = resolve(import.meta.dirname, '../../../../python');

/**
 * A channel that plays a script of messages back and records what it was sent.
 *
 * `recv` raising once the script runs out is not laziness — it is how a real
 * connection ends, and it means the run finishes through the same path a
 * dropped socket takes.
 */
const HARNESS = `
import json, sys
import rcja_soccer
from rcja_soccer.transport import TransportError
from rcja_soccer.memory import Memory
from machine._backend import Runtime

opened = []

class Fake:
    def __init__(self, script):
        self.script = list(script)
        self.sent = []
        self.closed = False

    def send(self, text):
        self.sent.append(json.loads(text))

    def recv(self):
        if not self.script:
            raise TransportError("end of script")
        return json.dumps(self.script.pop(0))

    def close(self):
        self.closed = True

def sensors(clock, pending=False):
    return {"type": "sensors", "frame": {"clock": clock, "kickoff": {"pending": pending}}}

script = [
    {"type": "welcome", "robot": "violet-1", "motors": 3},
    sensors(0.0),
    sensors(1.0),
    sensors(2.0, pending=True),
    sensors(3.0),
    sensors(4.0),
]

channel = Fake(script)

def connect(url):
    if url not in opened:
        opened.append(url)
    return channel

rcja_soccer.use_transport(connect)
rcja_soccer.use_join(token="secret")

rt = Runtime()
rt.team = "violet"
rt.number = 1
rt.name = "ACT"
rt.reconnect_for = 0.0

me = Memory()

raised = None
try:
    rt.ensure_connected()

    # Frame 0.0
    s = rt.sensors()
    me.n = me.get("n", 0) + 1
    rt.send_command(motors=[0.1, 0.2, 0.3, 0.4], say={"n": me.n})
    rt.sync_tick(20)

    # Frame 1.0 (raises, coast)
    try:
        s = rt.sensors()
        if s.clock == 1.0:
            raise RuntimeError("a bug in somebody's robot")
    except RuntimeError:
        pass
    rt.sync_tick(20)

    # Frame 2.0 (kickoff pending, clears memory)
    s = rt.sensors()
    if s.kickoff.pending:
        me.clear()
    me.n = me.get("n", 0) + 1
    rt.send_command(motors=[0.1, 0.2, 0.3, 0.4], say={"n": me.n})
    rt.sync_tick(20)

    # Frame 3.0
    s = rt.sensors()
    rt.sync_tick(20)

    # Frame 4.0 - next tick will exhaust script and raise TransportError
    s = rt.sensors()
    rt.sync_tick(20)
except TransportError as error:
    raised = str(error)

channel.close()

json.dump(
    {
        "opened": opened,
        "join": channel.sent[0] if channel.sent else None,
        "commands": [m["frame"] for m in channel.sent[1:] if m.get("type") == "command"],
        "closed": channel.closed,
        "raised": raised,
        "motor_count": rt.motor_count,
    },
    sys.stdout,
)
`;

function runHarness(): Record<string, any> {
  const result = spawnSync('python3', ['-c', HARNESS], {
    cwd: PYTHON_DIR,
    env: { ...process.env, PYTHONPATH: '.' },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`harness failed:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

describe.skipIf(!pythonAvailable)('the transport seam', () => {
  it('routes a robot through the installed channel instead of a socket', () => {
    const out = runHarness();
    expect(out.opened).toEqual(['ws://localhost:8080/agent']);
  });

  it('joins with what the server expects, token included', () => {
    const out = runHarness();
    expect(out.join).toEqual({
      type: 'join',
      protocol: 5,
      team: 'violet',
      robot: 1,
      name: 'ACT',
      token: 'secret',
    });
  });

  it('takes the motor count from the welcome', () => {
    expect(runHarness().motor_count).toBe(3);
  });

  it('coasts through a tick that raises, rather than ending the match', () => {
    const out = runHarness();
    expect(out.commands.length).toBeGreaterThanOrEqual(2);
    expect(out.commands[0].motors).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('clears memory at a kick-off', () => {
    const out = runHarness();
    expect(out.commands[0].say).toEqual({ n: 1 });
    expect(out.commands[2].say).toEqual({ n: 1 });
  });

  it('closes the channel even when the match ended badly', () => {
    const out = runHarness();
    expect(out.raised).toBe('end of script');
    expect(out.closed).toBe(true);
  });
});
