/**
 * Is a simulator change actually inert?
 *
 * A duel cannot answer this. Both sides of a duel play inside the SAME
 * simulator, so a change to the simulator moves both of them and the scoreline
 * says nothing. The question "did adding this reading change the game" is a
 * question about determinism, and the honest form of it is not "is the score
 * similar" but "is every match identical".
 *
 * Run it, keep the output, apply the change, run it again, diff. Anything that
 * is supposed to be purely additive must produce not a close result but the
 * same one - which is exactly the check that would have caught the goal blobs
 * drawing from the camera's own noise stream.
 */
import { runLadder, type Entry } from '../src/ladder';
import { botRoster } from '../src/bots';
import { ReferenceAgent } from '../src/reference';

const entries: Entry[] = [
  {
    name: 'reference',
    origin: 'reference',
    make: (team) => [
      new ReferenceAgent({ team, number: 1, role: 'striker', skill: 1 }),
      new ReferenceAgent({ team, number: 2, role: 'goalie', skill: 1 }),
    ],
  },
  ...botRoster().map((b) => ({ name: b.name, origin: 'generated' as const, make: b.make })),
];

for (const seed of [1, 2, 3]) {
  const s = runLadder(entries, { halfSeconds: 45, seed });
  console.log(`--- seed ${seed}: ${s.matches} matches, ${s.goalsPerMatch.toFixed(4)} goals/match`);
  for (const row of s.table) {
    console.log(
      [
        row.name.padEnd(16),
        `pts=${String(row.points).padStart(3)}`,
        `w=${String(row.won).padStart(2)}`,
        `d=${String(row.drawn).padStart(2)}`,
        `l=${String(row.lost).padStart(2)}`,
        `gf=${String(row.for).padStart(3)}`,
        `ga=${String(row.against).padStart(3)}`,
        `err=${row.errors}`,
      ].join('  '),
    );
  }
  const calls = Object.entries(s.callsPerMatch).sort(([a], [b]) => a.localeCompare(b));
  console.log('    calls: ' + calls.map(([k, v]) => `${k}=${v.toFixed(4)}`).join(' '));
}
