/// <reference types="vite/client" />
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
const standdown = document.getElementById('standdown')!;
const cameras = document.getElementById('cameras')!;

const board = {
  element: document.getElementById('board')!,
  violetName: document.getElementById('violet-name')!,
  limeName: document.getElementById('lime-name')!,
  violetScore: document.getElementById('violet-score')!,
  limeScore: document.getElementById('lime-score')!,
  clock: document.getElementById('clock')!,
  half: document.getElementById('half')!,
};

const kickoffCountdown = document.getElementById('kickoff-countdown')!;
const kickoffNumber = kickoffCountdown.querySelector('.ko-num')!;
const kickoffTeam = kickoffCountdown.querySelector('.ko-team')!;
/** The countdown value a restart began from, so the draining ring can sit full at 3. */
let countdownRingStart = 3;
let countdownFadeTimer: number | undefined;

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

/**
 * Robots off the field under rule 5.7, and how long they have left.
 *
 * Rebuilt from scratch each frame rather than diffed. There are at most four
 * robots and this runs 60 times a second on a machine doing nothing else; the
 * bookkeeping to update it in place would cost more to read than it saves.
 */
function updateStandDown(frame: ViewFrame): void {
  const out = frame.robots.filter((r) => r.removed);
  if (out.length === 0) {
    standdown.hidden = true;
    standdown.replaceChildren();
    return;
  }

  standdown.hidden = false;
  const cards = out.map((robot) => {
    /*
     * Tolerate a frame without the field.
     *
     * A viewer and a server can be different builds - the page is cached, or
     * the server has been running since before the last deploy - and the first
     * version of this printed "NaNs" onto a hall screen when that happened.
     * A dash says the same thing honestly.
     */
    const seconds = robot.penaltyRemaining;
    const known = Number.isFinite(seconds);
    const left = known ? Math.ceil(seconds) : 0;
    const ready = known && left <= 0;

    const card = document.createElement('div');
    card.className = `sd-card ${robot.team}`;

    const who = document.createElement('span');
    who.className = 'who';
    // 'violet-2' reads as nothing from twenty metres away; 'Violet 2' reads.
    const number = robot.id.split('-')[1] ?? '';
    who.textContent = `${frame.teams[robot.team]} ${number}`;

    const rule = document.createElement('span');
    rule.className = 'rule';
    rule.textContent = `§${robot.removalRule ?? '5.7'}`;
    if (robot.removalReason) card.title = robot.removalReason;

    const timer = document.createElement('span');
    timer.className = ready ? 'timer ready' : 'timer';
    // Serving the time does not put a robot back on: 5.7.4 wants the referee
    // to agree it has been repaired, so this says ready rather than counting
    // on past zero as though it had already returned.
    timer.textContent = !known ? '—' : ready ? 'Ready' : `${left}s`;

    card.append(who, rule, timer);
    return card;
  });
  standdown.replaceChildren(...cards);
}

/**
 * A kick-off that has been placed but not whistled live.
 *
 * The countdown value arrives in match time, so frames (30 Hz from a 100 Hz
 * world) tick past fractions of a second. The number shows whole seconds; the
 * ring drains against where this restart began, so it reads "full" the
 * instant the kick-off is placed and "empty" at the whistle.
 */
function updateKickoff(frame: ViewFrame): void {
  const countdown = frame.kickoff.countdown;
  if (countdown > 0) {
    if (countdownFadeTimer !== undefined) {
      clearTimeout(countdownFadeTimer);
      countdownFadeTimer = undefined;
    }
    const appearing = kickoffCountdown.hidden;
    kickoffCountdown.hidden = false;
    kickoffCountdown.classList.remove('fade');
    if (appearing) countdownRingStart = countdown;
    kickoffNumber.textContent = String(Math.ceil(countdown));
    const team = frame.kickoff.team;
    if (team === 'violet' || team === 'lime') {
      kickoffCountdown.dataset['team'] = team;
      kickoffTeam.textContent = frame.teams[team];
    } else {
      delete kickoffCountdown.dataset['team'];
      kickoffTeam.textContent = '';
    }
    const start = countdownRingStart > 0 ? countdownRingStart : 1;
    kickoffCountdown.style.setProperty('--p', String(Math.max(0, Math.min(1, countdown / start))));
  } else if (!kickoffCountdown.hidden) {
    kickoffCountdown.classList.add('fade');
    countdownFadeTimer = window.setTimeout(() => {
      kickoffCountdown.hidden = true;
      kickoffCountdown.classList.remove('fade');
      countdownFadeTimer = undefined;
    }, 150);
  }
}

function updateBoard(frame: ViewFrame): void {
  // Teams swap ends at half time, so the panels flip to keep each name over
  // the goal the team is defending - the .violet/.lime order in the CSS.
  board.element.classList.toggle('ends-swapped', frame.half === 2);
  board.violetName.textContent = frame.teams.violet;
  board.limeName.textContent = frame.teams.lime;
  board.violetScore.textContent = String(frame.score.violet);
  board.limeScore.textContent = String(frame.score.lime);
  board.clock.textContent = formatClock(frame.clock, frame.half);
  board.half.textContent = frame.running
    ? frame.half === 1
      ? '1st half'
      : '2nd half'
    : frame.clock === 0
      ? 'pre-match'
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
  updateStandDown(latest);
  updateKickoff(latest);
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
      buildCameraPicker();
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
 * The camera picker.
 *
 * Each of these earns its place on the night. Broadcast is the one to leave it
 * on. Referee is straight overhead and settles an argument about where a robot
 * actually was. Follow tracks the ball, which is what a small screen wants.
 * Orbit is for the hall while it fills up.
 *
 * Buttons as well as a key, because a key nobody knows about is not a feature,
 * and because the machine driving the projector is as likely to be poked at as
 * typed on.
 */
const CAMERAS = [
  { mode: 'broadcast', label: 'Broadcast' },
  { mode: 'referee', label: 'Overhead' },
  { mode: 'follow', label: 'Follow ball' },
  { mode: 'orbit', label: 'Orbit' },
] as const;

let cameraIndex = 0;
const cameraButtons: HTMLButtonElement[] = [];

function setCamera(index: number): void {
  cameraIndex = (index + CAMERAS.length) % CAMERAS.length;
  const choice = CAMERAS[cameraIndex]!;
  if (renderer) renderer.cameraMode = choice.mode;
  cameraButtons.forEach((button, i) => {
    button.setAttribute('aria-pressed', String(i === cameraIndex));
  });
}

function buildCameraPicker(): void {
  for (const [i, choice] of CAMERAS.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = choice.label;
    button.title = `${choice.label} view (press C to cycle)`;
    button.setAttribute('aria-pressed', String(i === cameraIndex));
    button.addEventListener('click', () => setCamera(i));
    cameraButtons.push(button);
    cameras.append(button);
  }
}

function cycleCamera(event: KeyboardEvent): void {
  if (event.key !== 'c' && event.key !== 'C') return;
  setCamera(cameraIndex + 1);
}

/**
 * Which match server to watch.
 *
 * Built and served BY the match server, that is wherever the page came from,
 * and there is nothing to configure. Run from the Vite dev server it is not:
 * the page comes from Vite's own port, which serves the client and knows
 * nothing about any match — so the default there is the match server's own
 * default port, and `?server=host:port` overrides both for a screen watching a
 * machine other than the one it is plugged into.
 *
 * Getting this wrong used to produce a black screen and nothing else. Vite
 * accepts the TCP connection and then never completes the upgrade, so the
 * socket sits in CONNECTING rather than failing, and neither `open` nor
 * `close` ever fires: no status change, no retry, no error in the console, and
 * a field that is never drawn because the renderer is built on the first
 * frame. See the timeout below.
 */
const DEFAULT_SERVER_PORT = 8080;

function serverAddress(): string {
  const asked = new URLSearchParams(location.search).get('server');
  if (asked) return asked;
  if (import.meta.env.DEV) return `${location.hostname}:${DEFAULT_SERVER_PORT}`;
  return location.host;
}

/**
 * The path this page was served under.
 *
 * On a match server that is `/` and nothing changes. On a league server the
 * viewer is mounted at `/live/` and reached through a proxy, so the socket has
 * to be opened under the same prefix or it arrives at the front door instead
 * of at the world. The practice console has derived its prefix this way since
 * Phase 4, for the same reason and with the same three lines.
 */
function basePath(): string {
  const path = location.pathname;
  return path.endsWith('/') ? path : path.replace(/[^/]*$/, '');
}

/** How long to let a socket sit in CONNECTING before calling it a failure. */
const CONNECT_TIMEOUT = 4000;

function connect(): void {
  const host = serverAddress();
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}${basePath()}`;
  const socket = new WebSocket(url);
  let everLive = false;

  // A socket that never opens and never closes is the worst of both worlds: it
  // is indistinguishable from a slow connection, forever. Give it a deadline,
  // and let the close handler below do the reporting either way.
  const deadline = setTimeout(() => socket.close(), CONNECT_TIMEOUT);

  socket.addEventListener('open', () => {
    everLive = true;
    clearTimeout(deadline);
    status.textContent = 'live';
  });
  socket.addEventListener('message', (event) => {
    receive(JSON.parse(String(event.data)) as ViewMessage);
  });
  socket.addEventListener('close', () => {
    clearTimeout(deadline);
    /*
     * Two different failures, and telling them apart is the whole value of the
     * line. A socket that was live and dropped is venue wifi, and the screen
     * should say so and quietly come back — nobody is going to be watching it
     * to press refresh. A socket that never opened at all is pointed at the
     * wrong place, and the one thing worth printing is where it was pointed.
     */
    status.textContent = everLive ? 'reconnecting…' : `no match server at ${host}`;
    setTimeout(connect, everLive ? 1000 : 2000);
  });
  socket.addEventListener('error', () => socket.close());
}

connect();
draw();
