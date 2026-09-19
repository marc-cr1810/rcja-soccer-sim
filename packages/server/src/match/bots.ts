/**
 * Deliberately poor robots.
 *
 * A rule detector fails on behaviour nobody thought to write, and the reference
 * agent is no help there: it plays sensibly, so it exercises the sensible half
 * of every detector and leaves the other half untested until a student finds it
 * at a state event.
 *
 * These are the other half. Each one does a single stupid thing well, chosen
 * because it is the stupid thing that pushes on a particular rule — camping in
 * the penalty area for 5.11, shoving without progressing for 5.6.1.2, driving
 * off the field for 5.7.1.6. They are also, uncomfortably often, what a real
 * first attempt looks like.
 */

import { mixOmni, openDrive, wrapAngle } from '../sim/drive';
import type { Agent } from './agent';
import type { ActuatorFrame, SensorFrame } from './protocol';

const drive = openDrive();
const stop: ActuatorFrame = { motors: [0, 0, 0, 0] };

/**
 * Drives straight at the ball, always.
 *
 * The first robot every team writes, and the reason the reference agent
 * approaches from the side instead: with no notion of which way it is pushing,
 * this one scores at both ends. Worth keeping precisely because it produces own
 * goals, which is a case the referee has to get right.
 */
export const naiveChaser: Agent = {
  name: 'naive-chaser',
  tick(frame) {
    if (!frame.playing || !frame.ball) return stop;
    return { motors: mixOmni(drive, frame.ball.bearing, 1, 0), dribbler: 1 };
  },
};

/**
 * Drives at the ball and never gives up.
 *
 * Where the chaser at least turns, this one commits everything forward, which
 * is how a ball ends up pinned between two robots going nowhere. Exists to
 * feed 5.6.1.2 lack of progress and 5.6.1.3 forcing.
 */
export const shover: Agent = {
  name: 'shover',
  tick(frame) {
    if (!frame.playing || !frame.ball) return { motors: mixOmni(drive, 0, 0.4, 0) };
    const spin = Math.max(-1, Math.min(1, frame.ball.bearing * 2));
    return { motors: mixOmni(drive, 0, 1, spin), dribbler: 1 };
  },
};

/** Spins on the spot. Sees everything, does nothing about it. */
export const spinner: Agent = {
  name: 'spinner',
  tick: (frame) => (frame.playing ? { motors: mixOmni(drive, 0, 0, 1) } : stop),
};

/** Stands still. The control case, and the one the reference agent still trips on. */
export const statue: Agent = {
  name: 'statue',
  tick: () => stop,
};

/**
 * Sits in its own goal and refuses to leave.
 *
 * Two of these on a side is a standing 5.11 multiple defence, which is the
 * point: the detector should keep noticing, and the removals should keep
 * coming, rather than the pair quietly parking there all match.
 */
export function camper(team: 'violet' | 'lime'): Agent {
  return {
    name: `camper-${team}`,
    tick(frame) {
      if (!frame.playing) return stop;
      // Facing away from the attack direction points at its own goal - ends
      // swap at half-time (rule 1.4/5.4), so this is read from the frame
      // rather than fixed from `team` at construction time.
      const homeward = frame.attackDirection > 0 ? Math.PI : 0;
      const toHome = wrapAngle(homeward - frame.compass.heading);
      // Stop once the wall behind is close, then hold the spot.
      const backedUp = (frame.range.back ?? 9999) < 200;
      return { motors: mixOmni(drive, backedUp ? 0 : toHome, backedUp ? 0 : 0.8, 0) };
    },
  };
}

/**
 * Drives at the nearest wall and keeps going.
 *
 * Feeds 5.7.1.6: a robot wholly in the out area is damaged and comes off for
 * thirty seconds. A detector that only ever sees robots stay in play is a
 * detector nobody has tested.
 */
export const waller: Agent = {
  name: 'waller',
  tick(frame) {
    if (!frame.playing) return stop;
    const ranges: [number, number | null][] = [
      [0, frame.range.front],
      [Math.PI / 2, frame.range.left],
      [Math.PI, frame.range.back],
      [-Math.PI / 2, frame.range.right],
    ];
    let bearing = 0;
    let nearest = Infinity;
    for (const [angle, range] of ranges) {
      if (range !== null && range < nearest) {
        nearest = range;
        bearing = angle;
      }
    }
    return { motors: mixOmni(drive, bearing, 1, 0) };
  },
};

/**
 * Full power in a direction that changes on its own schedule.
 *
 * Deterministic despite looking random — a ladder that cannot be replayed is
 * no use for chasing the bug it just found.
 */
export function wanderer(seed: number): Agent {
  let state = seed >>> 0 || 1;
  let bearing = 0;
  let hold = 0;
  return {
    name: `wanderer-${seed}`,
    tick(frame: SensorFrame): ActuatorFrame {
      if (!frame.playing) return stop;
      if (hold-- <= 0) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        bearing = ((state % 1000) / 1000) * 2 * Math.PI - Math.PI;
        hold = 20 + (state % 40);
      }
      return { motors: mixOmni(drive, bearing, 0.9, 0), dribbler: 1 };
    },
    reset() {
      state = seed >>> 0 || 1;
      hold = 0;
    },
  };
}

import { championTeam } from '../champion/index';

/** Every bot above, paired into two-robot teams for a ladder. */
export function botRoster(): { name: string; make: (team: 'violet' | 'lime') => Agent[] }[] {
  return [
    {
      name: 'champion',
      make: (t) => {
        const team = championTeam(t);
        return [team[`${t}-1`]!, team[`${t}-2`]!];
      },
    },
    { name: 'naive-chaser', make: () => [naiveChaser, naiveChaser] },
    { name: 'shover', make: () => [shover, shover] },
    { name: 'chaser+camper', make: (t) => [naiveChaser, camper(t)] },
    { name: 'spinner', make: () => [spinner, spinner] },
    { name: 'waller', make: () => [waller, waller] },
    { name: 'wanderer', make: () => [wanderer(7), wanderer(99)] },
    { name: 'statue', make: () => [statue, statue] },
  ];
}
