/**
 * Remove the AI (and python) entirely. Two robots run an IDENTICAL, hand-
 * coded "drive at the ball, dribble it toward the opponent's goal, kick when
 * lined up" script - one attacking +x, one attacking -x, perfectly mirrored -
 * and we check whether they score at the same rate. No sensors, no
 * perception, no noise: this reads world state directly, so if this comes
 * out asymmetric, the bug is in World/Match/physics, not in striker.py.
 */
import { World } from '../src/world';
import { getLeague } from '../src/leagues';
import { mixOmni, openDrive, wrapAngle, type DriveSpec } from '../src/drive';
import type { Robot } from '../src/world';

const drive: DriveSpec = openDrive();

/** Drive straight at the ball; once close and roughly lined up on goal, fire. */
function scriptedTick(robot: Robot, ball: { x: number; z: number }, attackX: number): { motors: number[]; kick: boolean } {
  const toBallBearing = wrapAngle(Math.atan2(ball.z - robot.z, ball.x - robot.x) - robot.heading);
  const toGoalField = Math.atan2(0 - ball.z, attackX - ball.x);
  const toGoalBearing = wrapAngle(toGoalField - robot.heading);
  const distToBall = Math.hypot(ball.x - robot.x, ball.z - robot.z);

  // Approach from behind the ball on the line to goal, same shape every real
  // agent in this repo uses, just without any of the edge-case handling.
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

function runOne(attackX: number, seconds: number): { goals: number; finalClock: number } {
  const w = new World({ league: getLeague('open'), halfLengthSeconds: 300, inclined: false });
  w.running = true;
  const strikerId = attackX > 0 ? 'cyan-1' : 'yellow-1';
  // Take everyone except the one scripted striker off the field entirely, so
  // there is no physics interaction to muddy the read. A large penalty stops
  // the self-running match's auto-return (5.7.4) bringing them straight back
  // - and resetRobots()'s own stillRemoved carry-over keeps this true across
  // every kick-off, including after a goal, without re-applying it here.
  for (const r of w.robots) {
    if (r.id === strikerId) continue;
    r.removed = true;
    r.penaltyRemaining = 9999;
  }
  const firstStriker = w.robots.find((r) => r.id === strikerId)!;
  firstStriker.x = -attackX * 0.5;
  firstStriker.z = 0;
  firstStriker.heading = attackX > 0 ? 0 : Math.PI;

  const dt = 1 / 100;
  const ticks = Math.round(seconds / dt);
  let kickCooldown = 0;
  let goals = 0;
  const scoreBefore = w.score.cyan + w.score.yellow;
  for (let i = 0; i < ticks; i++) {
    kickCooldown = Math.max(0, kickCooldown - dt);
    // Re-fetch by id every tick: a goal replaces the whole robots array via
    // resetRobots(), which would otherwise leave this pointed at a robot no
    // longer in the world - see world.ts's kickOff()/resetRobots().
    const striker = w.robots.find((r) => r.id === strikerId)!;
    const { motors, kick } = scriptedTick(striker, w.ball, attackX);
    striker.motors = motors;
    if (kick && kickCooldown === 0) {
      w.ball.vx = Math.cos(striker.heading) * 2400;
      w.ball.vz = Math.sin(striker.heading) * 2400;
      kickCooldown = 1.2;
    }
    w.step(dt);
    const total = w.score.cyan + w.score.yellow;
    if (total > scoreBefore + goals) goals = total - scoreBefore;
  }
  return { goals, finalClock: w.clock };
}

console.log('Scripted, non-AI, mirrored striker: does it score at the same rate attacking +x vs -x?\n');
const trials = 30;
let plusGoals = 0;
let minusGoals = 0;
for (let t = 0; t < trials; t++) {
  plusGoals += runOne(1, 15).goals;
  minusGoals += runOne(-1, 15).goals;
}
console.log(`Over ${trials} x 15s trials each:`);
console.log(`  attacking +x: ${plusGoals} goals`);
console.log(`  attacking -x: ${minusGoals} goals`);
