/** Every seeded restart placement has to stay legal and non-overlapping. */
import { World } from '../src/world';
import { getLeague } from '../src/leagues';
const HALF_LENGTH = 915, PENALTY_DEPTH = 300, PENALTY_WIDTH = 900, R = 110;
let worstGap = Infinity, bad = 0, n = 0;
for (let seed = 1; seed <= 200; seed++) {
  const w = new World({ league: getLeague('open'), halfLengthSeconds: 600, inclined: false, commsEnabled: true, placementSeed: seed });
  for (const half of [1, 2] as const) {
    for (const k of ['cyan', 'yellow'] as const) {
      w.half = half; w.kickOff(k); n++;
      for (const r of w.robots) {
        const ownSide = w.defendingGoal(r.team) === 'cyan' ? r.x < 0 : r.x > 0;
        if (!ownSide) { console.log(`seed ${seed} ${r.id} on the wrong half at ${r.x.toFixed(0)}`); bad++; }
        if (Math.abs(r.x) > HALF_LENGTH - 1) { console.log(`seed ${seed} ${r.id} past the goal line`); bad++; }
        if (!r.isGoalie && k !== r.team) {
          const overlapsBox = Math.abs(r.x) + R >= HALF_LENGTH - PENALTY_DEPTH && Math.abs(r.z) <= PENALTY_WIDTH / 2;
          if (!overlapsBox) { console.log(`seed ${seed} ${r.id} not overlapping its box (5.4.5) at (${r.x.toFixed(0)},${r.z.toFixed(0)})`); bad++; }
        }
      }
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
        const a = w.robots[i]!, b = w.robots[j]!;
        const g = Math.hypot(a.x - b.x, a.z - b.z);
        if (g < worstGap) worstGap = g;
        if (g < 2 * R) { console.log(`seed ${seed} ${a.id}/${b.id} overlap at ${g.toFixed(1)}mm`); bad++; }
      }
    }
  }
}
console.log(`${n} restarts checked, ${bad} problems, closest pair ever ${worstGap.toFixed(1)}mm (need ${2 * R})`);
