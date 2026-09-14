/// <reference types="vite/client" />
/**
 * The practice console.
 *
 * A third client, on the same pattern as the referee's: its own HTML entry,
 * its own Vite build (`vite.practice.config.ts`, output to `dist-practice/`),
 * and no import of anything under `viewer/` or `referee/`. It watches the
 * field over the same unauthenticated socket every spectator uses, and acts
 * through `POST /practice-api/*` — which exists only on a server that is a
 * practice field, and asks for no credential, because a practice field is
 * open to whoever has the link until Phase 6 builds accounts.
 *
 * The one genuinely new thing here is dragging. Everything else a team can do
 * to a field — start it, stop it, put the situation back, swap what is
 * driving a robot — is a button; but where a robot and the ball start is the
 * whole question a rehearsal asks, and typing millimetres is not how anybody
 * asks it.
 */

import { FieldRenderer } from '../src/renderer';
import type { League } from '../src/leagues';
import type { ViewFrame, ViewMessage } from '../src/view';

type SeatId = 'violet-1' | 'violet-2' | 'lime-1' | 'lime-2';
const SEATS: SeatId[] = ['violet-1', 'violet-2', 'lime-1', 'lime-2'];

type SeatFill =
  | { kind: 'empty' }
  | { kind: 'built-in' }
  | { kind: 'laptop' }
  | { kind: 'submission'; team: string };

interface SeatState {
  fill: SeatFill;
  onField: boolean;
  removed: boolean;
  filled: boolean;
  connected: boolean;
  detail?: string;
}

interface PracticeState {
  running: boolean;
  resolve: 'restage' | 'play-on' | 'freeze';
  clock: number;
  score: { violet: number; lime: number };
  arrangement: { robots: { id: string; x: number; z: number }[]; ball: { x: number; z: number } };
  seats: Record<string, SeatState>;
}

/**
 * Everything this page talks to is relative to where the page itself came
 * from.
 *
 * A field on its own port is served at `/practice/`; the same field through a
 * venue server is at `/f/<id>/practice/`, and its API and its viewer socket
 * are under that prefix too. Deriving the prefix from `location` is what lets
 * one built bundle be right in both places.
 */
const BASE = location.pathname.replace(/practice\/?$/, '');

const canvas = document.getElementById('field') as HTMLCanvasElement;
const call = document.getElementById('call')!;
const log = document.getElementById('log')!;
const seatsPanel = document.getElementById('seats')!;
const modes = document.getElementById('modes')!;

const board = {
  violetName: document.getElementById('violet-name')!,
  limeName: document.getElementById('lime-name')!,
  violetScore: document.getElementById('violet-score')!,
  limeScore: document.getElementById('lime-score')!,
  clock: document.getElementById('clock')!,
  mode: document.getElementById('mode')!,
};

let renderer: FieldRenderer | null = null;
let league: League | null = null;
let state: PracticeState | null = null;

/** Same interpolation as the viewer and the referee console. See their note. */
let previous: ViewFrame | null = null;
let latest: ViewFrame | null = null;
let previousAt = 0;
let latestAt = 0;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

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
      return { ...r, x: lerp(was.x, r.x, t), z: lerp(was.z, r.z, t), heading: lerpAngle(was.heading, r.heading, t) };
    }),
  };
}

function logLine(text: string): void {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  log.prepend(line);
  while (log.childNodes.length > 20) log.lastChild?.remove();
}

/** Call a practice action, and take the state it answers with. */
async function act(action: string, body?: unknown, quiet = false): Promise<void> {
  try {
    const res = await fetch(`${BASE}practice-api/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; state?: PracticeState };
    if (!res.ok || !payload.ok) {
      logLine(`${action} refused: ${payload.reason ?? res.status}`);
      return;
    }
    if (!quiet) logLine(action);
    if (payload.state) {
      state = payload.state;
      renderSeats();
      renderModes();
    }
  } catch (err) {
    logLine(`${action} failed: ${(err as Error).message}`);
  }
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch(`${BASE}practice-api/state`);
    const payload = (await res.json()) as { ok?: boolean; state?: PracticeState };
    if (payload.state) {
      state = payload.state;
      renderSeats();
      renderModes();
    }
  } catch {
    // The field is gone or restarting; the socket's own retry will say so.
  }
}

/* --- the panel --- */

function renderModes(): void {
  for (const button of modes.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
    button.classList.toggle('on', button.dataset['mode'] === state?.resolve);
  }
}

function labelFor(id: SeatId): string {
  const [side, number] = id.split('-') as [string, string];
  return `${side === 'violet' ? 'Violet' : 'Lime'} ${number}`;
}

function statusOf(seat: SeatState): string {
  if (seat.fill.kind === 'empty') return 'not in this situation';
  if (!seat.filled) return seat.detail ?? 'no program';
  if (seat.removed) return 'off the field — not answering';
  if (!seat.connected) return 'not answering';
  return 'playing';
}

/**
 * The seat strip, rebuilt only when what it says has changed.
 *
 * Rebuilding every frame would throw away a half-typed team name on every
 * frame, which is sixty times a second — and the referee console has already
 * been bitten once by a list that was cached too aggressively instead, so the
 * key is what the row actually shows rather than the seat ids, which never
 * change.
 */
let seatsKey = '';

function renderSeats(): void {
  if (!state) return;
  const key = SEATS.map((id) => {
    const seat = state!.seats[id]!;
    const team = seat.fill.kind === 'submission' ? seat.fill.team : '';
    return `${id}:${seat.fill.kind}:${team}:${statusOf(seat)}`;
  }).join('|');
  if (key === seatsKey) return;
  seatsKey = key;

  seatsPanel.replaceChildren(
    ...SEATS.map((id) => {
      const seat = state!.seats[id]!;
      const row = document.createElement('div');
      row.className = `seat ${id.startsWith('violet') ? 'violet' : 'lime'}`;

      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = labelFor(id);

      const fill = document.createElement('select');
      for (const [value, text] of [
        ['empty', 'not in it'],
        ['built-in', 'built-in robot'],
        ['submission', 'a pushed robot'],
        ['laptop', 'my laptop'],
      ] as const) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        option.selected = seat.fill.kind === value;
        fill.append(option);
      }

      const team = document.createElement('input');
      team.type = 'text';
      team.placeholder = 'team name';
      team.value = seat.fill.kind === 'submission' ? seat.fill.team : '';
      team.hidden = fill.value !== 'submission';

      const apply = (): void => {
        const chosen = fill.value;
        if (chosen === 'submission' && !team.value.trim()) {
          team.hidden = false;
          team.focus();
          return;
        }
        void act('seat', { seat: id, fill: chosen, team: team.value.trim() });
      };
      fill.addEventListener('change', () => {
        team.hidden = fill.value !== 'submission';
        if (fill.value !== 'submission' || team.value.trim()) apply();
        else team.focus();
      });
      team.addEventListener('change', apply);

      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = statusOf(seat);

      const buttons = document.createElement('div');
      buttons.className = 'row';
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.textContent = seat.filled ? 'Restart' : 'Start';
      restart.disabled = seat.fill.kind === 'empty';
      restart.addEventListener('click', () => void act('seat-restart', { seat: id }));
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.textContent = 'Stop';
      stop.disabled = !seat.filled || seat.fill.kind === 'built-in';
      stop.addEventListener('click', () => void act('seat-stop', { seat: id }));
      buttons.append(restart, stop);

      row.append(who, fill, team, status, buttons);
      return row;
    }),
  );
}

function updateBoard(frame: ViewFrame): void {
  board.violetName.textContent = frame.teams.violet;
  board.limeName.textContent = frame.teams.lime;
  board.violetScore.textContent = String(frame.score.violet);
  board.limeScore.textContent = String(frame.score.lime);
  const m = Math.floor(frame.clock / 60);
  const s = Math.floor(frame.clock % 60);
  board.clock.textContent = `${m}:${String(s).padStart(2, '0')}`;
  board.mode.textContent = frame.running ? 'playing' : 'stopped';

  const last = frame.events[frame.events.length - 1];
  if (last) {
    call.hidden = false;
    call.textContent = `Rule ${last.rule} — ${last.message}`;
  } else {
    call.hidden = true;
  }
}

/* --- dragging --- */

/** How close the pointer has to be to pick something up, in millimetres. */
const GRAB_RADIUS = 220;
/** A drag sends at most this often: enough to look continuous, not a flood. */
const DRAG_INTERVAL_MS = 50;

let dragging: 'ball' | SeatId | null = null;
let lastSentAt = 0;

function nearest(at: { x: number; z: number }): 'ball' | SeatId | null {
  if (!latest) return null;
  let best: 'ball' | SeatId | null = null;
  let bestDistance = GRAB_RADIUS;
  for (const robot of latest.robots) {
    if (robot.removed) continue;
    const d = Math.hypot(robot.x - at.x, robot.z - at.z);
    if (d < bestDistance) {
      bestDistance = d;
      best = robot.id as SeatId;
    }
  }
  const ball = Math.hypot(latest.ball.x - at.x, latest.ball.z - at.z);
  // The ball wins a tie: it is smaller, it is usually the thing being placed,
  // and a robot standing on it is the one case where both are under the
  // pointer at once.
  if (ball < bestDistance || (best === null && ball < GRAB_RADIUS)) best = 'ball';
  return best;
}

canvas.addEventListener('pointerdown', (event) => {
  const at = renderer?.pick(event.clientX, event.clientY);
  if (!at) return;
  dragging = nearest(at);
  if (!dragging) return;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const now = performance.now();
  if (now - lastSentAt < DRAG_INTERVAL_MS) return;
  const at = renderer?.pick(event.clientX, event.clientY);
  if (!at) return;
  lastSentAt = now;
  void act('place', { target: dragging, x: at.x, z: at.z }, true);
});

canvas.addEventListener('pointerup', (event) => {
  if (!dragging) return;
  const at = renderer?.pick(event.clientX, event.clientY);
  if (at) void act('place', { target: dragging, x: at.x, z: at.z });
  canvas.releasePointerCapture(event.pointerId);
  canvas.classList.remove('dragging');
  dragging = null;
});

/* --- the field --- */

function draw(): void {
  requestAnimationFrame(draw);
  if (!renderer || !latest) return;

  let frame = latest;
  if (previous && latestAt > previousAt) {
    const span = latestAt - previousAt;
    const t = Math.min(1, (performance.now() - latestAt) / span);
    frame = blend(previous, latest, t);
  }
  renderer.render(frame, 1 / 60);
  updateBoard(latest);
}

function receive(message: ViewMessage): void {
  if (message.type === 'hello') {
    league = message.league;
    if (!renderer) {
      renderer = new FieldRenderer(canvas, league);
      // Overhead, like the referee's: a team placing a robot has to see where
      // it actually is, and a broadcast angle is a guess about where it is.
      renderer.cameraMode = 'referee';
      renderer.resize();
      new ResizeObserver(() => renderer?.resize()).observe(canvas);
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

function connect(): void {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}`;
  const socket = new WebSocket(url);
  socket.addEventListener('message', (event) => {
    receive(JSON.parse(String(event.data)) as ViewMessage);
  });
  socket.addEventListener('close', () => setTimeout(connect, 1000));
  socket.addEventListener('error', () => socket.close());
}

document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
  button.addEventListener('click', () => void act(button.dataset['action']!));
});

modes.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach((button) => {
  button.addEventListener('click', () => void act('resolve', { mode: button.dataset['mode'] }));
});

connect();
draw();
void refresh();
// The seat strip is answered by every action, but a program connecting or
// dropping out is nobody's action — so ask, rarely, for the things nothing
// told us about.
setInterval(() => void refresh(), 1000);
