/**
 * What does the ball model do to the game? Champion vs champion in-process,
 * per league: goals, shots and the referee's calls per match. Run before and
 * after a change to the ball and compare.
 *
 *   bun scratch/ball_game_probe.ts [seeds=10] [half=60]
 */
import { Match, type MatchAgents } from '../packages/server/src/match/match';
import { championTeam } from '../packages/server/src/champion/index';

const SEEDS = Number(process.argv[2] ?? 10);
const HALF = Number(process.argv[3] ?? 60);

for (const league of ['open', 'lightweight'] as const) {
  let goals = 0;
  let shots = 0;
  let mercies = 0;
  const calls: Record<string, number> = {};
  for (let seed = 1; seed <= SEEDS; seed++) {
    const agents = { ...championTeam('violet'), ...championTeam('lime') } as unknown as MatchAgents;
    const res = new Match({ agents, halfSeconds: HALF, seed, league }).run();
    goals += res.score.violet + res.score.lime;
    for (const s of Object.values(res.robotStats)) shots += s.shots;
    if (res.mercy) mercies++;
    for (const [k, n] of Object.entries(res.calls)) calls[k] = (calls[k] ?? 0) + n;
  }
  const per = (n: number) => (n / SEEDS).toFixed(1);
  console.log(`${league}: goals ${per(goals)}/match, shots ${per(shots)}, mercy ${mercies}/${SEEDS}`);
  console.log(
    '  calls: ' +
      Object.entries(calls)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${per(n)}`)
        .join(', '),
  );
}
