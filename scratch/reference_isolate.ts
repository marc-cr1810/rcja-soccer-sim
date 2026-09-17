/** Same check, one seat at a time: with a single seat the replay delivers no
 *  radio at all, so a divergence that survives is not about team messages. */
import { Match, type MatchAgents } from '../src/match';
import { ReferenceAgent } from '../src/reference';
import { RecordingAgent, checkSymmetry, type SeatRecording } from '../src/symmetry';

const ref = (number: 1 | 2, team: 'violet' | 'lime' = 'violet') =>
  new ReferenceAgent({ team, number, role: number === 2 ? 'goalie' : 'striker' });

const seats: SeatRecording[] = [
  { id: 'violet-1', number: 1, frames: [] },
  { id: 'violet-2', number: 2, frames: [] },
];
for (const seed of [1, 2, 3]) {
  const taped = seats.map((s) => new RecordingAgent(ref(s.number as 1 | 2)));
  const agents = {
    'violet-1': taped[0], 'violet-2': taped[1],
    'lime-1': ref(1, 'lime'), 'lime-2': ref(2, 'lime'),
  } as unknown as MatchAgents;
  new Match({ agents, halfSeconds: 40, seed }).run();
  seats.forEach((s, i) => s.frames.push(...taped[i]!.frames));
}

for (const seat of seats) {
  const solo = checkSymmetry([seat], (s) => ref(s.number as 1 | 2));
  console.log(`${seat.id} alone (no radio): divergences=${solo.divergences.length}`);
  for (const d of solo.divergences.slice(0, 4)) {
    console.log(`    t=${d.tick} ${d.what}: ${d.upright} vs ${d.rotated}`);
  }
}
const both = checkSymmetry(seats, (s) => ref(s.number as 1 | 2));
console.log(`both seats (radio routed): divergences=${both.divergences.length}`);
