/** Does the reference agent hold up under the recorded-play symmetry check? */
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
    'violet-1': taped[0],
    'violet-2': taped[1],
    'lime-1': ref(1, 'lime'),
    'lime-2': ref(2, 'lime'),
  } as unknown as MatchAgents;
  new Match({ agents, halfSeconds: 40, seed }).run();
  seats.forEach((s, i) => s.frames.push(...taped[i]!.frames));
}

const report = checkSymmetry(seats, (s) => ref(s.number as 1 | 2));
console.log('ticks:', report.ticks, '| ok:', report.ok, '| divergences:', report.divergences.length);
console.log('intents seen:', Object.entries(report.intents).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join(' '));
for (const d of report.divergences.slice(0, 10)) {
  console.log(`  ${d.seat} t=${d.tick} ${d.intent} ${d.what}: ${d.upright} vs ${d.rotated}`);
}
