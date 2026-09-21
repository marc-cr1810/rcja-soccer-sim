import { Match, type MatchAgents } from '../packages/server/src/match/match';
import { ChampionAgent } from '../packages/server/src/champion/champion';
import { referenceTeam } from '../packages/server/src/infra/reference';

const champion = (number: 1 | 2, team: 'violet' | 'lime') =>
  new ChampionAgent({ team, number, role: number === 2 ? 'goalie' : 'striker' });
const pairs: Record<string, () => MatchAgents> = {
  champion: () => ({ 'violet-1': champion(1, 'violet'), 'violet-2': champion(2, 'violet'), 'lime-1': champion(1, 'lime'), 'lime-2': champion(2, 'lime') }) as unknown as MatchAgents,
  reference: () => ({ ...referenceTeam('violet'), ...referenceTeam('lime') }) as unknown as MatchAgents,
};
const DT = 1 / 120;
for (const [name, make] of Object.entries(pairs)) {
  for (const range of [{ min: 0, max: 0 }, undefined]) {
    let hidden = 0, lifts = 0, clock = 0, goals = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      let was = true;
      const m = new Match({
        agents: make(), halfSeconds: 300, seed, ballPlacementSeconds: range,
        observe: (mm) => {
          const now = mm.world.ballInPlay;
          if (!now) hidden += DT;
          if (was && !now) lifts++;
          was = now;
        },
      });
      const r = m.run();
      clock += 600;
      goals += m.world.score.violet + m.world.score.lime;
    }
    console.log(name, range ? 'instant' : 'default', `placements/match=${(lifts / 6).toFixed(1)}`, `hidden s/match=${(hidden / 6).toFixed(1)}`, `(${((100 * hidden) / clock).toFixed(1)}%)`, `goals/match=${(goals / 6).toFixed(1)}`);
  }
}
