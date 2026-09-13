/**
 * Field geometry for RCJA Soccer 2026.
 *
 * Every value here is taken from the RCJA Soccer Rules 2026 (v26.0, 17 Feb 2026)
 * field diagram in section 2 and the prose of sections 2.1-2.4. Units are
 * millimetres throughout; the renderer scales to metres at the last moment.
 *
 * Coordinate system (right-handed, y up):
 *   +x  towards the yellow goal      -x  towards the cyan goal
 *   +z  towards one sideline         -z  towards the other
 *    y  height above the carpet
 * The origin is the centre of the playing area.
 *
 * Rule 2.1.5: all field dimensions carry a 5% tolerance. Robots should be
 * designed for it, so the simulator exposes it rather than pretending the
 * field is exact.
 */

/** Outer extent, wall to wall, including the out area. Diagram: 2430 x 1820. */
export const OUTER_LENGTH = 2430;
export const OUTER_WIDTH = 1820;

/** Rule 2.1.1: white lines are 50 mm thick, set 250 mm in from the walls. */
export const OUT_BAND = 250;
export const LINE_THICKNESS = 50;

/**
 * The playing area is inside the white lines, exclusive of them (rule 2.1.1),
 * so each side loses the 250 mm band plus the 50 mm line.
 * 2430 - 2*300 = 1830 long; 1820 - 2*300 = 1220 wide. The diagram's 915 mm
 * half-length dimension confirms the 1830.
 */
export const PLAY_LENGTH = OUTER_LENGTH - 2 * (OUT_BAND + LINE_THICKNESS); // 1830
export const PLAY_WIDTH = OUTER_WIDTH - 2 * (OUT_BAND + LINE_THICKNESS); // 1220

export const HALF_LENGTH = PLAY_LENGTH / 2; // 915
export const HALF_WIDTH = PLAY_WIDTH / 2; // 610

/** Rule 2.3: goal is 450 mm wide internally, 74 mm deep, crossbar at 140 mm. */
export const GOAL_WIDTH = 450;
/**
 * How thick the goal's own walls are. The rules dimension the goal internally
 * and say nothing about the panels, so this matches the perimeter walls. It is
 * the difference between the 450 mm opening a ball has to fit through and the
 * outside of the structure a robot bumps into, which is 40 mm wider.
 */
export const GOAL_WALL_THICKNESS = 20;
export const GOAL_DEPTH = 74;
export const CROSSBAR_HEIGHT = 140;
export const CROSSBAR_DEPTH = 20;

/** Penalty box from the field diagram: 300 mm deep, 900 mm wide. */
export const PENALTY_DEPTH = 300;
export const PENALTY_WIDTH = 900;

/** Rule 2.1.1: penalty boxes and neutral points are marked in 25 mm black line. */
export const MARKING_THICKNESS = 25;

/**
 * Rule 2.4: two neutral points, plus a centre point used for kick-offs and
 * for repeated lack of progress. The diagram puts the pair on the halfway
 * line, 300 mm either side of centre.
 */
export const NEUTRAL_OFFSET = 300;

export interface Point {
  x: number;
  z: number;
}

/** Rule 2.4.2: the centre point is last in the list; it is the fallback. */
export const NEUTRAL_POINTS: readonly Point[] = [
  { x: 0, z: -NEUTRAL_OFFSET },
  { x: 0, z: NEUTRAL_OFFSET },
  { x: 0, z: 0 },
];

/** Rule 2.2: wall height differs by league; see leagues.ts for the per-league value. */
export const WALL_HEIGHT_NATIONALS = 220;

/** Rule 2.1.2: the out area may be inclined by raising its outer edge 10 mm. */
export const INCLINE_RISE = 10;

/** Rule 2.1.5. */
export const DIMENSION_TOLERANCE = 0.05;

export type GoalSide = 'cyan' | 'yellow';

/** Centre of the mouth of a goal, on the goal line. */
export function goalMouth(side: GoalSide): Point {
  return { x: side === 'cyan' ? -HALF_LENGTH : HALF_LENGTH, z: 0 };
}

/** True if a point lies inside the penalty box defending the given goal. */
export function inPenaltyBox(p: Point, side: GoalSide): boolean {
  const withinWidth = Math.abs(p.z) <= PENALTY_WIDTH / 2;
  if (!withinWidth) return false;
  return side === 'cyan'
    ? p.x <= -HALF_LENGTH + PENALTY_DEPTH
    : p.x >= HALF_LENGTH - PENALTY_DEPTH;
}

/**
 * True if a point is fully outside the playing area, i.e. in the out band.
 * Used for rule 5.7.1.6 (Lightweight/Open: a robot wholly in the out area is
 * damaged) and for the Lightweight/Open ball-out-of-play test (5.9.1).
 */
export function isOutOfPlay(p: Point): boolean {
  return Math.abs(p.x) > HALF_LENGTH || Math.abs(p.z) > HALF_WIDTH;
}

/** Rule 5.6.2 / 5.9.2: the ball goes to the nearest neutral point. */
export function nearestNeutralPoint(p: Point, occupied: readonly Point[] = []): Point {
  const free = NEUTRAL_POINTS.filter(
    (np) => !occupied.some((o) => Math.hypot(o.x - np.x, o.z - np.z) < 110),
  );
  const candidates = free.length > 0 ? free : NEUTRAL_POINTS;
  let best = candidates[0]!;
  let bestDist = Infinity;
  for (const np of candidates) {
    const d = Math.hypot(np.x - p.x, np.z - p.z);
    if (d < bestDist) {
      bestDist = d;
      best = np;
    }
  }
  return best;
}

/**
 * Longitudinal placement of the goals.
 *
 * The field diagram in section 2 puts the goal mouth on the INNER edge of the
 * white line - the goal line proper - so the mouth is flush with the edge of
 * the playing area and the goal itself stands in the out area, its 74 mm of
 * depth eating into the 250 mm band between the line and the end wall.
 *
 * That leaves 226 mm of out area behind the goal. Rule 2.3.6 closes it off by
 * carrying the goal's side walls back to the end wall, so the goal and those
 * walls together are one solid block running from the goal line to the wall;
 * `collideWithPerimeter` treats them as exactly that. The out area either side
 * of the block stays open carpet, reachable like the out area at the touchlines.
 */
export const WALL_X = OUTER_LENGTH / 2; // 1215
export const WALL_Z = OUTER_WIDTH / 2; // 910
export const GOAL_MOUTH_X = HALF_LENGTH; // 915
export const GOAL_BACK_X = GOAL_MOUTH_X + GOAL_DEPTH; // 989
export const HALF_GOAL_WIDTH = GOAL_WIDTH / 2; // 225
/** Half the outside of the goal structure, walls included. */
export const HALF_GOAL_SHELL = HALF_GOAL_WIDTH + GOAL_WALL_THICKNESS; // 245

/**
 * True if a ball centre lies between the posts, i.e. over the mouth opening
 * (rule 2.3: goal is 450 mm wide internally). This is the referee's question
 * "is the ball over the goal", and it deliberately tests the whole opening
 * rather than a ball-radius-shortened one: whether the ball actually gets in
 * and scores is decided separately, by the radius margin in
 * `collideWithPerimeter`, and a ball that clips the mouth edge and rebounds
 * back onto the field must not be called out of play (5.9.1) for coming to
 * rest over the line between the posts.
 */
export function withinGoalMouth(z: number): boolean {
  return Math.abs(z) <= HALF_GOAL_WIDTH;
}
