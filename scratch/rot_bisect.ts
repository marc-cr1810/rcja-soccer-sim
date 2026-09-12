/**
 * Find the exact control cycle where a match stops being its own rotation.
 *
 * A match's 180-degree rotation is the SAME half with the other team kicking
 * off. resetRobots places by `sideSign(team) * distance`, so flipping who
 * kicks off puts every robot at the mirror of where it stood; relabel cyan as
 * yellow and the two runs are each other's image. Both teams run identical
 * programs, so nothing else has to change.
 *
 * Invariant, every cycle:
 *
 *     B.ball          == -A.ball
 *     B.<swapped id>  == (-x, -z, heading + PI) of A.<id>
 *     B.motors[<swapped id>] == A.motors[<id>]
 *
 * The first cycle that breaks it names the tick, the robot and the quantity.
 * That only works because `playLockstep` makes each run a pure function of the
 * seed; polled, the two runs differ immediately and for no reason.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { MatchServer } from '../src/server';
import { playLockstep } from '../src/lockstep';
import type { Match } from '../src/match';

const HALF = Number.parseInt(process.argv.find((a) => a.startsWith('--half='))?.split('=')[1] ?? '30', 10);
const SEED = Number.parseInt(process.argv.find((a) => a.startsWith('--seed='))?.split('=')[1] ?? '4', 10);
const TOL = Number.parseFloat(process.argv.find((a) => a.startsWith('--tol='))?.split('=')[1] ?? '1e-6');

const groups = new Set<number>();
const reap = (): void => {
  for (const pid of groups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  groups.clear();
};
process.on('exit', reap);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => { reap(); process.exit(128); });

const swap = (id: string): string =>
  id.startsWith('cyan') ? id.replace('cyan', 'yellow') : id.replace('yellow', 'cyan');

const wrap = (v: number): number => Math.atan2(Math.sin(v), Math.cos(v));

interface Snap {
  clock: number;
  ball: { x: number; z: number; vx: number; vz: number };
  robots: { id: string; x: number; z: number; heading: number; motors: number[] }[];
}

async function seats(server: MatchServer): Promise<void> {
  const want = ['cyan-1', 'cyan-2', 'yellow-1', 'yellow-2'];
  const deadline = Date.now() + 30000;
  for (;;) {
    const t = server.agents.transports();
    if (want.every((id) => t[id as never])) return;
    if (Date.now() > deadline) throw new Error('timeout waiting for seats');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function run(kicksOff: 'cyan' | 'yellow'): Promise<Snap[]> {
  const server = new MatchServer({ port: 0, realtime: false, idealSensors: true });
  const port = await server.listen();
  const kid: ChildProcess = spawn(`python3 python/examples/play.py --url ws://localhost:${port}/agent`, {
    shell: true,
    stdio: 'ignore',
    detached: true,
  });
  if (kid.pid) groups.add(kid.pid);
  try {
    await seats(server);
    const trace: Snap[] = [];
    await playLockstep({
      agents: {} as never,
      transports: server.agents.transports(),
      halfSeconds: HALF,
      seed: SEED,
      idealSensors: true,
      halves: [1],
      kickOffFor: () => kicksOff,
      onCycle: (m: Match) => {
        trace.push({
          clock: m.world.clock,
          ball: { x: m.world.ball.x, z: m.world.ball.z, vx: m.world.ball.vx, vz: m.world.ball.vz },
          robots: m.world.robots.map((r) => ({
            id: r.id,
            x: r.x,
            z: r.z,
            heading: r.heading,
            motors: [...r.motors],
          })),
        });
      },
    });
    return trace;
  } finally {
    if (kid.pid) {
      try {
        process.kill(-kid.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      groups.delete(kid.pid);
    }
    await server.close();
  }
}

function compare(a: Snap[], b: Snap[]): void {
  const n = Math.min(a.length, b.length);
  console.log(`comparing ${n} control cycles (A ${a.length}, B ${b.length})\n`);

  for (let i = 0; i < n; i++) {
    const A = a[i]!;
    const B = b[i]!;
    const bad: string[] = [];

    const d = (what: string, got: number, want: number): void => {
      if (Math.abs(got - want) > TOL) bad.push(`${what}: B ${got.toFixed(4)} vs rotated-A ${want.toFixed(4)}`);
    };

    d('ball.x', B.ball.x, -A.ball.x);
    d('ball.z', B.ball.z, -A.ball.z);
    d('ball.vx', B.ball.vx, -A.ball.vx);
    d('ball.vz', B.ball.vz, -A.ball.vz);

    for (const ra of A.robots) {
      const rb = B.robots.find((r) => r.id === swap(ra.id));
      if (!rb) continue;
      d(`${ra.id}->${rb.id}.x`, rb.x, -ra.x);
      d(`${ra.id}->${rb.id}.z`, rb.z, -ra.z);
      if (Math.abs(wrap(rb.heading - (ra.heading + Math.PI))) > TOL) {
        bad.push(`${ra.id}->${rb.id}.heading off by ${wrap(rb.heading - (ra.heading + Math.PI)).toFixed(6)}`);
      }
      for (let m = 0; m < ra.motors.length; m++) {
        d(`${ra.id}->${rb.id}.motor${m}`, rb.motors[m]!, ra.motors[m]!);
      }
    }

    if (bad.length > 0) {
      console.log(`FIRST DIVERGENCE at cycle ${i}, clock ${A.clock.toFixed(2)}s:`);
      for (const line of bad.slice(0, 12)) console.log(`  ${line}`);
      if (bad.length > 12) console.log(`  ... and ${bad.length - 12} more`);
      console.log(`\n  A: ball (${A.ball.x.toFixed(1)}, ${A.ball.z.toFixed(1)})`);
      for (const r of A.robots) {
        console.log(`     ${r.id.padEnd(9)} (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) hdg ${r.heading.toFixed(3)} motors [${r.motors.map((v) => v.toFixed(3)).join(', ')}]`);
      }
      console.log(`  B: ball (${B.ball.x.toFixed(1)}, ${B.ball.z.toFixed(1)})`);
      for (const r of B.robots) {
        console.log(`     ${r.id.padEnd(9)} (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) hdg ${r.heading.toFixed(3)} motors [${r.motors.map((v) => v.toFixed(3)).join(', ')}]`);
      }
      return;
    }
  }
  console.log('>>> the two runs stayed each other\'s rotation for the whole half');
}

async function main(): Promise<void> {
  console.log('run A: cyan kicks off');
  const a = await run('cyan');
  console.log('run B: yellow kicks off (the 180-degree rotation of A)\n');
  const b = await run('yellow');
  compare(a, b);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
