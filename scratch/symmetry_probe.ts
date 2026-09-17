import { Match, type MatchAgents } from '../src/match';
import { ChampionAgent } from '../src/champion';
import { RecordingAgent, checkSymmetry, type SeatRecording } from '../src/symmetry';

const seeds = [1, 2, 3];
const rec: Record<string, SeatRecording> = {};

for (const seed of seeds) {
  const wrap = (id: string, a: ChampionAgent) => {
    const r = new RecordingAgent(a);
    (rec[id] ??= { id, number: id.endsWith('-1') ? 1 : 2, frames: [] });
    return { r, id };
  };
  const v1 = wrap('violet-1', new ChampionAgent({ team: 'violet', number: 1, role: 'striker' }));
  const v2 = wrap('violet-2', new ChampionAgent({ team: 'violet', number: 2, role: 'goalie' }));
  const agents = {
    'violet-1': v1.r,
    'violet-2': v2.r,
    'lime-1': new ChampionAgent({ team: 'lime', number: 1, role: 'striker' }),
    'lime-2': new ChampionAgent({ team: 'lime', number: 2, role: 'goalie' }),
  } as unknown as MatchAgents;
  new Match({ agents, halfSeconds: 40, seed }).run();
  rec['violet-1']!.frames.push(...v1.r.frames);
  rec['violet-2']!.frames.push(...v2.r.frames);
}

const seats = [rec['violet-1']!, rec['violet-2']!];
console.log('recorded ticks per seat:', seats.map((s) => s.frames.length).join(', '));

const report = checkSymmetry(seats, (seat) =>
  new ChampionAgent({
    team: 'violet',
    number: seat.number as 1 | 2,
    role: seat.number === 2 ? 'goalie' : 'striker',
  }),
);

console.log('\nintents reached:');
for (const [k, v] of Object.entries(report.intents).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${v}`);
}
console.log('\nok:', report.ok, '| divergences:', report.divergences.length);
for (const d of report.divergences.slice(0, 8)) {
  console.log(`  ${d.seat} t=${d.tick} ${d.intent} ${d.what}: ${d.upright} vs ${d.rotated}`);
}
