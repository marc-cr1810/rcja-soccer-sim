/**
 * What a spectator is shown, plus the portable match-result types.
 *
 * This module lives in @rcja/shared so the Vite frontends can import it
 * without pulling in the full server. Everything here is plain JSON — it
 * has to survive a socket trip, and the types must be self-contained so
 * the viewer never needs to import from @rcja/server.
 *
 * Types that were formerly spread across match.ts, world.ts and agent.ts
 * but are pure data-transfer objects belong here. The server re-exports
 * them from their original locations for backward compatibility.
 */

import type { League } from './leagues';

// ---------------------------------------------------------------------------
// Primitive shared types (formerly in world.ts / match.ts / agent.ts)
// ---------------------------------------------------------------------------

export type TeamId = 'violet' | 'lime';

export type EventKind =
  | 'goal'
  | 'ball-out-of-play'
  | 'lack-of-progress'
  | 'possible-multiple-defence'
  | 'possible-damaged'
  | 'kickoff'
  | 'kickoff-live'
  | 'illegal-kickoff'
  | 'paused'
  | 'resumed'
  | 'score-corrected'
  | 'mercy';

/** A referee call, recorded and sent to viewers. */
export interface MatchEvent {
  kind: EventKind;
  /** Rule number this event hangs off, for the referee panel. */
  rule: string;
  message: string;
  /** Robot the referee would be acting on, where there is one. */
  robotId?: string;
  team?: TeamId;
  at: number;
}

/**
 * Something a referee did, in the order they did it.
 *
 * Only actions that actually took effect: `resume()` and `returnRobot()` both
 * refuse in states where the button does nothing, and a log saying play resumed
 * when it did not is worse than no log.
 */
export interface RefereeAction {
  action: string;
  /** Match clock the referee acted at. */
  at: number;
  /** Whichever of robot, team or reason the action carried. */
  detail?: string;
}

/** A referee's correction to the score, kept for the match record. */
export interface ScoreCorrection {
  team: TeamId;
  from: number;
  to: number;
  reason: string;
  /** Match clock the correction was made at. */
  at: number;
}

/** Per-robot connection health, as reported at the end of a match. */
export interface SlotReport {
  name: string;
  /** Control cycles where no fresh command arrived. */
  missed: number;
  /** Cycles where the program threw. */
  errors: number;
  lastError: string | null;
  /** Longest unbroken run of missed cycles, which is what a viewer notices. */
  worstRun: number;
}

/** Performance statistics per robot seat. */
export interface RobotStats {
  goals: number;
  saves: number;
  shots: number;
  penalties: number;
}

/** The final record of a match. */
export interface MatchResult {
  score: Record<TeamId, number>;
  /** Seconds of match time played. */
  clock: number;
  goals: { team: TeamId; at: number; half: 1 | 2; robotId?: string }[];
  /** Per-robot connection health, for the match record. */
  slots: Record<string, SlotReport>;
  /**
   * Every referee call of the match, counted by kind.
   *
   * Kept alongside `events` rather than derived from it: a balance run wants
   * the tally and nothing else, and counting as they happen costs nothing.
   */
  calls: Record<string, number>;
  /**
   * Every referee call of the match, in order, whole.
   *
   * Not `world.events`, which is a 60-entry ring buffer sized for the referee
   * panel and silently drops the early part of a ten-minute match. Drained as
   * it fills, so a match record can say what actually happened rather than
   * only how it ended.
   */
  events: MatchEvent[];
  /** Every referee action that took effect, in order. */
  refereeActions: RefereeAction[];
  /** Every score correction a referee made, in order. */
  scoreCorrections: ScoreCorrection[];
  /** Whether a referee ended the match early rather than it running full time. */
  abandoned: boolean;
  abandonReason?: string;
  /**
   * Whether the mercy rule ended it rather than the clock.
   *
   * Deliberately not `abandoned`: an abandoned fixture is left unwritten and
   * replayed, and a mercy result is a finished match that counts. A table
   * wants to be able to say which of the two a short match was.
   */
  mercy?: boolean;
  /** Performance statistics per robot seat. */
  robotStats?: Record<string, RobotStats>;
}

// ---------------------------------------------------------------------------
// Renderer-facing view types
// ---------------------------------------------------------------------------

/** A robot, as far as drawing it is concerned. */
export interface ViewRobot {
  id: string;
  team: 'violet' | 'lime';
  x: number;
  z: number;
  /** Radians; 0 points towards +x. */
  heading: number;
  radius: number;
  /** Off the field under rule 5.7, so drawn hidden rather than moved away. */
  removed: boolean;
  /** Rule 5.8: nominated goalie. */
  isGoalie: boolean;
  /**
   * Seconds left of the 5.7.2 stand-down.
   *
   * A robot taken off is off for at least thirty seconds, and until it comes
   * back its team is playing a robot short. That is the single most consequential
   * thing that can happen in a match short of a goal, and it was invisible: the
   * robot simply vanished from the field with no indication of why or for how
   * long. Reaching zero does not put it back on — 5.7.4 needs the referee.
   */
  penaltyRemaining: number;
  /** The rule it came off under, e.g. '5.7.1.6'. */
  removalRule?: string;
  removalReason?: string;
}

export interface ViewBall {
  x: number;
  z: number;
  /** Height above the carpet, for a chip kick under 4.7. */
  y?: number;
  radius: number;
}

/** A referee call, as the overlay shows it. */
export interface ViewEvent {
  kind: string;
  rule: string;
  message: string;
  at: number;
  team?: 'violet' | 'lime';
}

/** A restart the referee has placed but not yet whistled live. */
export interface ViewKickoff {
  /**
   * The team taking the restart. Null between restarts, when the previous
   * half's kick-off has been played out.
   */
  team: 'violet' | 'lime' | null;
  /**
   * Seconds left before the whistle makes the kick-off live; 0 when no
   * countdown is running (including headless matches, which never have one).
   */
  countdown: number;
}

/**
 * The break between the halves, while there is one.
 *
 * The one window in a match where a team may correct their code, so it is on
 * the frame: a referee's console and a hall screen both want to count it down,
 * and both already have the stream.
 */
export interface HalfTime {
  /** When the first half ended, ISO, in wall time. */
  since: string;
  /** How long this venue's half-time is, in seconds. */
  seconds: number;
  /** Seconds left of it, floored at 0. It keeps counting past zero as 0. */
  remaining: number;
  /** Which sides have said they are ready to play on. */
  ready: { violet: boolean; lime: boolean };
  /** Whether the five minutes are up. From here a referee may kick off freely. */
  over: boolean;
}

/**
 * The frame a viewer draws.
 *
 * Sent at a rate the eye needs rather than the rate the physics runs at: the
 * world steps 100 times a second and nobody can see the difference above about
 * 30, so sending every step would be three times the bandwidth for none of the
 * benefit — and venue wifi is the one thing at an event that can be relied on
 * to be bad.
 */
export interface ViewFrame {
  /** Seconds into the match. */
  clock: number;
  half: 1 | 2;
  running: boolean;
  kickoff: ViewKickoff;
  /** Present only between the halves of a refereed match that has one. */
  halfTime?: HalfTime;
  score: { violet: number; lime: number };
  ball: ViewBall;
  robots: ViewRobot[];
  /** Rule 4.2.5 traffic, for the comms lines the lab's renderer draws. */
  commsEnabled: boolean;
  commsActivity: { violet: number; lime: number };
  /** The most recent calls, newest last. Enough for a banner, not a log. */
  events: ViewEvent[];
  /** Who is playing, for the scoreboard. */
  teams: { violet: string; lime: string };
}

/** Everything the renderer needs, and nothing else. */
export interface RenderView {
  clock: number;
  ball: ViewBall;
  robots: readonly ViewRobot[];
  commsEnabled: boolean;
  // Keyed explicitly rather than by string, so a renderer reading
  // commsActivity[team] gets a number rather than number | undefined.
  commsActivity: { violet: number; lime: number };
}

/** The league is sent once, when a viewer joins, because it never changes mid-match. */
export interface ViewHello {
  type: 'hello';
  league: League;
  teams: { violet: string; lime: string };
  halfSeconds: number;
}

export interface ViewUpdate {
  type: 'frame';
  frame: ViewFrame;
}

export interface ViewDeltaRobot {
  id: string;
  x: number;
  z: number;
  heading: number;
  removed?: boolean;
  penaltyRemaining?: number;
}

export interface ViewDeltaFrame {
  clock: number;
  ball: { x: number; z: number; y?: number };
  robots: ViewDeltaRobot[];
  commsActivity?: { violet: number; lime: number };
  score?: { violet: number; lime: number };
  kickoff?: ViewKickoff;
  events?: ViewEvent[];
  halfTime?: HalfTime;
  running?: boolean;
  half?: 1 | 2;
}

export interface ViewDelta {
  type: 'delta';
  delta: ViewDeltaFrame;
}

export interface ViewSummary {
  type: 'summary';
  result: MatchResult;
  /** Seconds until the next match will automatically start (e.g. in demo mode). */
  nextMatchIn?: number;
}

export type ViewMessage = ViewHello | ViewUpdate | ViewDelta | ViewSummary;

/**
 * Applies a delta frame onto a full ViewFrame.
 */
export function applyViewDelta(current: ViewFrame, d: ViewDeltaFrame): ViewFrame {
  const robots = current.robots.map((r) => {
    const dr = d.robots.find((item) => item.id === r.id);
    if (!dr) return r;
    return {
      ...r,
      x: dr.x,
      z: dr.z,
      heading: dr.heading,
      removed: dr.removed ?? r.removed,
      penaltyRemaining: dr.penaltyRemaining ?? r.penaltyRemaining,
    };
  });
  return {
    ...current,
    clock: d.clock,
    ball: {
      ...current.ball,
      x: d.ball.x,
      z: d.ball.z,
      y: d.ball.y !== undefined ? d.ball.y : current.ball.y,
    },
    robots,
    commsActivity: d.commsActivity ?? current.commsActivity,
    score: d.score ?? current.score,
    kickoff: d.kickoff ?? current.kickoff,
    events: d.events ?? current.events,
    halfTime: d.halfTime !== undefined ? d.halfTime : current.halfTime,
    running: d.running !== undefined ? d.running : current.running,
    half: d.half ?? current.half,
  };
}

/** How often the server sends a frame. */
export const VIEW_HZ = 30;
