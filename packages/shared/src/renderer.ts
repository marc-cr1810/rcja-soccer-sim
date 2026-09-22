/**
 * three.js view of the field.
 *
 * Everything is generated from the dimensions in data/field.ts rather than
 * loaded from a model file. That is partly to keep the download small - the
 * app has no binary assets at all - but mostly because the rules define a
 * robot as whatever fits inside a 220 mm cylinder (rule 4.1.2), so a generic
 * cylinder is a more honest depiction than any one team's chassis.
 *
 * Scene units are metres; the simulation is in millimetres, so everything
 * crossing this boundary is divided by 1000.
 */

import * as THREE from 'three';
import {
  CROSSBAR_DEPTH,
  CROSSBAR_HEIGHT,
  GOAL_BACK_X,
  GOAL_MOUTH_X,
  GOAL_WALL_THICKNESS,
  GOAL_WIDTH,
  HALF_LENGTH,
  LINE_THICKNESS,
  MARKING_THICKNESS,
  NEUTRAL_POINTS,
  OUT_BAND,
  OUTER_LENGTH,
  OUTER_WIDTH,
  PENALTY_DEPTH,
  PENALTY_WIDTH,
  WALL_HEIGHT_NATIONALS,
  WALL_X,
  WALL_Z,
} from './field';
import type { League } from './leagues';
import { ballDiameter } from './leagues';
import type { RenderView } from './view';
import { FollowCamera } from './follow-camera';
import { buildRobotMesh, loadRobotModel, TEAM_COLOUR } from './robot-model';

const MM = 0.001;

/** Half extents of the whole field in metres, used to frame the overhead view. */
/** A little room above the carpet for the robots and the walls. */
const ROBOT_HEADROOM = 0.15;
/** Breathing room so the field is not jammed against the edge of the screen. */
const FRAME_MARGIN = 1.12;

const HALF_OUTER_X = (OUTER_LENGTH / 2) * MM;
const HALF_OUTER_Z = (OUTER_WIDTH / 2) * MM;

export type CameraMode = 'referee' | 'broadcast' | 'follow' | 'orbit';

const COLOURS = {
  carpet: 0x1f6b2e,
  line: 0xf2f5f0,
  marking: 0x101010,
  wall: 0x141414,
  cyan: 0x00a6c4,
  yellow: 0xf2c500,
  ballIr: 0xb8bcc0,
  ballOpen: 0xff7a1a,
};

/**
 * Rectangular outline drawn flat on the carpet.
 *
 * `length` and `width` are the OUTER extents of the marking and the band is
 * drawn inside them, which is how a field is actually marked out: the penalty
 * box's black line runs up to the white line and stops, rather than straddling
 * it. Centring each band on the nominal rectangle put half of every line on the
 * wrong side of the dimension it was supposed to be showing.
 */
function stripe(
  parent: THREE.Object3D,
  cx: number,
  cz: number,
  length: number,
  width: number,
  thickness: number,
  colour: number,
  y: number,
  /** Leave the end at this side of `cx` unmarked, for an outline open at one end. */
  openEnd: -1 | 0 | 1 = 0,
): void {
  const material = new THREE.MeshBasicMaterial({ color: colour });
  const halfL = length / 2 - thickness / 2;
  const halfW = width / 2 - thickness / 2;
  // The long sides run the full outer length, so they cover the corners and
  // the ends only have to span what is left between them.
  const segments: [number, number, number, number][] = [
    [cx, cz - halfW, length, thickness],
    [cx, cz + halfW, length, thickness],
  ];
  if (openEnd !== -1) segments.push([cx - halfL, cz, thickness, width - 2 * thickness]);
  if (openEnd !== 1) segments.push([cx + halfL, cz, thickness, width - 2 * thickness]);
  for (const [x, z, l, w] of segments) {
    const geo = new THREE.PlaneGeometry(l * MM, w * MM);
    const mesh = new THREE.Mesh(geo, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x * MM, y, z * MM);
    parent.add(mesh);
  }
}

/**
 * A goal, and the walls rule 2.3.6 carries back from it.
 *
 * The goal is a low black box - 160 mm to the top of the crossbar, nowhere
 * near the 220 mm of the perimeter walls - whose 450 x 140 mouth sits on the
 * goal line, painted inside in the goal's colour so the opening is what a
 * camera picks out. Its side walls do not stop at the back of the goal: rule
 * 2.3.6 runs them on to the end wall, closing off the out area behind it.
 *
 * Every panel is drawn outside the planes `pushOutOfGoalBlock` bounces off, so
 * a robot shoving against a wall stops exactly where the wall is drawn.
 */
function buildGoal(parent: THREE.Object3D, sign: -1 | 1, colour: number): void {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85 });
  const black = new THREE.MeshStandardMaterial({ color: COLOURS.wall, roughness: 0.9 });

  const mouthX = GOAL_MOUTH_X * MM;
  const backX = GOAL_BACK_X * MM;
  const t = GOAL_WALL_THICKNESS * MM;
  const half = (GOAL_WIDTH / 2) * MM;
  const depth = backX - mouthX;
  const opening = CROSSBAR_HEIGHT * MM;
  const bar = CROSSBAR_DEPTH * MM;
  const height = opening + bar;
  const midX = sign * (mouthX + backX) / 2;
  // A whisker, to keep the painted liners off the black they are painted on.
  const skin = 0.0015;

  const box = (
    l: number,
    h: number,
    w: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
  ): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(l, h, w), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  // Side walls, from the goal line all the way to the end wall (rule 2.3.6).
  const run = WALL_X * MM - mouthX;
  for (const zSign of [-1, 1] as const) {
    box(run, height, t, sign * (mouthX + run / 2), height / 2, zSign * (half + t / 2), black);
  }

  // Back wall of the goal - the surface rule 5.5.1 hangs a goal on.
  box(t, height, half * 2 + 2 * t, sign * (backX + t / 2), height / 2, 0, black);

  // Crossbar across the mouth, 140 mm up and 20 mm deep (rule 2.3.3), sitting
  // inside the mouth rather than overhanging the playing area. Painted: it is
  // the top edge of the coloured opening, not part of the black shell.
  box(bar, bar, half * 2, sign * (mouthX + bar / 2), opening + bar / 2, 0, paint);

  /*
   * Painted inside: the back and the two cheeks, and nothing else. The floor
   * of a goal is not painted - it is the carpet and the white line, which run
   * straight under the goal - so laying colour across it put the goal's paint
   * over the line the goal is standing on.
   */
  box(skin, opening, half * 2, sign * (backX - skin / 2), opening / 2, 0, paint);
  for (const zSign of [-1, 1] as const) {
    box(depth, opening, skin, midX, opening / 2, zSign * (half - skin / 2), paint);
  }

  parent.add(group);
}

export class FieldRenderer {
  readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly robotMeshes = new Map<string, THREE.Group>();
  private readonly commsLines = new Map<'violet' | 'lime', THREE.Line>();
  private ballMesh!: THREE.Mesh;
  /** Set only when a deployment supplies its own robot model. */
  private robotTemplate: THREE.Group | null = null;
  private readonly canvas: HTMLCanvasElement;
  private league: League;
  cameraMode: CameraMode = 'referee';
  private readonly follow = new FollowCamera({ halfX: HALF_OUTER_X, halfZ: HALF_OUTER_Z });
  orbitAngle = 0;
  /** Rule 4.2.5: whether to visually render the 3D communication lines between robots (default false). */
  showCommsLines = false;
  private lastCameraMode: CameraMode | null = null;

  constructor(canvas: HTMLCanvasElement, league: League) {
    this.canvas = canvas;
    this.league = league;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(0x0d1117);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 60);
    this.scene.fog = new THREE.Fog(0x0d1117, 6, 18);

    this.buildStaticScene();
    this.buildBall();

    for (const team of ['violet', 'lime'] as const) {
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.08, 0),
        new THREE.Vector3(0, 0.08, 0),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color: TEAM_COLOUR[team],
        transparent: true,
        opacity: 0.45,
      });
      const line = new THREE.Line(geom, mat);
      line.visible = false;
      this.commsLines.set(team, line);
      this.scene.add(line);
    }
  }

  setLeague(league: League): void {
    this.league = league;
    this.buildBall();
    this.clearRobots();
  }

  private clearRobots(): void {
    for (const [, mesh] of this.robotMeshes) this.scene.remove(mesh);
    this.robotMeshes.clear();
  }

  /**
   * Swap the generated robot for a real model. Nothing ships with the app -
   * see loadRobotModel - so this is only called when a deployment has added a
   * model it is entitled to redistribute.
   */
  async useRobotModel(url: string): Promise<void> {
    try {
      this.robotTemplate = await loadRobotModel(url);
      this.clearRobots();
    } catch (error) {
      // A missing or broken model must not take the field down with it; the
      // generated robot is always a working fallback.
      console.warn(`Robot model ${url} could not be loaded; using the generated robot.`, error);
    }
  }

  private buildStaticScene(): void {
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(1.6, 3.4, 1.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -1.6;
    key.shadow.camera.right = 1.6;
    key.shadow.camera.top = 1.6;
    key.shadow.camera.bottom = -1.6;
    this.scene.add(key);

    // Carpet covering the whole field including the out area (rule 2.1.3).
    const carpet = new THREE.Mesh(
      new THREE.PlaneGeometry(OUTER_LENGTH * MM, OUTER_WIDTH * MM),
      new THREE.MeshStandardMaterial({ color: COLOURS.carpet, roughness: 1 }),
    );
    carpet.rotation.x = -Math.PI / 2;
    carpet.receiveShadow = true;
    this.scene.add(carpet);

    // The white out-area boundary: 50 mm thick, its outer edge 250 mm in from
    // the walls, its inner edge the edge of the playing area.
    stripe(
      this.scene,
      0,
      0,
      OUTER_LENGTH - 2 * OUT_BAND,
      OUTER_WIDTH - 2 * OUT_BAND,
      LINE_THICKNESS,
      COLOURS.line,
      0.0015,
    );

    /*
     * Penalty boxes, 25 mm black marking (rule 2.1.1): 300 mm deep, 900 mm
     * wide, and open at the goal line. The field diagram draws three sides
     * only - the white line is already the fourth, and a black line along it
     * would be marking the same edge twice. The marking lies INSIDE the
     * 300 x 900, so the two long sides run up to the white line and stop.
     */
    for (const sign of [-1, 1] as const) {
      stripe(
        this.scene,
        sign * (HALF_LENGTH - PENALTY_DEPTH / 2),
        0,
        PENALTY_DEPTH,
        PENALTY_WIDTH,
        MARKING_THICKNESS,
        COLOURS.marking,
        0.002,
        sign,
      );
    }

    // Neutral points (rule 2.4).
    for (const p of NEUTRAL_POINTS) {
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(MARKING_THICKNESS * MM, 20),
        new THREE.MeshBasicMaterial({ color: COLOURS.marking }),
      );
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(p.x * MM, 0.0025, p.z * MM);
      this.scene.add(dot);
    }

    // Perimeter walls. Height is league-dependent (rule 2.2), but the
    // simulator draws the nationals height so the enclosure reads clearly.
    // 2430 x 1820 is the size of the field, so WALL_X and WALL_Z are the INNER
    // faces - the planes bodies bounce off - and the panels stand outside them.
    const wallHeight = WALL_HEIGHT_NATIONALS * MM;
    const t = GOAL_WALL_THICKNESS * MM;
    const wallMat = new THREE.MeshStandardMaterial({ color: COLOURS.wall, roughness: 0.9 });
    const outerL = OUTER_LENGTH * MM + 2 * t;
    const spans: [number, number, number, number][] = [
      [0, -(WALL_Z * MM + t / 2), outerL, t],
      [0, WALL_Z * MM + t / 2, outerL, t],
      [-(WALL_X * MM + t / 2), 0, t, OUTER_WIDTH * MM],
      [WALL_X * MM + t / 2, 0, t, OUTER_WIDTH * MM],
    ];
    for (const [x, z, l, w] of spans) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(l, wallHeight, w), wallMat);
      wall.position.set(x, wallHeight / 2, z);
      this.scene.add(wall);
    }

    buildGoal(this.scene, -1, COLOURS.cyan);
    buildGoal(this.scene, 1, COLOURS.yellow);
  }

  private buildBall(): void {
    if (this.ballMesh) this.scene.remove(this.ballMesh);
    const radius = (ballDiameter(this.league) / 2) * MM;
    const isIr = this.league.ball === 'ir-74';
    this.ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 24, 18),
      new THREE.MeshStandardMaterial({
        color: isIr ? COLOURS.ballIr : COLOURS.ballOpen,
        roughness: isIr ? 0.75 : 0.45,
        emissive: isIr ? 0x330000 : 0x000000,
      }),
    );
    this.ballMesh.castShadow = true;
    this.scene.add(this.ballMesh);
  }

  private syncRobots(world: RenderView): void {
    for (const robot of world.robots) {
      let mesh = this.robotMeshes.get(robot.id);
      if (!mesh) {
        mesh = this.robotTemplate
          ? (this.robotTemplate.clone(true) as THREE.Group)
          : buildRobotMesh(robot, this.league);
        this.robotMeshes.set(robot.id, mesh);
        this.scene.add(mesh);
      }
      mesh.visible = !robot.removed;
      mesh.position.set(robot.x * MM, 0, robot.z * MM);
      mesh.rotation.y = -robot.heading;
    }

    for (const team of ['violet', 'lime'] as const) {
      const line = this.commsLines.get(team);
      if (!line) continue;
      const activeTeammates = world.robots.filter((r) => r.team === team && !r.removed);
      const recent = world.clock - world.commsActivity[team];
      if (this.showCommsLines && world.commsEnabled && activeTeammates.length >= 2 && recent < 0.35) {
        const r1 = activeTeammates[0]!;
        const r2 = activeTeammates[1]!;
        const positions = line.geometry.attributes.position as THREE.BufferAttribute;
        positions.setXYZ(0, r1.x * MM, 0.08, r1.z * MM);
        positions.setXYZ(1, r2.x * MM, 0.08, r2.z * MM);
        positions.needsUpdate = true;
        (line.material as THREE.LineBasicMaterial).opacity = Math.max(0.15, (0.35 - recent) * 1.5);
        line.visible = true;
      } else {
        line.visible = false;
      }
    }
  }

  private updateCamera(world: RenderView, dt: number): void {
    const target = new THREE.Vector3(0, 0, 0);
    const pos = new THREE.Vector3();
    const safeDt = Math.max(0.001, Math.min(dt, 0.1));

    switch (this.cameraMode) {
      case 'referee': {
        // Straight overhead with the long axis across the screen, framed to
        // fit whatever pane it has been given. Half the point of the
        // demonstrator is being able to see the whole field at once, and a
        // fixed height crops it in a narrow pane.
        this.camera.up.set(0, 0, -1);
        const vHalf = Math.tan((this.camera.fov * Math.PI) / 360);
        const forWidth = HALF_OUTER_Z / vHalf;
        const forLength = HALF_OUTER_X / (vHalf * this.camera.aspect);
        pos.set(0, Math.max(forWidth, forLength) * 1.06, 0);
        break;
      }
      case 'broadcast': {
        /*
         * Raised and back, the angle a camera on a gantry would have - but
         * framed to fit rather than parked at a fixed distance.
         *
         * The lab pins this at (0, 1.5, 2.2), which suits the pane it sits in
         * there. On a hall screen it left the field filling about half the
         * frame with dead space all round, which is a waste of the one thing a
         * tournament screen has going for it. Referee mode already frames to
         * the aspect it is given; this now does the same.
         */
        this.camera.up.set(0, 1, 0);
        const vHalf = Math.tan((this.camera.fov * Math.PI) / 360);
        const dir = new THREE.Vector3(0, 1.5, 2.2).normalize();
        // Tilted down by this much, the field's depth is foreshortened into
        // the vertical, while its length stays across the screen.
        const tilt = Math.asin(dir.y);
        const forLength = HALF_OUTER_X / (vHalf * this.camera.aspect);
        const forDepth = (HALF_OUTER_Z * Math.sin(tilt) + ROBOT_HEADROOM) / vHalf;
        pos.copy(dir).multiplyScalar(Math.max(forLength, forDepth) * FRAME_MARGIN);
        break;
      }
      case 'follow': {
        this.camera.up.set(0, 1, 0);
        // Switching to follow starts a fresh shot on the ball.
        if (this.lastCameraMode !== 'follow') this.follow.reset();
        const shot = this.follow.update(
          { x: world.ball.x * MM, z: world.ball.z * MM, absent: world.ball.absent },
          // The resting height, not the ball's: a bounce should not nod the shot.
          (world.ball.radius ?? 21) * MM,
          dt,
        );
        pos.set(shot.position.x, shot.position.y, shot.position.z);
        target.set(shot.target.x, shot.target.y, shot.target.z);
        break;
      }
      case 'orbit': {
        this.camera.up.set(0, 1, 0);
        this.orbitAngle += safeDt * 0.1;
        const r = 2.4;
        pos.set(Math.cos(this.orbitAngle) * r, 1.5, Math.sin(this.orbitAngle) * r);
        break;
      }
    }

    if (this.lastCameraMode !== this.cameraMode) {
      this.lastCameraMode = this.cameraMode;
      this.camera.position.copy(pos);
    } else if (this.cameraMode === 'follow') {
      // The follow camera does its own smoothing, and its position is a fixed
      // function of where it looks. Easing it again here would let the two
      // drift apart and wobble.
      this.camera.position.copy(pos);
    } else {
      const posSmoothing = 1 - Math.exp(-8 * safeDt);
      this.camera.position.lerp(pos, posSmoothing);
    }
    this.camera.lookAt(target);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    /*
     * A hidden tab reports zero, and clamping that to 1x1 leaves the camera
     * with an aspect of 1 and a one-pixel buffer that survives until the next
     * resize. Backgrounding a screen in a hall should cost nothing, so keep
     * the last good size instead of collapsing to it.
     */
    if (rect.width < 1 || rect.height < 1) return;
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render(world: RenderView, dt: number): void {
    this.syncRobots(world);
    this.ballMesh.visible = !world.ball.absent;
    this.ballMesh.position.set(world.ball.x * MM, world.ball.radius * MM, world.ball.z * MM);
    this.updateCamera(world, dt);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Where on the carpet a point on the canvas is, in field millimetres.
   *
   * The practice console needs this and nothing else from the camera: a drag
   * is a screen point, the thing being dragged lives in millimetres, and only
   * the renderer knows how the one becomes the other. Exposing a `pick`
   * rather than the camera keeps it that way - a console that could reach the
   * camera would end up moving it.
   *
   * Returns null for a point that misses the carpet plane entirely, which
   * from the referee's overhead angle is only ever the sky above the far
   * wall.
   */
  pick(clientX: number, clientY: number): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    // The carpet, not the scene: dropping a robot has to land where the
    // pointer is on the ground, not on top of whatever mesh is under it.
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    return { x: hit.x / MM, z: hit.z / MM };
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
