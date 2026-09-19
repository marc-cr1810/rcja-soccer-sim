/**
 * The MicroPython compatibility layer's wire contract, exercised without a socket.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const pythonAvailable = spawnSync('python3', ['--version']).status === 0;
const PYTHON_DIR = resolve(import.meta.dirname, '../../../../python');

const MICROPYTHON_HARNESS = `
import json, sys
import rcja_soccer
from rcja_soccer.transport import TransportError
from machine import Pin, PWM, ADC
import time

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

def sensors(clock, ball_strength=0.8, ball_bearing=0.0):
    return {
        "type": "sensors",
        "frame": {
            "clock": clock,
            "ball": {"strength": ball_strength, "bearing": ball_bearing},
            "lines": [{"value": 0.1}, {"value": 0.9}],
            "range": {"front": 1000},
            "compass": {"heading": 0.0},
            "gyro": {"rate": 0.0},
        }
    }

script = [
    {"type": "welcome", "robot": "violet-1", "motors": 4},
    sensors(0.0, ball_strength=0.5),
    sensors(0.02, ball_strength=0.9),
    sensors(0.04, ball_strength=0.1),
    # One more than the loop below consumes: machine.Runtime now retries a
    # dropped connection instead of raising immediately (see
    # test_runtime.py), so running this script dry mid-loop would trigger a
    # real reconnect attempt against this same exhausted fake channel rather
    # than the clean "TransportError propagates" this harness used to lean
    # on incidentally. Giving it one spare frame keeps the loop finishing
    # normally, which is what every assertion below actually checks.
    sensors(0.06, ball_strength=0.1),
]

channel = Fake(script)

def connect(url):
    opened.append(url)
    return channel

rcja_soccer.use_transport(connect)

# MicroPython Hardware Init
pwm0 = PWM(Pin(12), freq=1000, duty_u16=32768)  # 50% duty
dir0 = Pin(13, Pin.OUT)
dir0.value(0)  # Forward

kicker = Pin(27, Pin.OUT)
dribbler = PWM(Pin(26), duty_u16=65535)

ball = ADC(Pin(4))

readings = []
raised = None

try:
    for step in range(3):
        strength = ball.read_u16()
        readings.append(strength)
        if strength > 50000:
            kicker.on()
        time.sleep_ms(20)
except TransportError as error:
    raised = str(error)

json.dump(
    {
        "opened": opened,
        "join": channel.sent[0] if channel.sent else None,
        "commands": [m["frame"] for m in channel.sent[1:]],
        "readings": readings,
        "raised": raised,
    },
    sys.stdout,
)
`;

describe.skipIf(!pythonAvailable)('the MicroPython transport and wire contract', () => {
  function runHarness(): any {
    const proc = spawnSync('python3', ['-c', MICROPYTHON_HARNESS], {
      cwd: PYTHON_DIR,
      env: { ...process.env, PYTHONPATH: PYTHON_DIR },
      encoding: 'utf8',
    });
    if (proc.status !== 0) {
      throw new Error(`Python harness failed (code ${proc.status}):\n${proc.stderr}`);
    }
    return JSON.parse(proc.stdout);
  }

  it('routes pure MicroPython code through the installed channel and sends join message', () => {
    const result = runHarness();
    expect(result.opened.length).toBeGreaterThan(0);
    expect(result.join).toMatchObject({
      type: 'join',
      protocol: 5,
    });
  });

  it('translates PWM and Pin writes to ActuatorFrame motors, dribbler, and kicker', () => {
    const result = runHarness();
    expect(result.commands.length).toBeGreaterThanOrEqual(2);

    // Initial command: 50% PWM forward on motor 0, full dribbler, no kicker
    const cmd0 = result.commands[0];
    expect(cmd0.motors[0]).toBeCloseTo(0.5, 1);
    expect(cmd0.dribbler).toBeCloseTo(1.0, 1);
    expect(cmd0.kicker).toBe(false);

    // Second command: ball strength > 50000 triggered kicker.on()
    const cmd1 = result.commands[1];
    expect(cmd1.kicker).toBe(true);
  });

  it('reads sensor frame values through ADC.read_u16', () => {
    const result = runHarness();
    expect(result.readings.length).toBeGreaterThanOrEqual(2);
    // 0.5 * 65535 ~ 32767
    expect(result.readings[0]).toBeCloseTo(32767, -2);
    // 0.9 * 65535 ~ 58981
    expect(result.readings[1]).toBeCloseTo(58981, -2);
  });
});
