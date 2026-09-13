/**
 * Is the drivetrain the limit, or is the mixer?
 *
 * The question is whether a robot that feels slow to come round is short of
 * motor, or short of the motor it already has - `mixOmni` sums translation and
 * rotation and then divides by the peak, so a robot asking for full speed has
 * already spent the headroom that spinning needs.
 */
import { mixOmni, openDrive, stepDrive, type DrivenBody } from '../src/drive';

const spec = openDrive();
const DT = 1 / 50;

function fresh(): DrivenBody {
  return { x: 0, z: 0, heading: 0, vx: 0, vz: 0, omega: 0, mass: 2500 };
}

/** Settled yaw rate and speed when asking for this mix, held for 3 s. */
function settle(bearing: number, speed: number, spin: number) {
  const b = fresh();
  for (let t = 0; t < 3; t += DT) {
    stepDrive(b, spec, mixOmni(spec, bearing, speed, spin), DT);
  }
  return { omega: b.omega, speed: Math.hypot(b.vx, b.vz) };
}

/** Seconds to turn 180 degrees from rest, asking for this much translation. */
function halfTurn(speed: number): number {
  const b = fresh();
  let turned = 0;
  for (let t = 0; t < 10; t += DT) {
    const before = b.heading;
    stepDrive(b, spec, mixOmni(spec, 0, speed, 1), DT);
    turned += Math.abs(b.heading - before) > Math.PI ? 0 : Math.abs(b.heading - before);
    if (turned >= Math.PI) return t;
  }
  return Infinity;
}

const d = (r: number) => ((r * 180) / Math.PI).toFixed(0).padStart(4);

console.log('What the drivetrain can actually do');
console.log('  top speed forward      ', settle(0, 1, 0).speed.toFixed(0).padStart(5), 'mm/s');
console.log('  top speed at 45 deg    ', settle(Math.PI / 4, 1, 0).speed.toFixed(0).padStart(5), 'mm/s');
console.log('  spin on the spot       ', d(settle(0, 0, 1).omega), 'deg/s');
console.log('  180 turn, not moving   ', halfTurn(0).toFixed(2), 's');

console.log('\nWhat is left of the spin once the robot is also translating');
console.log('  speed  spin asked   yaw achieved   translation achieved');
for (const speed of [0, 0.25, 0.5, 0.75, 1.0]) {
  const r = settle(0, speed, 1);
  console.log(
    `  ${speed.toFixed(2)}       1.00      ${d(r.omega)} deg/s      ${r.speed.toFixed(0).padStart(5)} mm/s`,
  );
}

console.log('\n180 turn while asking for translation too');
for (const speed of [0, 0.5, 1.0]) {
  console.log(`  speed ${speed.toFixed(2)}: ${halfTurn(speed).toFixed(2)} s`);
}
