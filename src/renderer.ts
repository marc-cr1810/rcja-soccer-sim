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
  GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  LINE_THICKNESS,
  MARKING_THICKNESS,
  NEUTRAL_POINTS,
  OUTER_LENGTH,
  OUTER_WIDTH,
  PENALTY_DEPTH,
  PENALTY_WIDTH,
  WALL_X,
  WALL_Z,
} from './field';
import type { League } from './leagues';
import { ballDiameter } from './leagues';
import type { RenderView } from './view';
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

/** Rounded-rectangle outline drawn flat on the carpet. */
function stripe(
  parent: THREE.Object3D,
  cx: number,
  cz: number,
  length: number,
  width: number,
  thickness: number,
  colour: number,
  y: number,
): void {
  const material = new THREE.MeshBasicMaterial({ color: colour });
  const halfL = length / 2;
  const halfW = width / 2;
  const segments: [number, number, number, number][] = [
    [cx, cz - halfW, length, thickness],
    [cx, cz + halfW, length, thickness],
    [cx - halfL, cz, thickness, width + thickness],
    [cx + halfL, cz, thickness, width + thickness],
  ];
  for (const [x, z, l, w] of segments) {
    const geo = new THREE.PlaneGeometry(l * MM, w * MM);
    const mesh = new THREE.Mesh(geo, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x * MM, y, z * MM);
    parent.add(mesh);
  }
}

function buildGoal(parent: THREE.Object3D, sign: -1 | 1, colour: number): void {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85 });
  const depth = (GOAL_BACK_X - GOAL_MOUTH_X) * MM;
  const width = GOAL_WIDTH * MM;
  const height = CROSSBAR_HEIGHT * MM;

  // Back wall of the goal - the surface rule 5.5.1 hangs on.
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.02, height, width), mat);
  back.position.set(sign * GOAL_BACK_X * MM, height / 2, 0);
  group.add(back);

  // Side walls, which rule 2.3.6 extends to the end wall.
  for (const zSign of [-1, 1] as const) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(depth, height, 0.02), mat);
    side.position.set(sign * (GOAL_MOUTH_X + GOAL_BACK_X) * 0.5 * MM, height / 2, zSign * width / 2);
    group.add(side);
  }

  // Crossbar, 140 mm up and at most 20 mm deep (rule 2.3.3).
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(CROSSBAR_DEPTH * MM, CROSSBAR_DEPTH * MM, width),
    mat,
  );
  bar.position.set(sign * GOAL_MOUTH_X * MM, height, 0);
  group.add(bar);

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
  /** Where the follow camera is currently looking, eased toward the ball. */
  private readonly followLook = new THREE.Vector3();
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

    // The white out-area boundary: 50 mm thick, 250 mm in from the walls.
    stripe(
      this.scene,
      0,
      0,
      HALF_LENGTH * 2 + LINE_THICKNESS,
      HALF_WIDTH * 2 + LINE_THICKNESS,
      LINE_THICKNESS,
      COLOURS.line,
      0.0015,
    );

    // Penalty boxes, 25 mm black marking (rule 2.1.1).
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
    const wallHeight = 0.22;
    const wallMat = new THREE.MeshStandardMaterial({ color: COLOURS.wall, roughness: 0.9 });
    const spans: [number, number, number, number][] = [
      [0, -WALL_Z * MM, OUTER_LENGTH * MM, 0.02],
      [0, WALL_Z * MM, OUTER_LENGTH * MM, 0.02],
      [-WALL_X * MM, 0, 0.02, OUTER_WIDTH * MM],
      [WALL_X * MM, 0, 0.02, OUTER_WIDTH * MM],
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
        const ball = new THREE.Vector3(world.ball.x * MM, 0, world.ball.z * MM);
        // Snap the view point on entry; ease it every frame after, so the
        // camera does not whip around whenever the ball changes course.
        if (this.lastCameraMode !== 'follow') this.followLook.copy(ball);
        else this.followLook.lerp(ball, 0.05);
        target.copy(this.followLook);
        pos.set(this.followLook.x - 0.9, 1.0, this.followLook.z + 1.1);
        break;
      }
      case 'orbit': {
        this.camera.up.set(0, 1, 0);
        this.orbitAngle += dt * 0.1;
        const r = 2.4;
        pos.set(Math.cos(this.orbitAngle) * r, 1.5, Math.sin(this.orbitAngle) * r);
        break;
      }
    }

    if (this.lastCameraMode !== this.cameraMode) {
      this.lastCameraMode = this.cameraMode;
      this.camera.position.copy(pos);
    } else {
      this.camera.position.lerp(pos, this.cameraMode === 'follow' ? 0.05 : 0.08);
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
    this.ballMesh.position.set(
      world.ball.x * MM,
      (world.ball.y ?? world.ball.radius) * MM,
      world.ball.z * MM,
    );
    this.updateCamera(world, dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
