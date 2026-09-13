/**
 * Playing a match reproducibly, so it can be bisected instead of counted.
 *
 * A real match must never wait for a program. The rule that the last command
 * stands is what makes a hung robot simulate honestly, and it is the rule that
 * stops one team's laptop taking the other team's match down with it. So
 * `playFast` polls: it takes whatever has arrived and steps regardless.
 *
 * The cost is that a match over a socket is not reproducible. Whether a reply
 * lands before the next control cycle depends on wall-clock scheduling, so the
 * same seed gives a different match every time - I have watched the same four
 * programs and the same seed finish 17-5 one run and 8-14 the next. That makes
 * every question about the simulation statistical: twenty matches, half an
 * hour, and an ambiguous answer. Worse, it makes a whole class of question
 * unanswerable, because you cannot bisect something that will not repeat.
 *
 * This runner waits. Before each control cycle it holds until every program
 * has answered the previous frame, so no cycle is ever missed and the match is
 * a pure function of the seed. Nothing about the simulation changes - the same
 * `Match.step` runs, in the same order, at the same rate - what changes is that
 * the harness refuses to move on until the answers are in.
 *
 * It is a diagnostic mode, not a competition mode. A program that hangs will
 * hang the run (hence the deadline), which is exactly the behaviour a real
 * match must not have.
 */

import { Match, CONTROL_HZ, PHYSICS_HZ, type MatchOptions, type MatchResult } from './match';
import type { Transport } from './agent';

export interface LockstepOptions extends MatchOptions {
  /**
   * How long to wait for a single control cycle's answers before giving up, in
   * milliseconds. A program that stops answering ends the run with an error
   * rather than silently turning it back into a polled, unreproducible one.
   */
  deadlineMs?: number;
  /** Called once per control cycle, after the answers are in and before the step. */
  onCycle?: (match: Match) => void;
  /**
   * Which halves to play, default both.
   *
   * A bisect wants one half: the two runs being compared have to stay each
   * other's image, and a second half would restart them from a fresh kick-off
   * and hide where they first came apart.
   */
  halves?: readonly (1 | 2)[];
  /**
   * Who takes the opening kick-off of each half, default violet then lime.
   *
   * Flipping it is how you build a match's 180-degree rotation: the same half
   * with the other team kicking off places every robot at the mirror of where
   * it stood, so run A rotated should BE run B with the colours swapped.
   */
  kickOffFor?: (half: 1 | 2) => 'violet' | 'lime';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Whether every program has answered the frame it was last sent.
 *
 * A transport that does not report (an in-process program) is always ready:
 * it answered inside `send`.
 */
function allAnswered(transports: Partial<Record<string, Transport>>): boolean {
  for (const t of Object.values(transports)) {
    if (!t) continue;
    if (t.answered === false) return false;
  }
  return true;
}

function whoIsMissing(transports: Partial<Record<string, Transport>>): string[] {
  return Object.entries(transports)
    .filter(([, t]) => t && t.answered === false)
    .map(([id]) => id);
}

/**
 * Wait for every outstanding reply, then throw them away.
 *
 * Used at a half boundary, where the point is not the answers but making sure
 * none of them is still in the air when the next half starts counting.
 */
async function drain(
  transports: Partial<Record<string, Transport>>,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!allAnswered(transports)) {
    if (Date.now() > deadline) break; // nothing coming; the reset clears it anyway
    await sleep(0);
  }
  // One more turn of the loop, so a reply that arrived while we were checking
  // the others is also in hand before anything is cleared.
  await sleep(1);
}

/** Play a whole match, waiting for every program on every control cycle. */
export async function playLockstep(options: LockstepOptions): Promise<MatchResult> {
  const {
    deadlineMs = 10000,
    onCycle,
    halves = [1, 2] as const,
    kickOffFor = (half: 1 | 2): 'violet' | 'lime' => (half === 1 ? 'violet' : 'lime'),
    ...matchOptions
  } = options;
  const transports = matchOptions.transports ?? {};
  const match = new Match(matchOptions);
  const dt = 1 / PHYSICS_HZ;
  const perControl = Math.max(1, Math.round(PHYSICS_HZ / CONTROL_HZ));

  for (const half of halves) {
    match.world.half = half;
    match.world.kickOff(kickOffFor(half));
    match.resetAgents();
    match.world.running = true;

    const until = match.world.clock + match.halfLength;
    // `poll` takes before it sends, so the FIRST cycle of a half is the one
    // that hands out the first frame - there is nothing outstanding to wait
    // for, and waiting would deadlock. resetAgents() has just dropped anything
    // left over from the previous half.
    let outstanding = false;
    while (match.world.clock < until) {
      // Hold here, not inside the match: the match's own contract is that it
      // never waits, and this is the harness choosing to.
      const deadline = Date.now() + deadlineMs;
      while (outstanding && !allAnswered(transports)) {
        if (Date.now() > deadline) {
          throw new Error(
            `lockstep: no answer from ${whoIsMissing(transports).join(', ')} within ${deadlineMs}ms`,
          );
        }
        await sleep(0);
      }
      onCycle?.(match);
      for (let i = 0; i < perControl && match.world.clock < until; i++) match.step(dt);
      outstanding = true;
    }
    match.world.running = false;
    // Let the half's last frames come home before the next half resets.
    //
    // Otherwise those replies land after resetAgents() and sit in `pending` as
    // though they answered the new half's first frame - from then on every
    // robot acts on a frame one cycle stale, nondeterministically, depending
    // on which of them made it back in time.
    if (outstanding) await drain(transports, deadlineMs);
  }

  return match.result();
}
