/**
 * Extend the clean scripted-striker test with a scripted KEEPER (a direct,
 * simplified TS port of goalie.py's core "guard the line, track the ball,
 * chase it loose in the box" behaviour) so the contest is a real 1v1, still
 * with no python/websocket overhead - fast enough to iterate on directly.
 *
 * If this stays symmetric, the bug needs the keeper's fuller state machine
 * (CLEAR/SMOTHER/OFF_THE_LINE/PINNED_TURN) or the striker's fuller one
 * (unstick, cover, edge-steering) to show up. If it goes asymmetric here,
 * it's in this reduced core - much smaller haystack.
 */
import { World, type Robot } from '../src/world';
import { getLeague } from '../src/leagues';
import { mixOmni, openDrive, wrapAngle, type DriveSpec } from '../src/drive';
import { HALF_LENGTH, HALF_WIDTH, PENALTY_DEPTH } from '../src/field';

const drive: DriveSpec = openDrive();
const POST_CLAMP = 180;

function strikerTick(robot: Robot, ball: { x: number; z: number }, attackX: number): { motors: number[]; kick: boolean } {
  const toBallBearing = wrapAngle(Math.atan2(ball.z - robot.z, ball.x - robot.x) - robot.heading);
  const toGoalField = Math.atan2(0 - ball.z, attackX - ball.x);
  const toGoalBearing = wrapAngle(toGoalField - robot.heading);
  const distToBall = Math.hypot(ball.x - robot.x, ball.z - robot.z);
  const approachField = Math.atan2(
    ball.z - Math.sin(toGoalField) * 150 - robot.z,
    ball.x - Math.cos(toGoalField) * 150 - robot.x,
  );
  const approachBearing = wrapAngle(approachField - robot.heading);
  const aligned = Math.abs(wrapAngle(toGoalBearing - toBallBearing)) < 0.3;
  const bearing = distToBall < 200 && aligned ? toBallBearing : approachBearing;
  const motors = mixOmni(drive, bearing, 1, 0);
  const facingGoal = Math.abs(toGoalBearing) < 0.15;
  const kick = distToBall < 160 && facingGoal;
  return { motors, kick };
}

/** direction: +1 attacks +x (defends -x), -1 attacks -x (defends +x) - same convention as goalie.py's FORWARD. */
function keeperTick(
  robot: Robot,
  ball: { x: number; z: number; vx: number; vz: number },
  direction: 1 | -1,
): { motors: number[] } {
  const DEFEND_X = direction > 0 ? -HALF_LENGTH : HALF_LENGTH;
  const FORWARD = direction;
  const GUARD_X = DEFEND_X + FORWARD * 175;
  const depth = (ball.x - DEFEND_X) * FORWARD;
  const inBox = depth < PENALTY_DEPTH + 60 && Math.abs(ball.z) < 450 / 2 + 40;

  let targetX = GUARD_X;
  let targetZ = 0;

  const ballSpeed = Math.hypot(ball.vx, ball.vz);
  if (ballSpeed > 220) {
    const closing = -ball.vx * FORWARD;
    if (closing > 60) {
      const travel = ((ball.x - GUARD_X) * FORWARD) / closing;
      const t = Math.max(0, Math.min(1.4, travel));
      const futureZ = ball.z + ball.vz * t; // straight-line predict, matches BallTracker.predict closely enough
      targetZ = Math.max(-POST_CLAMP, Math.min(POST_CLAMP, futureZ));
    }
  } else {
    const span = DEFEND_X - ball.x;
    if (Math.abs(span) >= 1) {
      const shadow = ball.z + ((GUARD_X - ball.x) / span) * -ball.z;
      targetZ = Math.max(-POST_CLAMP, Math.min(POST_CLAMP, shadow));
    }
  }

  const reachable = Math.hypot(ball.x - robot.x, ball.z - robot.z) < 520;
  if (inBox && reachable && (ballSpeed < 350 || depth < 150)) {
    targetX = DEFEND_X + FORWARD * Math.max(0, Math.min(PENALTY_DEPTH, (ball.x - DEFEND_X) * FORWARD));
    targetZ = Math.max(-420, Math.min(420, ball.z));
  }

  const dx = targetX - robot.x;
  const dz = targetZ - robot.z;
  const gap = Math.hypot(dx, dz);
  if (gap < 18) return { motors: [0, 0, 0, 0] };
  const travelField = Math.atan2(dz, dx);
  const bearing = wrapAngle(travelField - robot.heading);
  const speed = Math.max(0.3, Math.min(1, gap / 90));
  return { motors: mixOmni(drive, bearing, speed, 0) };
}

function runOne(attackX: 1 | -1, seconds: number): number {
  const w = new World({ league: getLeague('open'), halfLengthSeconds: 300, inclined: false });
  w.running = true;
  const strikerId = attackX > 0 ? 'cyan-1' : 'yellow-1';
  const keeperId = attackX > 0 ? 'yellow-2' : 'cyan-2';
  const others = w.robots.filter((r) => r.id !== strikerId && r.id !== keeperId);
  for (const r of others) {
    r.removed = true;
    r.penaltyRemaining = 9999;
  }

  const dt = 1 / 100;
  const ticks = Math.round(seconds / dt);
  let kickCooldown = 0;
  let goals = 0;
  const scoreBefore = w.score.cyan + w.score.yellow;
  for (let i = 0; i < ticks; i++) {
    kickCooldown = Math.max(0, kickCooldown - dt);
    const striker = w.robots.find((r) => r.id === strikerId)!;
    const keeper = w.robots.find((r) => r.id === keeperId)!;
    const { motors, kick } = strikerTick(striker, w.ball, attackX);
    striker.motors = motors;
    keeper.motors = keeperTick(keeper, w.ball, (attackX > 0 ? -1 : 1) as 1 | -1).motors;
    if (kick && kickCooldown === 0) {
      w.ball.vx = Math.cos(striker.heading) * 2400;
      w.ball.vz = Math.sin(striker.heading) * 2400;
      kickCooldown = 1.2;
    }
    w.step(dt);
    const total = w.score.cyan + w.score.yellow;
    if (total > scoreBefore + goals) goals = total - scoreBefore;
  }
  return goals;
}

console.log('Scripted striker vs scripted keeper (simplified goalie.py port): symmetric?\n');
const trials = 40;
let plusGoals = 0;
let minusGoals = 0;
for (let t = 0; t < trials; t++) {
  plusGoals += runOne(1, 20);
  minusGoals += runOne(-1, 20);
}
console.log(`Over ${trials} x 20s trials each:`);
console.log(`  striker attacking +x (keeper defending +x): ${plusGoals} goals`);
console.log(`  striker attacking -x (keeper defending -x): ${minusGoals} goals`);
