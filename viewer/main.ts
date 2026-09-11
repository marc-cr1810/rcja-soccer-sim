/**
 * The spectator client.
 *
 * Connects to the match server, draws what it is sent with the same renderer
 * Soccer Lab uses, and keeps a scoreboard on top of it.
 *
 * It holds no world and runs no physics. Everything it knows arrived over the
 * socket, which is the point: a screen in a hall must not be able to disagree
 * with the match, and the only way to guarantee that is for it to have no
 * opinion of its own.
 */

import { FieldRenderer } from '../src/renderer';
import type { League } from '../src/leagues';
import type { ViewFrame, ViewMessage } from '../src/view';

const canvas = document.getElementById('field') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const call = document.getElementById('call')!;

const board = {
  cyanName: document.getElementById('cyan-name')!,
  yellowName: document.getElementById('yellow-name')!,
  cyanScore: document.getElementById('cyan-score')!,
  yellowScore: document.getElementById('yellow-score')!,
  clock: document.getElementById('clock')!,
  half: document.getElementById('half')!,
};

let renderer: FieldRenderer | null = null;
let league: League | null = null;
let halfSeconds = 300;

/**
 * The most recent frame, and the one before it.
 *
 * Frames arrive 30 times a second and the screen draws 60, so drawing the
 * latest frame twice makes the robots stutter. Interpolating between the last
 * two costs one frame of latency, which nobody watching can perceive, and is
 * the difference between looking like a match and looking like a slideshow.
 */
let previous: ViewFrame | null = null;
let latest: ViewFrame | null = null;
let previousAt = 0;
let latestAt = 0;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest way round the circle, so a robot crossing pi does not spin back. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function blend(from: ViewFrame, to: ViewFrame, t: number): ViewFrame {
  const byId = new Map(from.robots.map((r) => [r.id, r]));
  return {
    ...to,
    ball: {
      ...to.ball,
      x: lerp(from.ball.x, to.ball.x, t),
      z: lerp(from.ball.z, to.ball.z, t),
      y: to.ball.y === undefined ? undefined : lerp(from.ball.y ?? 0, to.ball.y, t),
    },
    robots: to.robots.map((r) => {
      const was = byId.get(r.id);
      if (!was) return r;
      return {
        ...r,
        x: lerp(was.x, r.x, t),
        z: lerp(was.z, r.z, t),
        heading: lerpAngle(was.heading, r.heading, t),
      };
    }),
  };
}

function formatClock(seconds: number, half: number): string {
  // Count up within the half, the way a scoreboard in a hall does.
  const into = Math.max(0, seconds - (half - 1) * halfSeconds);
  const m = Math.floor(into / 60);
  const s = Math.floor(into % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateBoard(frame: ViewFrame): void {
  board.cyanName.textContent = frame.teams.cyan;
  board.yellowName.textContent = frame.teams.yellow;
  board.cyanScore.textContent = String(frame.score.cyan);
  board.yellowScore.textContent = String(frame.score.yellow);
  board.clock.textContent = formatClock(frame.clock, frame.half);
  board.half.textContent = frame.running
    ? frame.half === 1
      ? '1st half'
      : '2nd half'
    : 'stopped';

  const last = frame.events[frame.events.length - 1];
  if (last) {
    call.hidden = false;
    if (last.team) call.dataset['team'] = last.team;
    else delete call.dataset['team'];
    call.innerHTML = '';
    const rule = document.createElement('span');
    rule.className = 'rule';
    rule.textContent = `Rule ${last.rule}`;
    const text = document.createElement('span');
    text.textContent = last.message;
    call.append(rule, text);
  } else {
    call.hidden = true;
  }
}

function draw(): void {
  requestAnimationFrame(draw);
  if (!renderer || !latest) return;

  let frame = latest;
  if (previous && latestAt > previousAt) {
    const span = latestAt - previousAt;
    // Clamped, so a stalled connection freezes the picture rather than
    // extrapolating robots off the field.
    const t = Math.min(1, (performance.now() - latestAt) / span);
    frame = blend(previous, latest, t);
  }
  renderer.render(frame, 1 / 60);
  updateBoard(latest);
}

function receive(message: ViewMessage): void {
  if (message.type === 'hello') {
    league = message.league;
    halfSeconds = message.halfSeconds;
    if (!renderer) {
      renderer = new FieldRenderer(canvas, league);
      // A hall screen wants the broadcast angle, not the referee's overhead
      // one - the overhead view is for judging a position, and this is for
      // watching a game. Comms lines on, because 4.2.5 traffic between two
      // robots is otherwise completely invisible and it is worth seeing.
      renderer.cameraMode = 'broadcast';
      renderer.showCommsLines = true;

      /*
       * Size the drawing buffer before the first frame.
       *
       * A WebGL canvas defaults to 300x150 regardless of what CSS stretches it
       * to, so without this the whole match was rendered at postage-stamp size
       * and scaled up across the screen. The renderer's own resize() already
       * handles device pixel ratio properly; it just has to be called.
       *
       * A ResizeObserver rather than the window event, because a screen in a
       * hall gets resized by things other than the window - going fullscreen,
       * a projector renegotiating, a browser chrome bar appearing.
       */
      renderer.resize();
      new ResizeObserver(() => renderer?.resize()).observe(canvas);
      window.addEventListener('keydown', cycleCamera);
    } else {
      renderer.setLeague(league);
    }
    return;
  }
  previous = latest;
  previousAt = latestAt;
  latest = message.frame;
  latestAt = performance.now();
}

/**
 * Press C to change the view.
 *
 * Worth having on the night: an overhead shot settles an argument about where a
 * robot was, and following the ball is better on a small screen than on a big
 * one. Nobody has to remember it, and the default is the right one.
 */
const CAMERAS = ['broadcast', 'referee', 'follow', 'orbit'] as const;
let cameraIndex = 0;

function cycleCamera(event: KeyboardEvent): void {
  if (event.key !== 'c' && event.key !== 'C') return;
  cameraIndex = (cameraIndex + 1) % CAMERAS.length;
  const mode = CAMERAS[cameraIndex]!;
  if (renderer) renderer.cameraMode = mode;
  status.textContent = mode;
  setTimeout(() => {
    if (status.textContent === mode) status.textContent = 'live';
  }, 1500);
}

function connect(): void {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  const socket = new WebSocket(url);

  socket.addEventListener('open', () => {
    status.textContent = 'live';
  });
  socket.addEventListener('message', (event) => {
    receive(JSON.parse(String(event.data)) as ViewMessage);
  });
  socket.addEventListener('close', () => {
    status.textContent = 'reconnecting…';
    // Venue wifi drops. A screen in a hall has to come back on its own,
    // because nobody is going to be watching it to press refresh.
    setTimeout(connect, 1000);
  });
  socket.addEventListener('error', () => socket.close());
}

connect();
draw();
