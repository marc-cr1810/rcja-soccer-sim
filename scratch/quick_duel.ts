/**
 * A fast screen for champion changes: the working champion against the pinned
 * one, both in this process, both arrangements.
 *
 * `scratch/duel-ts.sh` is the verdict — the pinned side plays over the wire,
 * as a real team does. This is only the sieve that decides which candidates
 * are worth a verdict. The pinned champion is imported from its worktree, so it
 * runs its own code while the match and the physics are the working tree's.
 *
 *   bun scratch/quick_duel.ts [seeds=8] [half=90] [first-seed=1]
 *
 * Self-play at HEAD vs HEAD over 6 matches came out 47-40, which is a 1.18
 * ratio from noise alone: treat anything a screen says with that in mind.
 */
import { readFileSync } from 'node:fs';
import { Match, type MatchAgents } from '../packages/server/src/match/match';
import { championTeam as working } from '../packages/server/src/champion/index';
import { openDrive } from '../packages/server/src/sim/drive';

// RCJA_OLD_DRIVE=1 replays the duel on the drive from before wheel grip, to
// tell a change that suits grip apart from one that was simply better anyway.
const oldDrive = process.env.RCJA_OLD_DRIVE
  ? { ...openDrive(), grip: Infinity, motors: openDrive().motors.map((m) => ({ ...m, gearFriction: 0 })) }
  : null;

const SEEDS = Number(process.argv[2] ?? 8);
const HALF = Number(process.argv[3] ?? 90);
const FIRST = Number(process.argv[4] ?? 1);

const pin = readFileSync(new URL('./champion-ts', import.meta.url), 'utf8').trim().split('\n').pop()!;
const wt = new URL(`./.wt-champion-${pin.slice(0, 7)}/packages/server/src/champion/index.ts`, import.meta.url);
const { championTeam: pinned } = (await import(wt.pathname)) as { championTeam: typeof working };

let forW = 0;
let forP = 0;
let winsW = 0;
let winsP = 0;
const lines: string[] = [];
for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
  for (const workingSide of ['violet', 'lime'] as const) {
    const pinnedSide = workingSide === 'violet' ? 'lime' : 'violet';
    const agents = { ...working(workingSide), ...pinned(pinnedSide) } as unknown as MatchAgents;
    const observe = oldDrive
      ? (m: Match) => {
          for (const r of m.world.robots) r.drive = oldDrive;
        }
      : undefined;
    const res = new Match({ agents, halfSeconds: HALF, seed, observe }).run();
    const w = res.score[workingSide];
    const p = res.score[pinnedSide];
    forW += w;
    forP += p;
    if (w > p) winsW++;
    if (p > w) winsP++;
    lines.push(`${w}-${p}`);
  }
}
console.log(`working ${forW} - ${forP} pinned over ${SEEDS * 2} matches  (x${(forW / forP).toFixed(2)}, wins ${winsW}-${winsP})`);
console.log(`  ${lines.join('  ')}`);
