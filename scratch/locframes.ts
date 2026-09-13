/** Ideal frames at known poses, so python's position fix can be graded. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Senses, type MatchView, type SenseInput } from '../src/perception';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locframes.json');

// The four kick-off positions with the headings resetRobots gives them, then
// a spread, each paired with its 180-degree rotation.
const spots: [number, number, number][] = [
  [-765, 0, 0],
  [765, 0, Math.PI],
  [-146, 0, 0],
  [146, 0, Math.PI],
  [-570, 0, 0],
  [570, 0, Math.PI],
  [-400, 200, 0],
  [400, -200, Math.PI],
  [-800, -300, 0.4],
  [800, 300, 0.4 + Math.PI],
  [-300, 450, 1.2],
  [300, -450, 1.2 + Math.PI],
];

const out = spots.map(([x, z, heading]) => {
  const senses = new Senses(0xbeef, 4, true);
  const self = { id: 'cyan-1', team: 'cyan', number: 1, x, z, heading };
  const view: MatchView = {
    clock: 1,
    playing: true,
    ball: { x: 0, z: 0 },
    robots: [self],
    kickoff: { pending: true, team: 'cyan', countdown: 0 },
  };
  const input: SenseInput = {
    view,
    self,
    wheelSpeeds: [0, 0, 0, 0],
    omega: 0,
    held: false,
    messages: [],
    attackDirection: 1,
    dt: 0.02,
  };
  return { x, z, heading, frame: senses.read(input) };
});

fs.writeFileSync(OUT, JSON.stringify(out));
console.log('wrote', out.length, 'poses');
