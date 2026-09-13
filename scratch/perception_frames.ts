/**
 * Generate ideal sensor frames for mirrored robot+ball poses so we can test
 * whether python's perception (Locator/BallTracker) is mirror-symmetric.
 *
 * Mirror:  (x, z, heading, ballX, ballZ)  ->  (-x, z, PI-heading, -ballX, ballZ)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Senses, type MatchView, type SenseInput } from '../src/perception';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'frames');
fs.mkdirSync(OUT, { recursive: true });

function make(tag: string, x: number, z: number, heading: number, ballX: number, ballZ: number): void {
  const senses = new Senses(0x1234, 4, true);
  const self = { id: 'cyan-1', team: 'cyan', number: 1, x, z, heading };
  const view: MatchView = {
    clock: 123.0,
    playing: true,
    ball: { x: ballX, z: ballZ },
    robots: [self],
    kickoff: { pending: false, team: null },
  };
  const input: SenseInput = {
    view,
    self,
    wheelSpeeds: [100, -100, 100, -100],
    omega: 0,
    held: false,
    messages: [],
    attackDirection: 1,
    dt: 0.02,
  };
  const frame = senses.read(input);
  fs.writeFileSync(path.join(OUT, `${tag}.json`), JSON.stringify(frame));
}

const poses: [string, number, number, number, number, number][] = [
  ['p300', 300, 0, 0.0, 600, 0],
  ['p600', 600, 0, 0.0, 700, 100],
  ['p800', 800, 0, 0.12, 850, 150],
  ['p300z', 300, 220, 0.6, 550, 40],
  ['p0', 0, 0, 1.1, 300, -200],
  ['p0n', 0, -120, -0.9, -400, 60],
  ['p400h30', 400, 50, 0.3, 750, -80],
  ['pn300', -600, 0, 3.1, -700, -120],
];
for (const [tag, x, z, h, bx, bz] of poses) {
  make(tag, x, z, h, bx, bz);
  make('m_' + tag, -x, z, Math.PI - h, -bx, bz);
}
console.log('wrote', poses.length * 2, 'frames');