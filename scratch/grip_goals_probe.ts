/**
 * Where do the extra goals under wheel grip come from?
 *
 * Champion vs champion, in-process, with every robot's drive swapped between
 * the old model (no grip limit, no gearbox friction) and the new one. For each
 * goal it looks back to the moment the ball crossed the keeper's guard line and
 * asks what the keeper was doing; around it, how the strikers arrive at the
 * ball and whether the encoder-fed estimators still tell the truth now that
 * wheels can spin.
 *
 *   bun scratch/grip_goals_probe.ts [seeds=8] [half=60]
 */
import { Match, type MatchAgents } from '../packages/server/src/match/match';
import { championTeam } from '../packages/server/src/champion/index';
import { openDrive, type DriveSpec } from '../packages/server/src/sim/drive';
import { HALF_LENGTH, HALF_GOAL_WIDTH } from '../packages/server/src/sim/field';

const SEEDS = Number(process.argv[2] ?? 8);
const HALF = Number(process.argv[3] ?? 60);
const GUARD_LINE = HALF_LENGTH - 175;

const variants: Record<string, DriveSpec> = {
  old: { ...openDrive(), grip: Infinity, motors: openDrive().motors.map((m) => ({ ...m, gearFriction: 0 })) },
  new: openDrive(),
};

interface Crossing {
  clock: number;
  side: number;
  keeperDz: number;
  keeperSpeed: number;
  keeperDepth: number;
  keeperMissing: boolean;
  ballSpeed: number;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(0) + '%' : '-');

for (const [name, spec] of Object.entries(variants)) {
  let goals = 0;
  const conceded: Crossing[] = [];
  const saved: Crossing[] = [];
  const arrivals: number[] = [];
  const yawErr: number[] = [];
  let breakouts = 0;
  let ticks = 0;

  for (let seed = 1; seed <= SEEDS; seed++) {
    const agents = { ...championTeam('violet'), ...championTeam('lime') };
    let pending: Crossing[] = [];
    let lastScore = 0;
    let lastBx = 0;
    const armed = new Map<string, boolean>();
    const lastBreakout = new Map<string, number>();

    const m = new Match({
      agents: agents as unknown as MatchAgents,
      halfSeconds: HALF,
      seed,
      observe: (match) => {
        const w = match.world;
        for (const r of w.robots) r.drive = spec;
        ticks++;
        const b = w.ball;

        // A goalward crossing of either guard line opens a pending shot.
        for (const side of [-1, 1]) {
          const line = side * GUARD_LINE;
          const crossed = (lastBx - line) * (b.x - line) < 0 && Math.sign(b.vx) === side;
          if (crossed && Math.abs(b.z) < HALF_GOAL_WIDTH + 60) {
            const keeper = w.robots.find((r) => r.isGoalie && !r.removed && Math.sign(r.x) === side);
            pending.push({
              clock: w.clock,
              side,
              keeperDz: keeper ? Math.abs(keeper.z - b.z) : NaN,
              keeperSpeed: keeper ? Math.hypot(keeper.vx, keeper.vz) : NaN,
              keeperDepth: keeper ? HALF_LENGTH - Math.abs(keeper.x) : NaN,
              keeperMissing: !keeper,
              ballSpeed: Math.hypot(b.vx, b.vz),
            });
          }
        }
        lastBx = b.x;

        const score = w.score.violet + w.score.lime;
        if (score > lastScore) {
          goals += score - lastScore;
          // The ball is back on the centre spot by now, so take the latest shot.
          const shot = pending.pop();
          if (shot) conceded.push(shot);
          pending = [];
        }
        lastScore = score;
        // A shot that has not gone in within 1.5 s was kept out.
        for (const p of pending.filter((p) => w.clock - p.clock > 1.5)) saved.push(p);
        pending = pending.filter((p) => w.clock - p.clock <= 1.5);

        for (const r of w.robots) {
          if (r.removed) continue;
          const d = Math.hypot(r.x - b.x, r.z - b.z);
          // Armed once clear of the ball, fired on the tick it arrives.
          if (d > 250) armed.set(r.id, true);
          if (!r.isGoalie && armed.get(r.id) && d <= 140) {
            arrivals.push(Math.hypot(r.vx, r.vz));
            armed.set(r.id, false);
          }

          const agent = (agents as Record<string, any>)[r.id];
          const est = agent?.yawEst?.rate;
          if (typeof est === 'number') yawErr.push(Math.abs(est - r.omega));
          const bt = agent?.brain?.breakoutTicks ?? 0;
          if (bt === 16 && (lastBreakout.get(r.id) ?? 0) !== 16) breakouts++;
          lastBreakout.set(r.id, bt);
        }
      },
    });
    m.run();
  }

  const matches = SEEDS;
  const shots = conceded.length + saved.length;
  const beaten = conceded.filter((c) => c.keeperDz > 131);
  const offLine = conceded.filter((c) => c.keeperDepth > 400);
  console.log(`\n== ${name} physics: ${SEEDS} seeds x 2x${HALF}s champion v champion`);
  console.log(`  goals/match ${(goals / matches).toFixed(1)}   guard-line shots/match ${(shots / matches).toFixed(1)}   kept out ${pct(saved.length, shots)}`);
  console.log(`  conceded: keeper missing ${pct(conceded.filter((c) => c.keeperMissing).length, conceded.length)}   off its line ${pct(offLine.length, conceded.length)}   beaten sideways (>131 mm off the ball) ${pct(beaten.length, conceded.length)}`);
  console.log(`  at the crossing, conceded vs kept out: keeper off the ball ${median(conceded.map((c) => c.keeperDz)).toFixed(0)} vs ${median(saved.map((c) => c.keeperDz)).toFixed(0)} mm   keeper speed ${median(conceded.map((c) => c.keeperSpeed)).toFixed(0)} vs ${median(saved.map((c) => c.keeperSpeed)).toFixed(0)} mm/s   ball speed ${median(conceded.map((c) => c.ballSpeed)).toFixed(0)} vs ${median(saved.map((c) => c.ballSpeed)).toFixed(0)} mm/s`);
  console.log(`  striker arrival speed at the ball: median ${median(arrivals).toFixed(0)} mm/s over ${arrivals.length} arrivals`);
  console.log(`  yaw estimator |error|: median ${median(yawErr).toFixed(3)} rad/s   p90 ${[...yawErr].sort((a, b) => a - b)[Math.floor(yawErr.length * 0.9)]!.toFixed(3)}`);
  console.log(`  stall breakouts per robot-minute: ${((breakouts / (ticks / 100 / 60)) / 4).toFixed(2)}`);
}
