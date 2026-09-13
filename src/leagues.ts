/**
 * The RCJA Soccer leagues this simulation runs (rule 1.2): Lightweight and
 * Open. The LEGO divisions (Simple Simon and Standard) are not offered.
 *
 * League is the axis the international rules do not have, and almost every
 * gameplay question in RCJA depends on it: which ball is used, whether a
 * dribbler is legal (4.6.5-4.6.6), and whether driving fully into the out
 * area makes a robot damaged (5.7.1.6). Anything that varies by league
 * belongs here, so a view can ask the league rather than hard-coding a
 * special case.
 */

export type LeagueId = 'lightweight' | 'open';

export type BallKind = 'ir-74' | 'passive-42';

export interface League {
  id: LeagueId;
  name: string;
  /** One line on who the league is for (rule 1.2). */
  blurb: string;
  ball: BallKind;
  /** Rule 4.1.1 limits. */
  maxWeightKg: number;
  maxDiameterMm: number;
  maxHeightMm: number;
  ballCaptureMm: number;
  /** Rule 2.2.2-2.2.3. */
  minWallHeightMm: number;
  /** Rule 4.6.5-4.6.6. */
  dribblerAllowed: boolean;
  /** Rule 4.7: kickers are Lightweight and Open only. */
  kickerAllowed: boolean;
  /** Angled chip kickers lofting the ball over defenders (Lightweight & Open). */
  chipKickerAllowed: boolean;
  /** Downward-facing line sensor reflex ring around chassis perimeter. */
  lineSensorsAllowed: boolean;
  /** Rule 5.7.1.6: driving fully into the out area makes a robot damaged. */
  fullyOutIsDamaged: boolean;
  /** Rule 5.7.3.1 vs 5.7.3.2: whether removal needs referee approval. */
  removalNeedsRefereeApproval: boolean;
  /** Rule 4.5.4: compass and gyro. */
  gyroCompassAllowed: boolean;
  /** Rule 4.5.5: omni wheels. */
  omniWheelsAllowed: boolean;
  /** Rule 4.2.5: inter-robot communication. */
  commsAllowed: boolean;
  /** Rule 1.3: which leagues can qualify for the international event. */
  internationalPathway: string | null;
  /** Voltage ceiling, rule 4.1.4. */
  maxVoltageDc: number;
  accent: string;
}

export const LEAGUES: readonly League[] = [
  {
    id: 'lightweight',
    name: 'Lightweight',
    blurb: 'Mid-level, unrestricted components, IR ball. Pathway to RCJ Soccer Lightweight.',
    ball: 'ir-74',
    maxWeightKg: 1.4,
    maxDiameterMm: 220,
    maxHeightMm: 220,
    ballCaptureMm: 30,
    minWallHeightMm: 100,
    dribblerAllowed: true,
    kickerAllowed: true,
    chipKickerAllowed: true,
    lineSensorsAllowed: true,
    fullyOutIsDamaged: true,
    removalNeedsRefereeApproval: true,
    gyroCompassAllowed: true,
    omniWheelsAllowed: true,
    commsAllowed: true,
    internationalPathway: 'RCJ Soccer Lightweight',
    maxVoltageDc: 48,
    accent: '#f0b455',
  },
  {
    id: 'open',
    name: 'Open',
    blurb: 'High level, passive orange ball, up to 2.5 kg. Pathway to RCJ Soccer Open.',
    ball: 'passive-42',
    maxWeightKg: 2.5,
    maxDiameterMm: 220,
    maxHeightMm: 220,
    ballCaptureMm: 15,
    minWallHeightMm: 220,
    dribblerAllowed: true,
    kickerAllowed: true,
    chipKickerAllowed: true,
    lineSensorsAllowed: true,
    fullyOutIsDamaged: true,
    removalNeedsRefereeApproval: true,
    gyroCompassAllowed: true,
    omniWheelsAllowed: true,
    commsAllowed: true,
    internationalPathway: 'RCJ Soccer Open',
    maxVoltageDc: 48,
    accent: '#ff8f6b',
  },
];

export const DEFAULT_LEAGUE: LeagueId = 'open';

export function getLeague(id: LeagueId): League {
  const found = LEAGUES.find((l) => l.id === id);
  if (!found) throw new Error(`Unknown league: ${id}`);
  return found;
}

export function isLeagueId(value: string): value is LeagueId {
  return LEAGUES.some((l) => l.id === value);
}

/** Ball diameter in mm. Rule 3.1 / appendices A.3 and B.1. */
export function ballDiameter(league: League): number {
  return league.ball === 'ir-74' ? 74 : 42;
}

/** Human-readable ball description for the inspector panel. */
export function ballDescription(league: League): string {
  return league.ball === 'ir-74'
    ? '74 mm infrared ball (Elekit RCJ-05, mode A)'
    : '42 mm passive orange golf ball';
}