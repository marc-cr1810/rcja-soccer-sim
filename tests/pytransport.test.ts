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
import { join } from 'node:path';

const pythonAvailable = spawnSync('python3', ['--version']).status === 0;
const PYTHON_DIR = join(import.meta.dirname, '..', 'python');

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
from rcja_soccer import Robot, TransportError

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
    sensors(1.0),           # the tick raises on this one
    sensors(2.0, pending=True),
    sensors(3.0),           # the tick returns None on this one
]

channel = Fake(script)

def connect(url):
    opened.append(url)
    return channel

rcja_soccer.use_transport(connect)

robot = Robot(team="violet", number=1, name="ACT", token="secret")

@robot.tick
def think(s, me):
    me.n = me.get("n", 0) + 1
    if s.clock == 1.0:
        raise RuntimeError("a bug in somebody's robot")
    if s.clock == 3.0:
        return None
    return robot.motors([0.1, 0.2, 0.3, 0.4], say={"n": me.n})

raised = None
try:
    robot.run(reconnect=False, quiet=True)
except TransportError as error:
    raised = str(error)

json.dump(
    {
        "opened": opened,
        "join": channel.sent[0] if channel.sent else None,
        "commands": [m["frame"] for m in channel.sent[1:]],
        "closed": channel.closed,
        "raised": raised,
        "motor_count": robot.motor_count,
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
    // The default URL still points at a venue server; what changed is who
    // opens it. A program that names no URL at all is the case that matters,
    // because in a tab that is every program.
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
    // Four sensor frames went in. One raised and one returned None, so two
    // commands come back — and the run carried on past the crash to reach the
    // frames after it, which is the whole point.
    expect(out.commands).toHaveLength(2);
    expect(out.commands[0].motors).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('clears memory at a kick-off', () => {
    const out = runHarness();
    // The tick counts its own calls in memory. It ran three times before the
    // kick-off frame; if memory survived one, the second command would say 4.
    expect(out.commands[0].say).toEqual({ n: 1 });
    expect(out.commands[1].say).toEqual({ n: 1 });
  });

  it('closes the channel even when the match ended badly', () => {
    const out = runHarness();
    expect(out.raised).toBe('end of script');
    expect(out.closed).toBe(true);
  });
});
