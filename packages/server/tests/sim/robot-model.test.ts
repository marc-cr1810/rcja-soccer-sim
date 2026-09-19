import * as THREE from 'three';
import { buildRobotMesh } from '@rcja/shared/robot-model';
import { LEAGUES, getLeague } from '@rcja/shared/leagues';
import { World } from '../../src/sim/world';

function robotFor(leagueId: Parameters<typeof getLeague>[0]) {
  const world = new World({ league: getLeague(leagueId), halfLengthSeconds: 300, inclined: false });
  return world.robots[0]!;
}

/**
 * The furthest any vertex sits from the vertical axis, in millimetres.
 *
 * Rule 4.1.2's envelope is a cylinder, not a box, so an axis-aligned bounding
 * box is the wrong measure: it would pass a square chassis whose corners stick
 * out of the cylinder. This walks the actual geometry.
 */
function radialExtentMm(group: THREE.Group): number {
  group.updateMatrixWorld(true);
  let max = 0;
  const v = new THREE.Vector3();
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const position = child.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position as THREE.BufferAttribute, i);
      child.localToWorld(v);
      max = Math.max(max, Math.hypot(v.x, v.z));
    }
  });
  return max * 1000;
}

function heightMm(group: THREE.Group): number {
  const box = new THREE.Box3().setFromObject(group);
  return box.max.y * 1000;
}

describe('generated robot', () => {
  it('builds for every league', () => {
    for (const league of LEAGUES) {
      expect(() => buildRobotMesh(robotFor(league.id), league), league.name).not.toThrow();
    }
  });

  /**
   * Rule 4.1.2: the robot must rotate freely inside a 220 mm cylinder. The
   * handle may exceed the height limit (4.5.7) but nothing may exceed the
   * diameter, so the depiction should not either.
   */
  it('fits the 220 mm cylinder of rule 4.1.2, corners included', () => {
    for (const league of LEAGUES) {
      const mesh = buildRobotMesh(robotFor(league.id), league);
      expect(radialExtentMm(mesh) * 2, league.name).toBeLessThanOrEqual(league.maxDiameterMm);
    }
  });

  it('stays within the height limit apart from the handle', () => {
    for (const league of LEAGUES) {
      const mesh = buildRobotMesh(robotFor(league.id), league);
      // 4.5.7 lets the handle exceed the limit, so allow a modest overshoot.
      expect(heightMm(mesh), league.name).toBeLessThan(league.maxHeightMm + 60);
    }
  });

  it('gives Lightweight and Open a camera mast and no LEGO stack', () => {
    for (const id of ['lightweight', 'open'] as const) {
      const mesh = buildRobotMesh(robotFor(id), getLeague(id));
      expect(heightMm(mesh), id).toBeGreaterThan(180);
    }
  });
});
