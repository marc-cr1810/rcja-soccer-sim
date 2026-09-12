/**
 * Pin down where the cyan-vs-yellow gap comes from in python-vs-python.
 *
 * Aggregates, per half and per robot, everything that could explain a team
 * edge: possession, shots with outcomes, kick range, ball-in-attacking-third,
 * restarts won, out-of-play attribution, removals, and per-goal last-toucher.
 *
 * Mirrors the proven plumbing in src/bench.ts runBench() but tags everything
 * with the half it happened in (a full match is x-mirror symmetric between
 * teams once halves are accounted for, so anything that does NOT flip between
 * halves is the smoking gun).
 */
import { spawn } from 'node:child_process';
import { MatchServer } from '../src/server';
import { Match } from '../src/match';
import { HALF_LENGTH, HALF_WIDTH, HALF_GOAL_WIDTH } from '../src/field';

const SEEDS = Number.parseInt(process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? '20', 10);
const HALF = Number.parseInt(process.argv.find((a) => a.startsWith('--half='))?.split('=')[1] ?? '90', 10);
const NOISY = process.argv.includes('--noisy');
const THIRD = HALF_LENGTH / 3;
const NEAR_BALL = 80;

type Half = '1' | '2';
type TeamId = 'cyan' | 'yellow';

interface KickStat {
  total: number; goals: number; intoMouth: number; blockedOut: number;
  offTarget: number; stoppedInPlay: number; meanRange: number; aimed: number;
}
const kickBlank = (): KickStat => ({
  total: 0, goals: 0, intoMouth: 0, blockedOut: 0, offTarget: 0, stoppedInPlay: 0, meanRange: 0, aimed: 0,
});

interface RobotStat {
  sample: Record<Half, number>;
  possession: Record<Half, number>;
  nearBall: Record<Half, number>;
  attackThird: Record<Half, number>;
  ownThird: Record<Half, number>;
  removals: Record<string, number>;
  kicks: Record<Half, KickStat>;
}
const robotBlank = (): RobotStat => ({
  sample: { '1': 0, '2': 0 },
  possession: { '1': 0, '2': 0 },
  nearBall: { '1': 0, '2': 0 },
  attackThird: { '1': 0, '2': 0 },
  ownThird: { '1': 0, '2': 0 },
  removals: {},
  kicks: { '1': kickBlank(), '2': kickBlank() },
});

interface GoalInfo {
  team: TeamId; half: Half; at: number; sinceRestart: number;
  end: 'plus' | 'minus'; by: string; fromKick: boolean;
}

const bots = new Map<string, RobotStat>();
const ballSteps: Record<Half, number> = { '1': 0, '2': 0 };
const ballAttack: Record<Half, { cyan: number; yellow: number }> = {
  '1': { cyan: 0, yellow: 0 }, '2': { cyan: 0, yellow: 0 },
};
const restarts: Record<Half, { cyan: number; yellow: number }> = {
  '1': { cyan: 0, yellow: 0 }, '2': { cyan: 0, yellow: 0 },
};
const outByTeam: Record<Half, { cyan: number; yellow: number; none: number }> = {
  '1': { cyan: 0, yellow: 0, none: 0 }, '2': { cyan: 0, yellow: 0, none: 0 },
};
const outByEnd: Record<Half, { plus: number; minus: number }> = {
  '1': { plus: 0, minus: 0 }, '2': { plus: 0, minus: 0 },
};
const goals: GoalInfo[] = [];
const scores = { cyan: 0, yellow: 0 };

function kickBag(id: string, half: Half): KickStat {
  const acc = bots.get(id);
  if (!acc) return kickBlank();
  return acc.kicks[half];
}
function recordShot(bag: KickStat, shot: { by: string; range: number; onTarget: boolean }, outcome: keyof KickStat): void {
  bag.total++;
  (bag[outcome] as number)++;
  if (shot.onTarget) { bag.meanRange += shot.range; bag.aimed++; }
}

async function playSeed(matchSeed: number): Promise<void> {
  const server = new MatchServer({ port: 0, realtime: false, idealSensors: !NOISY });
  const port = await server.listen();
  const url = `ws://localhost:${port}/agent`;
  // detached so the shell (and every python grandchild it spawns) lands in
  // its own process group - child.kill() alone only ever signalled the shell
  // wrapper, leaving striker.py/goalie.py running as orphans on every seed.
  const child = spawn(`python3 python/examples/play.py --url ${url}`, {
    shell: true,
    stdio: 'ignore',
    detached: true,
  });
  try {
    await server.agents.whenReady();

    let seen = new Set<unknown>();
    let previous = { x: 0, z: 0, vx: 0, vz: 0 };
    let lastTouch = 'none';
    let shot: { by: string; range: number; onTarget: boolean } | null = null;
    let prevC = 0;
    let prevY = 0;
    let lastRestartAt = 0;
    let restartGapNow = 0;
    let awaitRestartTouch = false;

    const observe = (m: Match): void => {
      const world = m.world;
      if (!world.running) return;
      const ball = world.ball;
      const half: Half = world.half === 1 ? '1' : '2';

      let setRestartThisStep = false;
      for (const ev of world.events) {
        if (seen.has(ev)) continue;
        seen.add(ev);
        if (ev.kind === 'ball-out-of-play') {
          const team: TeamId | 'none' = lastTouch.startsWith('cyan')
            ? 'cyan' : lastTouch.startsWith('yellow') ? 'yellow' : 'none';
          outByTeam[half][team]++;
          if (Math.abs(previous.x) > HALF_LENGTH) outByEnd[half][previous.x > 0 ? 'plus' : 'minus']++;
        }
        if (ev.kind === 'possible-damaged') {
          const id = (ev as { robotId?: string }).robotId;
          const acc = bots.get(id ?? '');
          if (acc) acc.removals[ev.rule] = (acc.removals[ev.rule] ?? 0) + 1;
        }
        if (ev.kind === 'goal' || ev.kind === 'kickoff') {
          if (!setRestartThisStep) {
            restartGapNow = world.clock - lastRestartAt;
            setRestartThisStep = true;
          }
          lastRestartAt = world.clock;
          awaitRestartTouch = true;
        }
      }

      // A "kick": nothing else takes the ball from walking pace to 2 m/s in one step.
      const was = Math.hypot(previous.vx, previous.vz);
      const now = Math.hypot(ball.vx, ball.vz);
      if (now > 2000 && was < 1500) {
        let by = 'unknown';
        let best = Infinity;
        for (const r of world.robots) {
          if (r.removed) continue;
          const gap = Math.hypot(ball.x - r.x, ball.z - r.z);
          if (gap < best) { best = gap; by = r.id; }
        }
        const shooter = world.robots.find((r) => r.id === by);
        if (shooter && by !== 'unknown') {
          const dx = Math.cos(shooter.heading);
          const dz = Math.sin(shooter.heading);
          const goalX = dx > 0 ? HALF_LENGTH : -HALF_LENGTH;
          const square = Math.abs(dx) < 0.08;
          const travel = square ? 0 : (goalX - ball.x) / dx;
          const crossZ = travel > 0 ? ball.z + dz * travel : NaN;
          if (shot) recordShot(kickBag(shot.by, half), shot, 'stoppedInPlay');
          shot = { by, range: travel > 0 ? travel : 0, onTarget: !square && travel > 0 && Math.abs(crossZ) < HALF_GOAL_WIDTH };
        }
      }

      if (world.score.cyan !== prevC || world.score.yellow !== prevY) {
        const scoredTeam: TeamId = world.score.yellow !== prevY ? 'yellow' : 'cyan';
        prevC = world.score.cyan;
        prevY = world.score.yellow;
        goals.push({
          team: scoredTeam, half, at: world.clock, sinceRestart: restartGapNow,
          end: previous.x > 0 ? 'plus' : 'minus', by: lastTouch, fromKick: !!shot,
        });
        if (shot) { recordShot(kickBag(shot.by, half), shot, 'goals'); shot = null; }
      } else if (shot) {
        if (Math.abs(ball.x) > HALF_LENGTH || Math.abs(ball.z) > HALF_WIDTH) {
          const intoMouth = Math.abs(ball.z) < HALF_GOAL_WIDTH && Math.abs(ball.x) > HALF_LENGTH;
          recordShot(kickBag(shot.by, half), shot, intoMouth ? 'intoMouth' : shot.onTarget ? 'blockedOut' : 'offTarget');
          shot = null;
        } else if (now < 250) {
          recordShot(kickBag(shot.by, half), shot, shot.onTarget ? 'stoppedInPlay' : 'offTarget');
          shot = null;
        }
      }

      ballSteps[half]++;
      if (ball.x > THIRD) ballAttack[half].cyan++;
      else if (ball.x < -THIRD) ballAttack[half].yellow++;

      for (const r of world.robots) {
        const acc = bots.get(r.id) ?? robotBlank();
        bots.set(r.id, acc);
        if (r.removed) continue;
        const h = half;
        acc.sample[h]++;
        const gap = Math.hypot(ball.x - r.x, ball.z - r.z);
        if (gap < r.radius + ball.radius + NEAR_BALL) acc.nearBall[h]++;
        const sign = r.team === 'cyan' ? 1 : -1;
        if (r.x * sign > THIRD) acc.attackThird[h]++;
        if (r.x * sign < -THIRD) acc.ownThird[h]++;
        if (gap <= r.radius + ball.radius + 12) {
          const bearing = Math.atan2(ball.z - r.z, ball.x - r.x) - r.heading;
          if (Math.abs(Math.atan2(Math.sin(bearing), Math.cos(bearing))) < 0.6) acc.possession[h]++;
          lastTouch = r.id;
          if (awaitRestartTouch) { restarts[h][r.team]++; awaitRestartTouch = false; }
        }
      }

      previous = { x: ball.x, z: ball.z, vx: ball.vx, vz: ball.vz };
    };

    const result = await server.play({
      agents: {} as never,
      transports: server.agents.transports(),
      halfSeconds: HALF,
      seed: matchSeed,
      idealSensors: !NOISY,
      observe,
    });
    scores.cyan += result.score.cyan;
    scores.yellow += result.score.yellow;
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    await server.close();
  }
}

const pct = (n: number, of: number): number => (of === 0 ? 0 : Math.round((n / of) * 1000) / 10);

async function main(): Promise<void> {
  for (let seed = 1; seed <= SEEDS; seed++) await playSeed(seed);

  console.log(`\npython-vs-python  ${NOISY ? 'noisy' : 'ideal'}  over ${SEEDS} seeds x ${HALF}s halves`);
  console.log(`SCORE   cyan ${scores.cyan} - ${scores.yellow} yellow   (goals ${goals.length}, ${goals.filter((g) => g.fromKick).length} from a detected kick)\n`);

  console.log('-- possession / field position (per robot, per half, % of live steps) --');
  for (const r of ['cyan-1', 'yellow-1', 'cyan-2', 'yellow-2'] as const) {
    const acc = bots.get(r);
    if (!acc) continue;
    const parts: string[] = [];
    for (const h of ['1', '2'] as const) {
      parts.push(
        `h${h}: poss ${pct(acc.possession[h], acc.sample[h])}% near ${pct(acc.nearBall[h], acc.sample[h])}% ` +
          `att ${pct(acc.attackThird[h], acc.sample[h])}% own ${pct(acc.ownThird[h], acc.sample[h])}%`,
      );
    }
    console.log(`  ${r.padEnd(9)}` + parts.join('   '));
  }

  console.log(`\n-- ball in attacking third, per half (% of live steps) --`);
  for (const h of ['1', '2'] as const) {
    const t = ballSteps[h];
    console.log(`  h${h}: cyan attacking ${pct(ballAttack[h].cyan, t)}%   yellow attacking ${pct(ballAttack[h].yellow, t)}%`);
  }

  console.log(`\n-- restarts won (first touch after a goal/kickoff), per half --`);
  for (const h of ['1', '2'] as const) console.log(`  h${h}: cyan ${restarts[h].cyan}   yellow ${restarts[h].yellow}`);

  console.log(`\n-- kicks (per robot, per half)  [per match avg] --`);
  for (const r of ['cyan-1', 'yellow-1', 'cyan-2', 'yellow-2'] as const) {
    const acc = bots.get(r);
    if (!acc) continue;
    for (const h of ['1', '2'] as const) {
      const k: KickStat = acc.kicks[h];
      console.log(
        `  ${r.padEnd(9)} h${h}  tot ${(k.total / SEEDS).toFixed(2)} | goals ${(k.goals / SEEDS).toFixed(2)} | ` +
          `intMouth ${(k.intoMouth / SEEDS).toFixed(2)} | blkOut ${(k.blockedOut / SEEDS).toFixed(2)} | ` +
          `offTarget ${(k.offTarget / SEEDS).toFixed(2)} | svd/held ${(k.stoppedInPlay / SEEDS).toFixed(2)} | ` +
          `meanRange ${k.aimed > 0 ? Math.round(k.meanRange / k.aimed) : 0}mm`,
      );
    }
  }

  console.log(`\n-- ball out of play: last toucher team & where, per half --`);
  for (const h of ['1', '2'] as const) {
    console.log(`  h${h}: cyan ${outByTeam[h].cyan}  yellow ${outByTeam[h].yellow}  untouched ${outByTeam[h].none}   (out at +x end ${outByEnd[h].plus}, -x end ${outByEnd[h].minus})`);
  }

  console.log(`\n-- removals (per robot, total over seeds) --`);
  for (const r of ['cyan-1', 'yellow-1', 'cyan-2', 'yellow-2'] as const) {
    const acc = bots.get(r);
    if (!acc) continue;
    const rm = Object.entries(acc.removals).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
    console.log(`  ${r.padEnd(9)} ${rm}`);
  }

  console.log(`\n-- goals per half --`);
  for (const h of ['1', '2'] as const) {
    const gs = goals.filter((g) => g.half === h);
    const cyan = gs.filter((g) => g.team === 'cyan').length;
    const yellow = gs.filter((g) => g.team === 'yellow').length;
    const atPlus = gs.filter((g) => g.end === 'plus').length;
    const atMinus = gs.filter((g) => g.end === 'minus').length;
    const cyanTouch = gs.filter((g) => g.team === 'cyan' && g.by.startsWith('cyan')).length;
    const yellowTouch = gs.filter((g) => g.team === 'yellow' && g.by.startsWith('yellow')).length;
    const leaked = gs.filter((g) => g.by.startsWith(g.team === 'cyan' ? 'yellow' : 'cyan')).length;
    const byTouch = new Map<string, number>();
    for (const g of gs) byTouch.set(g.by, (byTouch.get(g.by) ?? 0) + 1);
    const touchStr = [...byTouch.entries()].map(([id, n]) => `${id} x${n}`).join(' ');
    const meanGap = gs.length ? (gs.reduce((a, g) => a + g.sinceRestart, 0) / gs.length).toFixed(1) : '—';
    const quick = gs.filter((g) => g.sinceRestart < 15).length;
    console.log(`  h${h}: cyan ${cyan}  yellow ${yellow}   at +x ${atPlus} / -x ${atMinus}   byown-touch ${cyanTouch}/${yellowTouch}   leaked-through-opp ${leaked}`);
    console.log(`        toucher: ${touchStr}   mean-gap-after-restart ${meanGap}s, goals<15s ${quick}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});