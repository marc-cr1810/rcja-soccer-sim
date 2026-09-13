/**
 * Robot geometry, generated from the league's own construction rules.
 *
 * The app ships no robot model files. That is partly to keep it asset-free,
 * but mostly because the rules never describe a specific chassis - rule 4.1.2
 * defines a robot as whatever rotates freely inside a 220 mm cylinder - so a
 * generated robot can be accurate to every league in a way one team's model
 * cannot.
 *
 * Both leagues this simulation runs (Lightweight and Open) are unrestricted -
 * omni wheels, a dribbler roller inset to the league's ball capture limit
 * (4.1.1), a kicker plate (4.7) and a camera mast (4.5) - so the mesh is the
 * same shape in every league; only the ball capture recess differs. The LEGO
 * divisions (Simple Simon, Standard) are not offered.
 *
 * To use a real model instead, see loadRobotModel below.
 */

import * as THREE from 'three';
import type { League } from './leagues';
import type { ViewRobot } from './view';

const MM = 0.001;

/**
 * Team colours, distinct from the goal paint (blue `0x00a6c4` / yellow
 * `0xf2c500`). RCJA rule 3.1 bars robots coloured orange, yellow or blue, so
 * the teams run violet and lime.
 */
export const TEAM_COLOUR = { violet: 0x8b5cf6, lime: 0x3fce5a } as const;
const DARK = 0x11161c;
const METAL = 0xb9c2cc;
const RUBBER = 0x1b1f24;

function mat(color: number, roughness = 0.6, metalness = 0.05): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/** Wheels sit tangentially on the rim, axle pointing outward. */
function addWheels(group: THREE.Group, radius: number): void {
  // Four omni wheels on the diagonals is the usual Lightweight and Open
  // layout, and it reads as a robot from overhead in a way a three-wheel
  // layout does not: nothing sits dead ahead of the dribbler or dead astern.
  const wheelRadius = 30 * MM;
  const wheelWidth = 22 * MM;
  const q = Math.PI / 4;
  const angles = [q, 3 * q, 5 * q, 7 * q];

  /**
   * Rule 4.1.2's envelope is a cylinder, so the constraint is on the wheel's
   * outermost RIM CORNER, not its centre line or its outer face: that corner
   * sits at hypot(centre + width/2, wheelRadius) from the axis. Solving for
   * the centre keeps the whole tyre legal.
   */
  const maxCentre = Math.sqrt(radius * radius - wheelRadius * wheelRadius) - wheelWidth / 2;

  for (const angle of angles) {
    const centre = maxCentre - 2 * MM;
    const position = new THREE.Vector3(
      Math.cos(angle) * centre,
      wheelRadius,
      Math.sin(angle) * centre,
    );

    const tyre = new THREE.Mesh(
      new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 18),
      mat(RUBBER, 0.92),
    );
    tyre.rotation.z = Math.PI / 2;
    tyre.rotation.y = -angle;
    tyre.position.copy(position);
    tyre.castShadow = true;
    group.add(tyre);

    // Omni rollers read as a lighter hub proud of the tyre. Built co-axially
    // with the tyre so it cannot drift outside the envelope.
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(wheelRadius * 0.74, wheelRadius * 0.74, wheelWidth * 1.06, 14),
      mat(METAL, 0.45, 0.5),
    );
    hub.rotation.copy(tyre.rotation);
    hub.position.copy(position);
    group.add(hub);
  }
}

/**
 * The dribbler, and the gap it leaves in front of the robot, which is literally
 * the ball capture zone rule 4.1.1 limits to 30 mm, or 15 mm in Open.
 */
function addDribbler(group: THREE.Group, league: League, deckTop: number): void {
  const capture = league.ballCaptureMm * MM;
  const rollerRadius = 12 * MM;
  const rollerLength = 70 * MM;
  const mouthFace = 98 * MM;
  const cheekDepth = capture + rollerRadius * 2;

  const roller = new THREE.Mesh(
    new THREE.CylinderGeometry(rollerRadius, rollerRadius, rollerLength, 16),
    mat(RUBBER, 0.95),
  );
  roller.rotation.x = Math.PI / 2;
  roller.position.set(mouthFace - capture - rollerRadius, deckTop * 0.42, 0);
  group.add(roller);

  // Cheek plates either side of the roller form the capture zone, and read as
  // a notch in the outline from directly overhead.
  for (const side of [-1, 1] as const) {
    const cheek = new THREE.Mesh(
      new THREE.BoxGeometry(cheekDepth, deckTop * 0.52, 8 * MM),
      mat(DARK, 0.5),
    );
    cheek.position.set(
      mouthFace - cheekDepth / 2,
      deckTop * 0.4,
      side * (rollerLength / 2 + 4 * MM),
    );
    group.add(cheek);

    // Optical ball gate sensors (IR beam-break) mounted on the inner cheek
    // faces for sub-millisecond mechanical possession detection. Kept to a
    // dark grey, not red, so it never reads as the rival team's colour or
    // the orange ball.
    const gateOptic = new THREE.Mesh(
      new THREE.CylinderGeometry(2 * MM, 2 * MM, 2 * MM, 8),
      mat(0x5a636e, 0.2, 0.9),
    );
    gateOptic.rotation.x = Math.PI / 2;
    gateOptic.position.set(
      mouthFace - capture * 0.6,
      deckTop * 0.32,
      side * (rollerLength / 2 - 1 * MM),
    );
    group.add(gateOptic);
  }
}

/** Rule 4.7: kickers exist only in Lightweight and Open. */
function addKicker(group: THREE.Group, league: League): void {
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(7 * MM, 28 * MM, 62 * MM),
    mat(METAL, 0.3, 0.75),
  );
  plate.position.set(84 * MM, 22 * MM, 0);
  group.add(plate);

  // Angled chip-kicker wedge beneath the main solenoid plate for lofted kicks.
  if (league.chipKickerAllowed) {
    const chipRamp = new THREE.Mesh(
      new THREE.BoxGeometry(14 * MM, 4 * MM, 54 * MM),
      mat(0xd4af37, 0.3, 0.8),
    );
    chipRamp.position.set(86 * MM, 8 * MM, 0);
    chipRamp.rotation.z = 0.48; // ~27.5 degree loft ramp
    group.add(chipRamp);
  }
}

/**
 * Rule 4.5 allows any number of cameras in Lightweight and Open. A short post
 * with a housing on top reads as a robot; a bare spike does not.
 */
function addCamera(group: THREE.Group, deckTop: number): void {
  const postHeight = 46 * MM;
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(11 * MM, 13 * MM, postHeight, 12),
    mat(0x424b56, 0.5, 0.3),
  );
  post.position.set(-26 * MM, deckTop + postHeight / 2, 0);
  group.add(post);

  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(34 * MM, 28 * MM, 32 * MM),
    mat(0x2b323a, 0.45),
  );
  housing.position.set(-26 * MM, deckTop + postHeight + 14 * MM, 0);
  housing.rotation.z = -0.12;
  housing.castShadow = true;
  group.add(housing);

  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(9 * MM, 9 * MM, 6 * MM, 16),
    mat(0x0c1013, 0.15, 0.8),
  );
  lens.rotation.z = Math.PI / 2;
  lens.position.set(-8 * MM, deckTop + postHeight + 14 * MM, 0);
  group.add(lens);
}

/**
 * Rule 4.5.7: a stable, easily noticeable handle, liftable from 50 mm clear of
 * the highest structure. A bail across the deck reads as a handle from any
 * angle; a flat ring lying on top does not.
 */
function addHandle(group: THREE.Group, deckTop: number, span: number): void {
  const bar = new THREE.Mesh(
    new THREE.CylinderGeometry(4 * MM, 4 * MM, span * 2, 8),
    mat(0xc9d1d9, 0.35, 0.4),
  );
  bar.rotation.x = Math.PI / 2;
  bar.position.set(20 * MM, deckTop + 34 * MM, 0);
  group.add(bar);

  for (const side of [-1, 1] as const) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(3.5 * MM, 3.5 * MM, 34 * MM, 8),
      mat(0xc9d1d9, 0.35, 0.4),
    );
    post.position.set(20 * MM, deckTop + 17 * MM, side * span);
    group.add(post);
  }
}

/**
 * Heading marker. The default camera is straight overhead, so the robot has to
 * say which way it is facing in plan view - an arrowhead on the deck does that
 * far better than a marker on the side.
 */
function addHeadingArrow(group: THREE.Group, colour: number, y: number): void {
  // A flat chevron painted on the deck. A cone here would be a triangular
  // pyramid standing proud of the robot, which reads as a spike rather than a
  // marking - robots do not have spikes on them.
  const shape = new THREE.Shape();
  shape.moveTo(46 * MM, 0);
  shape.lineTo(4 * MM, 26 * MM);
  shape.lineTo(12 * MM, 0);
  shape.lineTo(4 * MM, -26 * MM);
  shape.closePath();

  const geometry = new THREE.ShapeGeometry(shape);
  const arrow = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide }),
  );
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.set(34 * MM, y, 0);
  group.add(arrow);
}

export function buildRobotMesh(robot: ViewRobot, league: League): THREE.Group {
  const group = new THREE.Group();
  const colour = TEAM_COLOUR[robot.team];
  const radius = robot.radius * MM;

  const bodyHeight = 108 * MM;
  const bodyBase = 14 * MM;
  const deckTop = bodyBase + bodyHeight + 12 * MM;

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.98, radius * 0.93, bodyHeight, 40),
    mat(0x323a44, 0.5, 0.2),
  );
  body.position.y = bodyBase + bodyHeight / 2;
  body.castShadow = true;
  group.add(body);

  // Rule 4.3.1: team marking. A band on the shell and a ring on the deck make
  // the team obvious from the side and from directly overhead respectively.
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.99, radius * 0.99, 26 * MM, 40),
    mat(colour, 0.42),
  );
  band.position.y = bodyBase + bodyHeight * 0.74;
  group.add(band);

  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.98, radius * 0.98, 12 * MM, 40),
    mat(0x3e4753, 0.45, 0.25),
  );
  deck.position.y = deckTop - 6 * MM;
  group.add(deck);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(92 * MM, 5 * MM, 8, 40),
    mat(colour, 0.4),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = deckTop + 1 * MM;
  group.add(ring);

  addDribbler(group, league, deckTop);
  if (league.kickerAllowed) addKicker(group, league);
  addCamera(group, deckTop);
  addWheels(group, radius);
  addHeadingArrow(group, colour, deckTop + 4 * MM);
  addHandle(group, deckTop, 46 * MM);

  return group;
}

/**
 * Optional replacement for the generated robot.
 *
 * Point this at a GLB and it is used instead, for both teams, tinted by the
 * team colour where the model leaves a slot for it. Nothing ships with the app:
 * a robot model is someone's work, so only add one you have permission to
 * redistribute, and record that permission in the repository.
 *
 * The model is expected to be Z-up-free, metres, origin at the centre of the
 * footprint, facing +x. It is scaled to the 220 mm cylinder of rule 4.1.2.
 */
export async function loadRobotModel(url: string): Promise<THREE.Group> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const model = gltf.scene;

  // Normalise to the legal envelope rather than trusting the export's units.
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const footprint = Math.max(size.x, size.z);
  if (footprint > 0) {
    const scale = (220 * MM) / footprint;
    model.scale.setScalar(scale);
  }
  model.traverse((child) => {
    if (child instanceof THREE.Mesh) child.castShadow = true;
  });
  return model;
}
