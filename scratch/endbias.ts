/**
 * Which END do goals go into?
 *
 * Measured from the SCORER + the half, not from ball.x: detectGoal() calls
 * kickOff() in the same tick, which puts the ball back on the centre spot
 * before any observer runs, so ball.x is always 0 when a goal is seen.
 *
 *   --who=python | reference
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { MatchServer } from '../src/server';
import { referenceTeam } from '../src/reference';
import { World } from '../src/world';

/*
 * GROUND TRUTH for which end a goal went in.
 *
 * detectGoal() calls kickOff() in the same tick, which puts the ball back on
 * the centre spot, so any observer reading ball.x after the fact sees 0. Wrap
 * detectGoal and record ball.x at the moment the back wall was struck, plus
 * the half and who was defending which end at that moment. Everything else
 * this probe prints is then checked against it.
 */
type Truth = { half: 1 | 2; ballX: number; scorer: 'cyan' | 'yellow'; cyanDefends: string };
const truth: Truth[] = [];
{
  const proto = World.prototype as any;
  const real = proto.detectGoal;
  proto.detectGoal = function (hit: string) {
    if (hit === 'goal-back') {
      const before = { cyan: this.score.cyan, yellow: this.score.yellow };
      const ballX = this.ball.x;
      const half = this.half;
      const cyanDefends = this.defendingGoal('cyan');
      const out = real.call(this, hit);
      for (const t of ['cyan', 'yellow'] as const) {
        if (this.score[t] > before[t]) truth.push({ half, ballX, scorer: t, cyanDefends });
      }
      return out;
    }
    return real.call(this, hit);
  };
}

const SEEDS = Number.parseInt(process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? '10', 10);
const HALF = Number.parseInt(process.argv.find((a) => a.startsWith('--half='))?.split('=')[1] ?? '45', 10);
const WHO = process.argv.find((a) => a.startsWith('--who='))?.split('=')[1] ?? 'python';
// Realistic sensors by default. With idealSensors the reference keeper is never
// beaten and a match ends 0-0, which is not a regime any bias can be read from.
const IDEAL = process.argv.includes('--ideal');
/*
 * Break the kick-off/ends confound.
 *
 * playFast gives the opening kick-off of half 1 to cyan and of half 2 to
 * yellow, and ends swap at half-time - and the two swaps CANCEL, so the team
 * taking the opening kick-off is the team attacking +x in BOTH halves. Any
 * kick-off advantage therefore reads as a +x scoring bias, and surviving the
 * half-time swap is not evidence against it, which is what makes it look like
 * a property of the field.
 *
 * --swapkickoff inverts the opening kick-off of each half. If the lean follows
 * the kick-off it is a kick-off advantage; if it stays at +x it is the field.
 */
const SWAP_KICKOFF = process.argv.includes('--swapkickoff');
if (SWAP_KICKOFF) {
  const proto = World.prototype as any;
  const real = proto.kickOff;
  let lastHalf = 0;
  proto.kickOff = function (team: 'cyan' | 'yellow') {
    if (this.half !== lastHalf) {
      lastHalf = this.half;
      return real.call(this, team === 'cyan' ? 'yellow' : 'cyan');
    }
    return real.call(this, team);
  };
}

type Goal = { half: 1 | 2; scorer: 'cyan' | 'yellow'; end: 'plus' | 'minus'; kickedOff: boolean };

/*
 * Every detached child group this process has started.
 *
 * `finally` is not enough on its own. The robots are spawned detached, so that
 * killing the group gets play.py AND the four robots it starts; the cost is
 * that they do not die with this process. And `finally` does not run when this
 * process is killed rather than asked to stop - `timeout`, ctrl-c, a
 * supervisor - which is exactly how a probe run usually ends. So reap on the
 * way out of every exit that CAN be observed, and let rcja_soccer's bounded
 * reconnect cover the one that cannot (SIGKILL here).
 */
const groups = new Set<number>();

function reap(): void {
  for (const pid of groups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  groups.clear();
}

process.on('exit', reap);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    reap();
    process.exit(128);
  });
}
process.on('uncaughtException', (err) => {
  reap();
  console.error(err);
  process.exit(1);
});

async function waitForSeats(server: MatchServer, ids: string[]): Promise<void> {
  const deadline = Date.now() + 30000;
  for (;;) {
    const t = server.agents.transports();
    if (ids.every((id) => t[id as never])) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for seats`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function playSeed(seed: number): Promise<{ goals: Goal[]; meanX: Record<string, [number, number]>; slots: any; ball: [number, number, number] }> {
  const server = new MatchServer({ port: 0, realtime: false, idealSensors: IDEAL });
  const port = await server.listen();
  const url = `ws://localhost:${port}/agent`;
  const kids: ChildProcess[] = [];
  if (WHO === 'python') {
    const kid = spawn(`python3 python/examples/play.py --url ${url}`, {
      shell: true,
      stdio: 'ignore',
      detached: true,
    });
    kids.push(kid);
    if (kid.pid) groups.add(kid.pid);
  }
  try {
    let transports = {};
    let agents: Record<string, unknown> = {};
    if (WHO === 'python') {
      await waitForSeats(server, ['cyan-1', 'cyan-2', 'yellow-1', 'yellow-2']);
      transports = server.agents.transports();
    } else {
      agents = { ...referenceTeam('cyan'), ...referenceTeam('yellow') };
    }

    const goals: Goal[] = [];
    const prev = { cyan: 0, yellow: 0 };
    // sum of x, and count, per robot per half
    const acc: Record<string, [number, number]> = {};
    let n = 0;
    let ballSum = 0;
    let ballN = 0;
    let ballPlus = 0;
    let lastKickedOff: string | null = null;
    const observe = (match: any): void => {
      const w = match.world;
      if (w.restart.team) lastKickedOff = w.restart.team;
      for (const team of ['cyan', 'yellow'] as const) {
        while (w.score[team] > prev[team]) {
          prev[team]++;
          goals.push({
            half: w.half,
            scorer: team,
            end: w.attackingGoal(team) === 'yellow' ? 'plus' : 'minus',
            // Whether the scorer is the team that took the kick-off this goal
            // followed. Separates "kicking off helps" from "+x helps".
            kickedOff: lastKickedOff === team,
          });
        }
      }
      if (w.running && n++ % 10 === 0) {
        ballSum += w.ball.x;
        ballN += 1;
        if (w.ball.x > 0) ballPlus += 1;
        for (const r of w.robots) {
          const key = `${r.id}-h${w.half}`;
          const a = acc[key] ?? (acc[key] = [0, 0]);
          a[0] += r.x;
          a[1] += 1;
        }
      }
    };

    const result = await server.play({
      agents: agents as never,
      transports,
      halfSeconds: HALF,
      seed,
      idealSensors: IDEAL,
      observe: observe as never,
    });
    return { goals, meanX: acc, slots: result.slots, ball: [ballSum, ballN, ballPlus] as [number, number, number] };
  } finally {
    for (const k of kids) {
      if (!k.pid) continue;
      try {
        process.kill(-k.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      groups.delete(k.pid);
    }
    await server.close();
  }
}

async function main(): Promise<void> {
  const all: Goal[] = [];
  const meanX: Record<string, [number, number]> = {};
  const miss: Record<string, [number, number]> = {};
  const ball: [number, number, number] = [0, 0, 0];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = await playSeed(seed);
    all.push(...r.goals);
    for (const [k, v] of Object.entries(r.meanX)) {
      const a = meanX[k] ?? (meanX[k] = [0, 0]);
      a[0] += v[0];
      a[1] += v[1];
    }
    for (const [k, v] of Object.entries(r.slots as Record<string, any>)) {
      const a = miss[k] ?? (miss[k] = [0, 0]);
      a[0] += v.missed;
      a[1] += v.worstRun;
    }
    ball[0] += r.ball[0]; ball[1] += r.ball[1]; ball[2] += r.ball[2];
    const p = r.goals.filter((g) => g.end === 'plus').length;
    console.log(`seed ${seed}: +x ${p}  -x ${r.goals.length - p}   ${r.goals.map((g) => `h${g.half}:${g.scorer}->${g.end}`).join(' ')}`);
  }
  // -- cross-check the derived classification against ground truth --------
  console.log(`\n-- ground truth (ball.x at the instant the back wall was struck) --`);
  const tPlus = truth.filter((t) => t.ballX > 0).length;
  console.log(`  ${truth.length} goals: ball at +x ${tPlus}   ball at -x ${truth.length - tPlus}`);
  for (const half of [1, 2] as const) {
    const h = truth.filter((t) => t.half === half);
    const defends = new Set(h.map((t) => t.cyanDefends));
    console.log(
      `  half ${half}: +x ${h.filter((t) => t.ballX > 0).length} / -x ${h.filter((t) => t.ballX <= 0).length}` +
        `   (cyan was defending the ${[...defends].join('/')} goal, so cyan attacked ${[...defends].map((d) => (d === 'cyan' ? '+x' : '-x')).join('/')})`,
    );
  }
  const derivedPlus = all.filter((g) => g.end === 'plus').length;
  console.log(
    truth.length === all.length && tPlus === derivedPlus
      ? `  >>> AGREES with the attackingGoal() classification (+x ${derivedPlus})`
      : `  >>> DISAGREES: truth +x ${tPlus} of ${truth.length}, derived +x ${derivedPlus} of ${all.length}`,
  );

  const at = (f: (g: Goal) => boolean): string => {
    const s = all.filter(f);
    return `+x ${s.filter((g) => g.end === 'plus').length} / -x ${s.filter((g) => g.end === 'minus').length}`;
  };
  console.log(`\n[${WHO}${IDEAL ? ' ideal' : ' noisy'}${SWAP_KICKOFF ? ' swapped-kickoff' : ''}] TOTAL goals ${all.length}:  ${at(() => true)}`);
  console.log(`  half 1: ${at((g) => g.half === 1)}      half 2: ${at((g) => g.half === 2)}`);
  console.log(`  by scorer: cyan ${all.filter((g) => g.scorer === 'cyan').length}  yellow ${all.filter((g) => g.scorer === 'yellow').length}`);
  console.log(`\n-- mean robot x, per half --`);
  for (const k of Object.keys(meanX).sort()) {
    const [s, c] = meanX[k];
    console.log(`  ${k.padEnd(12)} ${(s / Math.max(1, c)).toFixed(0).padStart(6)} mm`);
  }
  const ko = all.filter((g) => g.kickedOff).length;
  console.log(`\n-- who scored, relative to the preceding kick-off --`);
  console.log(`  scored BY the team that kicked off: ${ko}   against it: ${all.length - ko}`);
  console.log(`\n-- ball position over all live steps --`);
  console.log(`  mean ball x ${(ball[0] / Math.max(1, ball[1])).toFixed(1)} mm     time with ball at +x: ${(100 * ball[2] / Math.max(1, ball[1])).toFixed(1)}%`);
  console.log(`\n-- missed control cycles per slot (sum over seeds) --`);
  for (const k of Object.keys(miss).sort()) console.log(`  ${k.padEnd(10)} missed ${String(miss[k][0]).padStart(7)}   worstRun ${miss[k][1]}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
