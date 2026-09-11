/**
 * The four RCJA Soccer leagues (rule 1.2).
 *
 * League is the axis the international rules do not have, and almost every
 * gameplay question in RCJA depends on it: which ball is used, when the ball
 * is out of play (5.9.1), whether a dribbler is legal (4.6.5-4.6.6), and
 * whether driving fully into the out area makes a robot damaged (5.7.1.6).
 * Anything that varies by league belongs here, so a view can ask the league
 * rather than hard-coding a special case.
 */

export type LeagueId = 'simple-simon' | 'standard' | 'lightweight' | 'open';

export type BallKind = 'ir-74' | 'passive-42';

/** How rule 5.9.1 decides the ball has left play, which differs per league. */
export type OutOfPlayMode =
  /** Lightweight and Open: out when the ball leaves the playing area. */
  | 'leaves-play-area'
  /** Standard (and Simple Simon on inclined fields): any wall, including goal sides. */
  | 'any-wall'
  /** Standard/Simple Simon on inclined fields: only the back wall or goal sides. */
  | 'back-wall-or-goal-sides'
  /** Simple Simon: only the wall behind either goal. */
  | 'wall-behind-goal';

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
  /** Rule 5.7.1.6 applies only to Lightweight and Open. */
  fullyOutIsDamaged: boolean;
  /** Rule 5.7.3.1 vs 5.7.3.2: Simple Simon may remove a robot without approval. */
  removalNeedsRefereeApproval: boolean;
  /** Rule 4.5.4: compass and gyro are barred in Simple Simon only. */
  gyroCompassAllowed: boolean;
  /**
   * Rule 4.5.5 allows non-LEGO omni wheels in Standard (max 80 mm), and
   * Lightweight and Open are unrestricted. Simple Simon has neither, so its
   * robots cannot translate sideways and have to turn to go anywhere - which
   * is why Simple Simon play looks so different from the rest.
   */
  omniWheelsAllowed: boolean;
  /** Rule 4.5.2: LEGO-only construction. */
  legoOnly: boolean;
  /** Rule 4.2.5: inter-robot communication, common in Lightweight and Open. */
  commsAllowed: boolean;
  /** Rule 1.3: which leagues can qualify for the international event. */
  internationalPathway: string | null;
  outOfPlay: OutOfPlayMode;
  /** Only meaningful where outOfPlay depends on whether inclines are used. */
  outOfPlayInclined?: OutOfPlayMode;
  /** Voltage ceiling, rule 4.1.4. Null where the LEGO battery is the limit. */
  maxVoltageDc: number | null;
  accent: string;
}

export const LEAGUES: readonly League[] = [
  {
    id: 'simple-simon',
    name: 'Simple Simon',
    blurb: 'Beginner league, LEGO only, IR ball. Teams may compete for up to 2 years.',
    ball: 'ir-74',
    maxWeightKg: 1.0,
    maxDiameterMm: 220,
    maxHeightMm: 220,
    ballCaptureMm: 30,
    minWallHeightMm: 100,
    dribblerAllowed: false,
    kickerAllowed: false,
    chipKickerAllowed: false,
    lineSensorsAllowed: false,
    fullyOutIsDamaged: false,
    removalNeedsRefereeApproval: false,
    gyroCompassAllowed: false,
    omniWheelsAllowed: false,
    legoOnly: true,
    commsAllowed: false,
    internationalPathway: null,
    /**
     * Rule 5.9.1's table gives Simple Simon two rows: a shared row with
     * Standard that depends on inclines, and its own row saying the ball is
     * out if it strikes the wall behind either goal. Read here as the more
     * specific row governing, so inclines make no difference in this league.
     * Worth confirming with the Technical Committee.
     */
    outOfPlay: 'wall-behind-goal',
    maxVoltageDc: null,
    accent: '#6ea8fe',
  },
  {
    id: 'standard',
    name: 'Standard',
    blurb: 'LEGO construction with an approved third-party sensor list, IR ball.',
    ball: 'ir-74',
    maxWeightKg: 1.0,
    maxDiameterMm: 220,
    maxHeightMm: 220,
    ballCaptureMm: 30,
    minWallHeightMm: 100,
    dribblerAllowed: false,
    kickerAllowed: false,
    chipKickerAllowed: false,
    lineSensorsAllowed: true,
    fullyOutIsDamaged: false,
    removalNeedsRefereeApproval: true,
    gyroCompassAllowed: true,
    omniWheelsAllowed: true,
    legoOnly: true,
    commsAllowed: false,
    internationalPathway: null,
    outOfPlay: 'any-wall',
    outOfPlayInclined: 'back-wall-or-goal-sides',
    maxVoltageDc: null,
    accent: '#7ddc9a',
  },
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
    legoOnly: false,
    commsAllowed: true,
    internationalPathway: 'RCJ Soccer Lightweight',
    outOfPlay: 'leaves-play-area',
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
    legoOnly: false,
    commsAllowed: true,
    internationalPathway: 'RCJ Soccer Open',
    outOfPlay: 'leaves-play-area',
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

/**
 * Rule 5.9.1 in plain words, for the league and field setup in play.
 * `inclined` only changes the answer for Standard and Simple Simon.
 */
export function outOfPlayRule(league: League, inclined: boolean): string {
  const mode = inclined && league.outOfPlayInclined ? league.outOfPlayInclined : league.outOfPlay;
  switch (mode) {
    case 'leaves-play-area':
      return 'The ball is out of play once it leaves the playing area.';
    case 'any-wall':
      return 'The ball is out of play if it strikes any wall, including the sides of the goals.';
    case 'back-wall-or-goal-sides':
      return 'The ball is out of play if it strikes the back wall or the sides of the goals.';
    case 'wall-behind-goal':
      return 'The ball is out of play if it strikes the wall behind either goal.';
  }
}
