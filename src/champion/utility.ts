/**
 * Model-based decision scoring.
 *
 * The champion used to shoot, smother and clear on a pile of thresholds - a
 * boolean here, a magic millimetre there - each tuned against one match and
 * each needing to be rediscovered by whoever next touched it. These functions
 * fold the same facts into scores instead: how good an action is *now*, given
 * the world model rather than a cutoff. Distance, lane, mouth and freshness
 * all multiply, so a shot barely out of range, aimed with a defender hanging
 * on it, at a mouth the camera has not seen for a third of a second is
 * nowhere near a kick, and no single magic number says so.
 *
 * Everything here is a pure function of the model, and everything is written
 * so the two ends of the field read the same - there is no attack direction
 * in scope to forget.
 */

import type { Blob } from '../protocol';
import { shotIsOpen, shotRange } from './geometry';
import type { FramedBall } from './types';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The kicker fires when the shot scores at least this.
 *
 * One knob instead of the three booleans it replaced, and the knob survives
 * a change in any one of the factors because they combine multiplicatively.
 * It sits high on purpose: a sub-threshold reading is not a wasted kick but
 * a cue to hunt the opening (see the striker's window carry), so having a
 * high bar just means the kicker waits for a cleaner look instead of firing
 * into a defender's boots.
 */
export const KICK_SCORE_MIN = 0.5;

export interface ShotEval {
  /** 0..1 — how good kicking along `heading` looks right now. */
  score: number;
  /**
   * Distance to the goal mouth along `heading`, or null when the heading does
   * not reach the mouth between the posts.
   */
  reach: number | null;
  /**
   * Whether an opponent sits in the near lane (within ~430 mm). This is what
   * used to be `!laneClear` — the trigger for carrying round rather than
   * through a defender, kept separate from the score so the two decisions
   * (kick here? go round?) can differ.
   */
  nearBlock: boolean;
}

/**
 * Score a kick along `heading` against the world model.
 *
 * Four independent facts multiply:
 *
 * 1. distance — a close shot is a surer shot;
 * 2. lane — an opponent in front muzzles the kicker, one far off is nothing;
 * 3. mouth — goal-colour on the camera is the only authority on an open goal;
 * 4. freshness — a stale ball estimate is a shot at yesterday's goal.
 *
 * Any one of them at zero is a shot off; when all four are good the score is
 * near one. A keeper camped dead central still leaves two gaps that a ball
 * fits through, so `mouth` rewards the widest opening, not the exact bearing
 * of the shot — the aim step already steers the heading at the widest opening
 * when one is known.
 */
export function evaluateShot(env: {
  ball: FramedBall;
  heading: number;
  goalLine: number;
  blobs: Blob[];
  blocker: number | null;
}): ShotEval {
  const { ball, heading, goalLine, blobs, blocker } = env;
  const reach = shotRange(ball.x, ball.z, heading, goalLine);
  if (reach === null) return { score: 0, reach: null, nearBlock: false };

  // Range is an envelope, not a fade: a shot from the halfway line is not a
  // slightly-worse shot, it is a pump into the armour, so full value inside
  // ~700 mm (a real poke), declining to nothing by ~1.25 m. The old code cut
  // off hard at ~1.1 m; this keeps the same effective window but softens the
  // edge so a shot that is one step away from being on still reads as nearly
  // on rather than flipping.
  const distance = clamp((1250.0 - reach) / 500.0, 0.0, 1.0);

  // An opponent in front only muzzles the kick while it is close enough to
  // reach the ball off the boot; a defender a metre out is between the ball
  // and your own frame, not between the ball and the goal.
  const lane = blocker === null ? 1.0 : clamp((blocker - 150.0) / 380.0, 0.0, 1.0);

  // A goal is scoreable when the channel through the middle of the mouth is
  // clear. Note this is NOT the widest gap anywhere: a keeper parked dead
  // central leaves two ~200 mm gaps either side of itself, and shooting into
  // that from range is how a striker gets "saved" thirty times a match. A
  // team that calmly rides the ball up to an engaged keeper and waits for it
  // to commit — which opens the middle — converts; a team that fires at any
  // gap from 800 mm pumps the keeper. So the mouth is judged as soft boolean
  // on the centre channel (a clear centre worth a full factor, blocking the
  // middle marking you out entirely), which is what the old finisher used
  // before the model existed.
  const mouth = shotIsOpen(blobs) ? 1.0 : 0.0;

  // Full value inside ten ticks of a sighting; depending on a ball that was
  // last seen a third of a second ago is depending on the camera being right
  // about a moving thing it cannot see. The shot is aimed through the goal
  // mouth, which is exactly what is most likely to have changed.
  const fresh = clamp(1.0 - ball.age / 0.25, 0.0, 1.0);

  const score = distance * lane * mouth * fresh;

  return {
    score,
    reach,
    nearBlock: blocker !== null && blocker <= 430.0,
  };
}

/**
 * How much a robot trusts itself enough to travel fast.
 *
 * Full speed only when the locator is confident. A robot that does not know
 * where it is should not be sprinting at a ball on bearings that were fixed
 * from a solve ago: it arrives at the wrong angle, shoves the ball sideways
 * and calls that a tackle. Multiplying the approach speed by this is a
 * no-op on a healthy locator — confidence sits at 1.0 whenever the solve
 * lands — and a real easing the moment it stops landing.
 */
export function approachHesitation(confidence: number): number {
  return 0.55 + 0.45 * clamp(confidence, 0.0, 1.0);
}

/**
 * Whether an estimate is too old to chase as if it were the ball itself.
 *
 * Used where the estimate is doing the most work — a keeper projecting a fast
 * ball onto its guard line, or leaving the line to smother one. Once the
 * estimate is stale, the projection is a projection of where the ball *was*
 * going; holding position is cheaper than the sprint after a phantom.
 */
export function estimateStale(ball: FramedBall, limit = 0.15): boolean {
  return ball.age > limit;
}