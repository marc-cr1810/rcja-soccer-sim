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
import { ballDiameter, type League } from './leagues';
import type { ViewRobot } from './view';

const MM = 0.001;

/**
 * Team colours, distinct from the goal paint (blue `0x00a6c4` / yellow
 * `0xf2c500`). RCJA rule 3.1 bars robots coloured orange, yellow or blue, so
 * the teams run violet and lime.
 */
export const TEAM_COLOUR = { violet: 0x8b5cf6, lime: 0x3fce5a } as const;
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
 * The dribbler, placed where the ball it holds actually is.
 *
 * `dribblerRecess` in world.ts lets a captured ball sink into the robot by
 * half the league's capture limit and no further - 7.5 mm in Open - so the
 * ball sits very nearly ON the 220 mm envelope, not inside it. A bay cut back
 * into the shell was therefore a hole nothing ever entered: the ball hung in
 * front of an empty recess. The roller instead sits as far forward as rule
 * 4.1.2 allows, hard against where the ball comes to rest, and the shell keeps
 * its round silhouette.
 */
function addDribbler(group: THREE.Group, league: League, envelope: number, shell: number): void {
  const ballRadius = (ballDiameter(league) / 2) * MM;
  const recess = (Math.min(league.ballCaptureMm, ballDiameter(league) / 2) / 2) * MM;
  /** Centre of a ball the dribbler is holding, in the robot's own frame. */
  const heldX = envelope + ballRadius - recess;

  const rollerRadius = 12 * MM;
  const rollerHalf = 22 * MM;

  /*
   * The roller goes as far forward as rule 4.1.2 allows and no further. The
   * constraint is its front rim CORNER, not its centre line - the cylinder
   * does not care which part of the roller reaches it first - so the corner is
   * what gets solved for. Its height then follows: high enough above the
   * carpet to rest on the ball it is holding, which is where a dribbler grips.
   */
  const reach = ballRadius + rollerRadius;
  const rollerX = Math.sqrt(envelope * envelope - rollerHalf * rollerHalf) - rollerRadius;
  const standoff = heldX - rollerX;
  const rollerY = ballRadius + Math.sqrt(Math.max(reach * reach - standoff * standoff, 0));

  const roller = new THREE.Mesh(
    new THREE.CylinderGeometry(rollerRadius, rollerRadius, rollerHalf * 2, 18),
    mat(0x99a2ad, 0.8),
  );
  roller.rotation.x = Math.PI / 2;
  roller.position.set(rollerX, rollerY, 0);
  roller.castShadow = true;
  group.add(roller);

  for (const side of [-1, 1] as const) {
    // Bearing caps, which is what says the roller is driven.
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(rollerRadius * 0.5, rollerRadius * 0.5, 6 * MM, 12),
      mat(METAL, 0.25, 0.6),
    );
    cap.rotation.x = Math.PI / 2;
    cap.position.set(rollerX, rollerY, side * (rollerHalf + 3 * MM));
    group.add(cap);

    /*
     * Cheek plates carrying the roller. They run from the shell out to the
     * roller so the ball is framed by them rather than hanging off a bare bar,
     * and they stop where rule 4.1.2's cylinder crosses their outer face -
     * further out from the axis than the roller's ends, so they stop sooner.
     */
    const cheekZ = side * (rollerHalf + 6 * MM);
    // Measured at the plate's OUTER face, so the whole plate clears 4.1.2.
    const tip = Math.sqrt(envelope * envelope - (Math.abs(cheekZ) + 2.5 * MM) ** 2);
    const root = Math.sqrt(Math.max(shell * shell - cheekZ * cheekZ, 0)) - 8 * MM;
    const cheek = new THREE.Mesh(
      new THREE.BoxGeometry(tip - root, rollerY + rollerRadius, 5 * MM),
      mat(0x272d35, 0.5),
    );
    cheek.position.set((tip + root) / 2, (rollerY + rollerRadius) / 2, cheekZ);
    cheek.castShadow = true;
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
    gateOptic.position.set(tip - 5 * MM, rollerY * 0.55, cheekZ - side * 3 * MM);
    group.add(gateOptic);
  }
}

/**
 * Rule 4.7: kickers exist only in Lightweight and Open. The plate sits on the
 * front of the shell, below the roller, where it can reach a held ball.
 */
function addKicker(group: THREE.Group, league: League, shell: number): void {
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(7 * MM, 22 * MM, 56 * MM),
    mat(METAL, 0.3, 0.75),
  );
  plate.position.set(shell - 5 * MM, 14 * MM, 0);
  group.add(plate);

  // Angled chip-kicker wedge beneath the main solenoid plate for lofted kicks.
  if (league.chipKickerAllowed) {
    const chipRamp = new THREE.Mesh(
      new THREE.BoxGeometry(12 * MM, 4 * MM, 48 * MM),
      mat(0xd4af37, 0.3, 0.8),
    );
    // Tilted, so its far corner reaches further forward than its centre does;
    // seated back far enough that the corner still clears rule 4.1.2.
    chipRamp.position.set(shell - 4 * MM, 4 * MM, 0);
    chipRamp.rotation.z = 0.48; // ~27.5 degree loft ramp
    group.add(chipRamp);
  }
}

/**
 * The camera, which is the one part of the robot that has to match how it
 * behaves. `CAMERA_FOV` in sensors.ts is a full 2*pi: the robot sees the whole
 * horizon at once, and a box with a lens in one face said the opposite.
 *
 * So it is drawn as what actually gives a robot that view - a catadioptric
 * rig: the camera itself sits on the deck looking straight up, a clear tube
 * carries a conical mirror above it, apex down, and the mirror wraps the whole
 * 360 degrees into the frame. On the centre line, because an omnidirectional
 * view with a blind spot behind the mast would not be omnidirectional.
 */
function addCamera(group: THREE.Group, deckTop: number, number: string, colour: number): void {
  const moduleHeight = 24 * MM;
  const collarHeight = 6 * MM;
  const tubeHeight = 62 * MM;
  const mirrorHeight = 30 * MM;
  // The mirror has to fit INSIDE the tube that carries it, and the cap has to
  // cover both, or the mast reads as a lump rather than as an optical rig.
  const mirrorRadius = 34 * MM;
  const tubeRadius = mirrorRadius + 4 * MM;
  const tubeBase = deckTop + collarHeight;

  // A collar the tube seats in. Without it the tube's wall stood on nothing -
  // it is wider than the camera under it - and the whole mast read as floating
  // a hand's width above the robot.
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(tubeRadius + 3 * MM, tubeRadius + 5 * MM, collarHeight, 28),
    mat(0x39424d, 0.5, 0.25),
  );
  collar.position.set(0, deckTop + collarHeight / 2, 0);
  collar.castShadow = true;
  group.add(collar);

  // The camera module, lens up, standing inside the tube at the bottom.
  const module = new THREE.Mesh(
    new THREE.CylinderGeometry(17 * MM, 19 * MM, moduleHeight, 16),
    mat(0x2b323a, 0.45),
  );
  module.position.set(0, tubeBase + moduleHeight / 2, 0);
  group.add(module);

  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(8 * MM, 9 * MM, 5 * MM, 16),
    mat(0x0c1013, 0.15, 0.8),
  );
  lens.position.set(0, tubeBase + moduleHeight + 2 * MM, 0);
  group.add(lens);

  // The acrylic tube holding the mirror up, seated on the collar. Transparent,
  // or it would be the blind spot the whole arrangement exists to avoid.
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(tubeRadius, tubeRadius, tubeHeight, 24, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0xdcecf6,
      roughness: 0.15,
      metalness: 0,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
    }),
  );
  tube.position.set(0, tubeBase + tubeHeight / 2, 0);
  group.add(tube);

  // The mirror: a cone apex-down over the lens, which is what turns a forward
  // lens into a view of the whole horizon.
  const mirror = new THREE.Mesh(
    new THREE.ConeGeometry(mirrorRadius, mirrorHeight, 28),
    // The scene carries no environment map, so a truly metallic surface has
    // nothing to reflect and renders black. A bright, faintly self-lit
    // dielectric is what actually reads as polished from every angle.
    new THREE.MeshStandardMaterial({
      color: 0xeef3f8,
      roughness: 0.22,
      metalness: 0.1,
      emissive: 0x39424e,
    }),
  );
  mirror.rotation.x = Math.PI;
  mirror.position.set(0, tubeBase + tubeHeight - mirrorHeight / 2, 0);
  mirror.castShadow = true;
  group.add(mirror);

  /*
   * The cap the mirror hangs from, drawn to the mirror's own diameter so the
   * two read as one part. It is also the largest flat surface the robot has
   * facing the overhead camera, which makes it the place to put the robot's
   * number: on the deck it was hidden under the mast, and on the shell it only
   * showed from whichever side you happened to be standing.
   */
  const capTop = tubeBase + tubeHeight + 3 * MM;
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(mirrorRadius, mirrorRadius, 6 * MM, 28),
    mat(0x14181e, 0.55, 0.15),
  );
  cap.position.set(0, capTop, 0);
  cap.castShadow = true;
  group.add(cap);

  const decal = numberDecal(number, colour, mirrorRadius * 1.7);
  if (decal) {
    // Turned so the digit's own upright runs along the robot's heading, the
    // way the arrow on the deck does: from overhead the two agree.
    const facing = new THREE.Object3D();
    facing.rotation.y = -Math.PI / 2;
    decal.rotation.x = -Math.PI / 2;
    decal.position.y = capTop + 3.5 * MM;
    facing.add(decal);
    group.add(facing);
  }
}

/**
 * The robot's number, drawn to a texture.
 *
 * Returns null where there is no canvas to draw on - the test suite runs in
 * node, and a robot that cannot be built there is a robot the rule 4.1.2
 * envelope check cannot measure. The number is decoration; the mesh is not.
 */
function numberDecal(number: string, colour: number, size: number): THREE.Mesh | null {
  if (typeof document === 'undefined') return null;

  const px = 128;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = `#${colour.toString(16).padStart(6, '0')}`;
  ctx.font = `bold ${px * 0.8}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(number, px / 2, px * 0.54);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
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
  const envelope = robot.radius * MM;

  const bodyHeight = 108 * MM;
  const bodyBase = 14 * MM;
  const deckTop = bodyBase + bodyHeight + 12 * MM;
  /*
   * The shell is drawn inside rule 4.1.2's cylinder rather than on it, which
   * is how a real chassis is built: what reaches the limit is the hardware
   * bolted to the outside - the wheels, and the dribbler on the front.
   */
  const shell = envelope * 0.93;

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(shell, shell * 0.95, bodyHeight, 40),
    mat(0x323a44, 0.5, 0.2),
  );
  body.position.y = bodyBase + bodyHeight / 2;
  body.castShadow = true;
  group.add(body);

  // Rule 4.3.1: team marking. A band on the shell and a ring on the deck make
  // the team obvious from the side and from directly overhead respectively.
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(shell * 1.01, shell * 1.01, 26 * MM, 40),
    mat(colour, 0.42),
  );
  band.position.y = bodyBase + bodyHeight * 0.74;
  group.add(band);

  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(shell, shell, 12 * MM, 40),
    mat(0x3e4753, 0.45, 0.25),
  );
  deck.position.y = deckTop - 6 * MM;
  group.add(deck);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(shell * 0.87, 5 * MM, 8, 40),
    mat(colour, 0.4),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = deckTop + 1 * MM;
  group.add(ring);

  addDribbler(group, league, envelope, shell);
  if (league.kickerAllowed) addKicker(group, league, shell);
  addCamera(group, deckTop, robot.id.slice(robot.id.lastIndexOf('-') + 1), colour);
  addWheels(group, envelope);
  addHeadingArrow(group, colour, deckTop + 4 * MM);

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
