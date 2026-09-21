import { Match, type MatchAgents } from '../packages/server/src/match/match';
import { ChampionAgent } from '../packages/server/src/champion/champion';
import { RecordingAgent, checkSymmetry, type SeatRecording } from '../packages/server/src/sim/symmetry';

const champion = (number: 1 | 2, team: 'violet' | 'lime' = 'violet') =>
  new ChampionAgent({ team, number, role: number === 2 ? 'goalie' : 'striker' });

function intents(range: { min: number; max: number } | undefined, seeds: number[]) {
  const seats: SeatRecording[] = [
    { id: 'violet-1', number: 1, frames: [] },
    { id: 'violet-2', number: 2, frames: [] },
  ];
  let placements = 0;
  for (const seed of seeds) {
    const taped = seats.map((seat) => new RecordingAgent(champion(seat.number as 1 | 2)));
    const agents = { 'violet-1': taped[0], 'violet-2': taped[1], 'lime-1': champion(1, 'lime'), 'lime-2': champion(2, 'lime') } as unknown as MatchAgents;
    const m = new Match({ agents, halfSeconds: 40, seed, ballPlacementSeconds: range });
    m.run();
    placements += m.world.events.filter((e) => e.kind === 'ball-out-of-play' || e.kind === 'lack-of-progress').length;
    seats.forEach((seat, i) => seat.frames.push(...taped[i]!.frames));
  }
  const r = checkSymmetry(seats, (seat) => champion(seat.number as 1 | 2));
  return { intents: r.intents, placements };
}
const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number);
console.log('instant', JSON.stringify(intents({ min: 0, max: 0 }, seeds)));
console.log('default', JSON.stringify(intents(undefined, seeds)));
