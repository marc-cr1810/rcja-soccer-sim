import { CameraState, Noise } from '../src/sensors';
import { GOAL_MOUTH_X, HALF_GOAL_WIDTH } from '../src/field';

const deg = (r: number) => ((r * 180) / Math.PI).toFixed(1).padStart(6);

function look(label: string, pose: { x: number; z: number; heading: number }, blockers: { x: number; z: number }[]) {
  const cam = new CameraState();
  cam.step(1);
  const r = cam.read(pose, { x: 0, z: 0 }, blockers, new Noise(7), true, true); // ideal: no noise
  const blobs = r.goalBlobs.yellow;
  const widest = blobs.length ? Math.max(...blobs.map((b) => b.end - b.start)) : 0;
  console.log(
    `${label.padEnd(34)} blobs=${blobs.length}  ` +
      blobs.map((b) => `[${deg(b.start)}..${deg(b.end)}]`).join(' ') +
      `   widest=${deg(widest)}deg  range~${blobs.length ? (140 / blobs[0]!.height).toFixed(0) : '-'}mm`,
  );
}

const gx = GOAL_MOUTH_X;
console.log('--- yellow goal, robot at (300, 0) facing +x ---');
const me = { x: 300, z: 0, heading: 0 };
look('empty net', me, []);
look('keeper mid-mouth', me, [{ x: gx - 100, z: 0 }]);
look('keeper on the -z post', me, [{ x: gx - 100, z: -140 }]);
look('two robots shoulder to shoulder', me, [{ x: gx - 100, z: -90 }, { x: gx - 100, z: 90 }]);
look('three robots across the face', me, [
  { x: gx - 100, z: -150 },
  { x: gx - 100, z: 0 },
  { x: gx - 100, z: 150 },
]);
look('one robot right in my face', me, [{ x: 460, z: 0 }]);

console.log('\n--- same keeper, near vs far from ME ---');
look('blocker close to me', me, [{ x: 500, z: 0 }]);
look('blocker far from me (on line)', me, [{ x: gx - 20, z: 0 }]);

console.log('\n--- viewing angle ---');
look('square on, 300mm out', { x: gx - 300, z: 0, heading: 0 }, []);
look('off to the side', { x: gx - 300, z: 500, heading: 0 }, []);
console.log(`(mouth is ${2 * HALF_GOAL_WIDTH}mm wide)`);
