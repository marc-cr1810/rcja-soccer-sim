/** Kickoff outcomes: after each kickoff, who owns the ball and does it lead to a shot? */
import { Match } from '../packages/server/src/match/match';
// eslint-disable-next-line import/no-relative-packages
import { championTeam as workChampion } from '../packages/server/src/champion/index';
// eslint-disable-next-line import/no-relative-packages
import { championTeam as pinChampion } from './.wt-champion-ab6ce00/packages/server/src/champion/index';

const SEEDS = process.argv[2] ? process.argv[2].split('-').map(Number) : [1, 40];

let matches = 0;
const ko: { by: 'violet' | 'lime'; won: 'violet' | 'lime' | 'loose' | null; shot: 'violet' | 'lime' | null; goal: 'violet' | 'lime' | null }[] = [];

for (let seed = SEEDS[0]; seed <= SEEDS[1]; seed++) {
  const w = workChampion('violet');
  const p = pinChampion('lime');
  const agents = {
    'violet-1': w['violet-1']!,
    'violet-2': w['violet-2']!,
    'lime-1': p['lime-1']!,
    'lime-2': p['lime-2']!,
  };

  let seen = 0;
  let pending: { by: 'violet' | 'lime'; clock: number } | null = null;
  let won: 'violet' | 'lime' | 'loose' | null = null;
  let shot: 'violet' | 'lime' | null = null;
  let goal: 'violet' | 'lime' | null = null;

  const m = new Match({
    agents,
    halfSeconds: 120,
    seed,
    observe: () => {
      const world = m.world;
      if (world.events.length !== seen) {
        const fresh = world.events.slice(seen);
        seen = world.events.length;
        for (const e of fresh) {
          if (e.kind === 'kickoff') {
            if (pending) ko.push({ by: pending.by, won, shot, goal });
            pending = { by: e.team as 'violet' | 'lime', clock: world.clock };
            won = null;
            shot = null;
            goal = null;
          } else if (e.kind === 'goal' && pending) {
            goal = e.team as 'violet' | 'lime';
          }
        }
      }
      if (!pending || world.clock - pending.clock > 5) {
        if (pending) ko.push({ by: pending.by, won, shot, goal });
        pending = null;
        return;
      }
      if (!won && world.clock - pending.clock > 0.3) {
        const nearest = world.robots
          .filter((r) => !r.removed)
          .sort((a, b) => dist(world.ball, a) - dist(world.ball, b))[0];
        won = nearest ? (nearest.team === 'violet' ? 'violet' : 'lime') : 'loose';
      }
      const conn = world.robots.find((r) => {
        const d = dist(world.ball, r);
        return d < 150 && world.ball.vx >= -300;
      });
      if (conn && !shot) {
        shot = world.lastBallTouch?.team === 'violet' ? 'violet' : 'lime';
      }
    },
  });
  m.run();
  matches++;
}

const by = (team: 'violet' | 'lime', f: (k: (typeof ko)[number]) => boolean) =>
  ko.filter((k) => k.by === team).filter(f).length;

console.log(JSON.stringify({
  matches,
  kickoffs: { violet: ko.filter((k) => k.by === 'violet').length, lime: ko.filter((k) => k.by === 'lime').length },
  kickoffWindows: {
    violet: {
      owned: by('violet', (k) => k.won === 'violet'),
      lost: by('violet', (k) => k.won === 'lime'),
      shot: by('violet', (k) => k.shot === 'violet'),
      goal: by('violet', (k) => k.goal === 'violet'),
      oppGoal: by('violet', (k) => k.goal === 'lime'),
    },
    lime: {
      owned: by('lime', (k) => k.won === 'lime'),
      lost: by('lime', (k) => k.won === 'violet'),
      shot: by('lime', (k) => k.shot === 'lime'),
      goal: by('lime', (k) => k.goal === 'lime'),
      oppGoal: by('lime', (k) => k.goal === 'violet'),
    },
  },
}, null, 2));

function dist(a: { x: number; z: number }, b: { x: number; z: number }) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
