/**
 * Championship Agent Type Definitions.
 */

import type { DriveSpec } from '../drive';

export type ChampionRole = 'striker' | 'goalie';

export type ChampionIntent =
  | 'KICKOFF'
  | 'INTERCEPT'
  | 'APPROACH'
  | 'CARRY'
  | 'DRIBBLE_ROUND'
  | 'SHOOT'
  | 'PASS'
  | 'RECEIVE'
  | 'COVER'
  | 'COVER_MOUTH'
  | 'SMOTHER'
  | 'GUARD'
  | 'CLEAR'
  | 'BREAKOUT'
  | 'SEARCH'
  | 'RECOVER'
  | 'OFF_THE_LINE';

export interface PoseEstimate {
  x: number;
  z: number;
  confidence: number;
}

export interface BallEstimate {
  x: number;
  z: number;
  vx: number;
  vz: number;
  age: number;
  seen: boolean;
  fresh: boolean;
}

export interface Obstacle {
  x: number;
  z: number;
  range: number;
  bearing: number;
}

/**
 * Where the robot is, in attack-relative coordinates.
 *
 * Same shape as `PoseEstimate` and deliberately a different type, because they
 * are not interchangeable and a compiler that says so is worth the duplication.
 * The estimator works in field coordinates - it has to, since what anchors it
 * is the paint on the two goals, and paint does not move at half-time. Only
 * past `GoalFrame` does `+x` start meaning "towards the goal we are shooting
 * at"; everything the deciders below see is on that side of the line.
 */
export interface FramedPose {
  x: number;
  z: number;
  confidence: number;
}

/** The ball, in attack-relative coordinates. See `FramedPose`. */
export interface FramedBall {
  x: number;
  z: number;
  vx: number;
  vz: number;
  seen: boolean;
  /** Seconds since the estimate was last corrected by a sighting. */
  age: number;
  speed(): number;
  /** Where it will be in `seconds`, still in attack-relative coordinates. */
  predict(seconds: number): [number, number];
}

/** Broadcast over team radio (Rule 4.2.5). */
export interface ChampionRadioMessage {
  role: ChampionRole;
  pos?: [number, number];
  ball?: [number, number];
  confidence: number;
  held: boolean;
  intent: ChampionIntent;
  claim?: number;
  ready?: boolean;
  offLine?: boolean;
}

export interface ChampionOptions {
  team: 'violet' | 'lime';
  number: 1 | 2;
  role?: ChampionRole;
  drive?: DriveSpec;
  skill?: number;
  name?: string;
}

export const ROBOT_RADIUS = 110.0;
export const BALL_RADIUS = 21.0;
export const CONTACT_RANGE = ROBOT_RADIUS + BALL_RADIUS; // 131.0
export const WHEEL_RADIUS = 25.0;
export const MOUNT_RADIUS = 90.0;
