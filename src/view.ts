/**
 * What a spectator is shown.
 *
 * The renderer used to take a `World`. That was fine inside the lab, where the
 * thing being drawn and the thing being simulated are the same object in the
 * same process. It is not fine here: a viewer in the hall is at the other end
 * of a socket and has no world, no physics and no rule detectors — only what
 * the server told it a moment ago.
 *
 * So this is the narrow middle. A live `World` satisfies it structurally, and
 * so does a snapshot that arrived over the network, which means the renderer
 * draws both without knowing or caring which it has.
 *
 * Everything here is plain JSON for the same reason the sensor frames are: it
 * has to survive the trip.
 */

import type { League } from './leagues';

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

export type ViewMessage = ViewHello | ViewUpdate;

/** How often the server sends a frame. */
export const VIEW_HZ = 30;
