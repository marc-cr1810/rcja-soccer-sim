/**
 * Which striker/goalie states does the rotational symmetry test actually reach?
 * Reads the state name out of the broadcast `say.intent` of each decision.
 */
import { Senses, type MatchView, type SenseInput } from '../src/perception';
import { ChampionAgent } from '../src/champion';
import type { SensorFrame } from '../src/protocol';

interface Pose { x: number; z: number; heading: number; bx: number; bz: number }
const rotate = (p: Pose): Pose => ({ x: -p.x, z: -p.z, heading: p.heading + Math.PI, bx: -p.bx, bz: -p.bz });

function poses(count: number): Pose[] {
  let state = 12345;
  const rnd = (): number => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const span = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
  return Array.from({ length: count }, () => ({
    x: span(-850, 850), z: span(-560, 560), heading: span(-Math.PI, Math.PI),
    bx: span(-880, 880), bz: span(-580, 580),
  }));
}
function trajectory(p: Pose, ticks: number): Pose[] {
  return Array.from({ length: ticks }, (_, i) => ({
    x: p.x + Math.cos(p.heading) * 4 * i, z: p.z + Math.sin(p.heading) * 4 * i,
    heading: p.heading + 0.01 * i, bx: p.bx + 3 * i, bz: p.bz - 1.5 * i,
  }));
}
function others(p: Pose, team: 'violet' | 'lime') {
  const foe = team === 'violet' ? 'lime' : 'violet';
  return [
    { id: `${team}-2`, team, number: 2 as const, x: p.x * 0.2 - 300, z: p.z * 0.3 + 40, heading: p.heading + 0.5 },
    { id: `${foe}-1`, team: foe, number: 1 as const, x: (p.x + p.bx) / 2 + 90, z: (p.z + p.bz) / 2 - 30, heading: p.heading - 1.1 },
    { id: `${foe}-2`, team: foe, number: 2 as const, x: p.bx * 0.6 + 250, z: p.bz * 0.4 + 70, heading: p.heading + 2.2 },
  ];
}
function frames(seq: Pose[], attackDirection: 1 | -1, held: boolean, rotated: boolean): SensorFrame[] {
  const senses = new Senses(0xbeef, 4, true);
  let clock = 0;
  const s = rotated ? -1 : 1;
  return seq.map((base) => {
    clock += 0.02;
    const p = rotated ? rotate(base) : base;
    const self = { id: 'violet-1', team: 'violet' as const, number: 1 as const, x: p.x, z: p.z, heading: p.heading };
    const rest = others(base, 'violet').map((r) => ({ ...r, x: s * r.x, z: s * r.z, heading: r.heading + (rotated ? Math.PI : 0) }));
    const view: MatchView = { clock, playing: true, ball: { x: p.bx, z: p.bz }, robots: [self, ...rest], kickoff: { pending: false, team: null, countdown: 0 } };
    const input: SenseInput = { view, self, wheelSpeeds: [100, -100, 100, -100], omega: 0, held, messages: [], attackDirection, dt: 0.02 };
    return senses.read(input);
  });
}

const hits = new Map<string, number>();
for (const held of [false, true]) {
  for (const [role, number] of [['striker', 1], ['goalie', 2]] as const) {
    for (const pose of poses(40)) {
      const a = new ChampionAgent({ team: 'violet', number, role: role as 'striker' | 'goalie' });
      const fa = frames(trajectory(pose, 30), 1, held, false);
      for (const f of fa) {
        const c = a.tick(f) as { say?: { intent?: string } } | null;
        const intent = c?.say?.intent ?? '(no say)';
        const key = `${role}:${intent}`;
        hits.set(key, (hits.get(key) ?? 0) + 1);
      }
    }
  }
}
console.log('States reached by tests/champion-symmetry.test.ts:');
for (const [k, v] of [...hits].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
const all = ['CARRY', 'DRIBBLE_ROUND', 'BREAKOUT', 'APPROACH', 'INTERCEPT', 'SEARCH', 'RECOVER', 'RECEIVE', 'COVER', 'COVER_MOUTH', 'KICKOFF'];
const missing = all.filter((s) => ![...hits.keys()].some((k) => k.endsWith(`:${s}`)));
console.log('\nNEVER reached:', missing.join(', ') || '(none)');
