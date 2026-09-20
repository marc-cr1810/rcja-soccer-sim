import { Match, type MatchAgents } from '../packages/server/src/match/match';
import { ChampionAgent } from '../packages/server/src/champion/champion';
import { RecordingAgent, checkSymmetry, unreached, type SeatRecording } from '../packages/server/src/sim/symmetry';

const EXERCISED = ['KICKOFF','INTERCEPT','APPROACH','CARRY','DRIBBLE_ROUND','RECEIVE','COVER_TOP','SMOTHER','GUARD','CLEAR','PASS','OFF_THE_LINE'] as const;
const champion = (number: 1 | 2, team: 'violet' | 'lime' = 'violet'): ChampionAgent =>
  new ChampionAgent({ team, number, role: number === 2 ? 'goalie' : 'striker' });

function record(): SeatRecording[] {
  const seats: SeatRecording[] = [
    { id: 'violet-1', number: 1, frames: [] },
    { id: 'violet-2', number: 2, frames: [] },
  ];
  for (const seed of [1, 2, 3]) {
    const taped = seats.map((seat) => new RecordingAgent(champion(seat.number as 1 | 2)));
    const agents = {
      'violet-1': taped[0], 'violet-2': taped[1],
      'lime-1': champion(1, 'lime'), 'lime-2': champion(2, 'lime'),
    } as unknown as MatchAgents;
    new Match({ agents, halfSeconds: 40, seed }).run();
    seats.forEach((seat, i) => seat.frames.push(...taped[i]!.frames));
  }
  return seats;
}
const seats = record();
const report = checkSymmetry(seats, (seat) => champion(seat.number as 1 | 2));
console.log(JSON.stringify({ intents: report.intents, ticks: report.ticks, unreached: unreached(report, EXERCISED) }, null, 2));
