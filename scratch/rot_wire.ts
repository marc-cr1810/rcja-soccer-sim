/**
 * Same paired run as rot_bisect, but taps the WIRE.
 *
 * rot_bisect says the two runs are each other's rotation to 1e-9 for twenty
 * cycles and then the commands diverge completely. That leaves exactly two
 * possibilities and this tells them apart: either the two robots were sent
 * different frames (the simulator or the frame-building is asymmetric), or
 * they were sent mirrored frames and answered differently (the program is).
 *
 * So it records every frame sent and every command returned, per seat, per
 * cycle, and diffs A's yellow-1 against B's cyan-1 under the rotation map.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { MatchServer } from '../src/server';
import { playLockstep } from '../src/lockstep';
import type { Transport } from '../src/agent';
import type { SensorFrame, ActuatorFrame } from '../src/protocol';

const HALF = Number.parseInt(process.argv.find((a) => a.startsWith('--half='))?.split('=')[1] ?? '10', 10);
const SEED = Number.parseInt(process.argv.find((a) => a.startsWith('--seed='))?.split('=')[1] ?? '4', 10);

const groups = new Set<number>();
const reap = (): void => {
  for (const pid of groups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  }
  groups.clear();
};
process.on('exit', reap);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => { reap(); process.exit(128); });

const wrap = (v: number): number => Math.atan2(Math.sin(v), Math.cos(v));

interface Wire {
  frames: SensorFrame[];
  commands: (ActuatorFrame | null)[];
}

async function run(kicksOff: 'cyan' | 'yellow'): Promise<Record<string, Wire>> {
  const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
  const port = await server.listen();
  const kid: ChildProcess = spawn(`python3 python/examples/play.py --url ws://localhost:${port}/agent`, {
    shell: true, stdio: 'ignore', detached: true,
  });
  if (kid.pid) groups.add(kid.pid);
  try {
    const want = ['cyan-1', 'cyan-2', 'yellow-1', 'yellow-2'];
    const deadline = Date.now() + 30000;
    for (;;) {
      const t = server.agents.transports();
      if (want.every((id) => t[id as never])) break;
      if (Date.now() > deadline) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 100));
    }

    const transports = server.agents.transports();
    const wire: Record<string, Wire> = {};
    for (const [id, t] of Object.entries(transports)) {
      if (!t) continue;
      wire[id] = { frames: [], commands: [] };
      const real = t as Transport;
      const send = real.send.bind(real);
      const take = real.take.bind(real);
      (real as { send: Transport['send'] }).send = (f: SensorFrame): void => {
        wire[id]!.frames.push(JSON.parse(JSON.stringify(f)) as SensorFrame);
        send(f);
      };
      (real as { take: Transport['take'] }).take = (): ActuatorFrame | null => {
        const c = take();
        wire[id]!.commands.push(c ? (JSON.parse(JSON.stringify(c)) as ActuatorFrame) : null);
        return c;
      };
    }

    await playLockstep({
      agents: {} as never,
      transports,
      halfSeconds: HALF,
      seed: SEED,
      idealSensors: true,
      halves: [1],
      kickOffFor: () => kicksOff,
    });
    return wire;
  } finally {
    if (kid.pid) {
      try { process.kill(-kid.pid, 'SIGKILL'); } catch { /* gone */ }
      groups.delete(kid.pid);
    }
    await server.close();
  }
}

/** Everything in a frame that a rotation must leave alone, or flip by PI. */
function frameDiff(A: SensorFrame, B: SensorFrame): string[] {
  const out: string[] = [];
  const near = (what: string, a: number | null | undefined, b: number | null | undefined, tol = 1e-9): void => {
    if (a == null && b == null) return;
    if (a == null || b == null) { out.push(`${what}: A ${a} B ${b}`); return; }
    if (Math.abs(a - b) > tol) out.push(`${what}: A ${a.toFixed(9)} B ${b.toFixed(9)}  (d ${(b - a).toExponential(2)})`);
  };
  const ang = (what: string, a: number, b: number): void => {
    const d = wrap(b - (a + Math.PI));
    if (Math.abs(d) > 1e-9) out.push(`${what}: A ${a.toFixed(9)} B ${b.toFixed(9)}  (B-(A+PI) = ${d.toExponential(2)})`);
  };

  near('clock', A.clock, B.clock);
  ang('compass.heading', A.compass.heading, B.compass.heading);
  near('ball.bearing', A.ball?.bearing, B.ball?.bearing);
  near('ball.strength', A.ball?.strength, B.ball?.strength);
  for (const k of ['front', 'left', 'back', 'right'] as const) near(`range.${k}`, A.range[k], B.range[k]);
  for (let i = 0; i < A.encoders.length; i++) near(`encoders[${i}]`, A.encoders[i], B.encoders[i]);
  for (let i = 0; i < A.lines.length; i++) {
    near(`lines[${i}].value`, A.lines[i]!.value, B.lines[i]!.value);
    near(`lines[${i}].bearing`, A.lines[i]!.bearing, B.lines[i]!.bearing);
  }
  // Goals swap labels under the rotation.
  for (const [ka, kb] of [['cyan', 'yellow'], ['yellow', 'cyan']] as const) {
    near(`camera.goals.${ka}.bearing`, A.camera.goals[ka]?.bearing, B.camera.goals[kb]?.bearing);
    near(`camera.goals.${ka}.range`, A.camera.goals[ka]?.range, B.camera.goals[kb]?.range);
  }
  near('camera.ball.bearing', A.camera.ball?.bearing, B.camera.ball?.bearing);
  near('camera.ball.range', A.camera.ball?.range, B.camera.ball?.range);
  if (A.ballGate.held !== B.ballGate.held) out.push(`ballGate.held: A ${A.ballGate.held} B ${B.ballGate.held}`);
  if (A.kickoff.pending !== B.kickoff.pending) out.push(`kickoff.pending: A ${A.kickoff.pending} B ${B.kickoff.pending}`);
  if (A.kickoff.ours !== B.kickoff.ours) out.push(`kickoff.ours: A ${A.kickoff.ours} B ${B.kickoff.ours}`);
  if (A.messages.length !== B.messages.length) out.push(`messages: A ${A.messages.length} B ${B.messages.length}`);
  return out;
}

async function main(): Promise<void> {
  console.log('run A: cyan kicks off');
  const a = await run('cyan');
  console.log('run B: yellow kicks off\n');
  const b = await run('yellow');

  for (const [idA, idB] of [['yellow-1', 'cyan-1'], ['cyan-1', 'yellow-1'], ['yellow-2', 'cyan-2'], ['cyan-2', 'yellow-2']] as const) {
    const WA = a[idA]!;
    const WB = b[idB]!;
    const n = Math.min(WA.frames.length, WB.frames.length);
    let firstFrame = -1;
    let firstCmd = -1;
    for (let i = 0; i < n && (firstFrame < 0 || firstCmd < 0); i++) {
      if (firstFrame < 0 && frameDiff(WA.frames[i]!, WB.frames[i]!).length > 0) firstFrame = i;
      const ca = WA.commands[i];
      const cb = WB.commands[i];
      if (firstCmd < 0 && ca && cb) {
        const diff = ca.motors.some((v, m) => Math.abs(v - cb.motors[m]!) > 1e-9);
        if (diff) firstCmd = i;
      }
    }
    console.log(`A.${idA} vs B.${idB}:  first frame difference at cycle ${firstFrame < 0 ? 'never' : firstFrame}` +
      `,  first command difference at cycle ${firstCmd < 0 ? 'never' : firstCmd}`);
    // How the command difference GROWS. Smooth growth from the float noise is
    // chaos; a jump straight to O(1) is a branch taken differently.
    if (firstCmd >= 0) {
      const mags: string[] = [];
      for (let i = firstCmd; i < Math.min(firstCmd + 12, n); i++) {
        const ca = WA.commands[i];
        const cb = WB.commands[i];
        if (!ca || !cb) continue;
        const m = Math.max(...ca.motors.map((v, k) => Math.abs(v - cb.motors[k]!)));
        mags.push(`c${i}:${m.toExponential(1)}`);
      }
      console.log(`   |dmotor| from there: ${mags.join('  ')}`);
    }
    if (firstFrame >= 0) {
      console.log(`   frame differences at cycle ${firstFrame}:`);
      for (const line of frameDiff(WA.frames[firstFrame]!, WB.frames[firstFrame]!).slice(0, 10)) {
        console.log(`     ${line}`);
      }
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
