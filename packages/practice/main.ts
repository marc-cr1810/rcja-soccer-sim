/// <reference types="vite/client" />
/**
 * The practice console.
 *
 * A third client, on the same pattern as the referee's: its own HTML entry,
 * its own Vite build (`vite.practice.config.ts`, output to `dist/practice/`),
 * and no import of anything under `viewer/` or `referee/`. It watches the
 * field over the same unauthenticated socket every spectator uses, and acts
 * through `POST /practice-api/*` — which exists only on a server that is a
 * practice field.
 *
 * **The same console, in two worlds.** On a laptop there are no accounts, the
 * field is open to whoever has the link, and every seat is yours because there
 * is nobody else. On a league server the field belongs to a team, and the hub
 * in front of it answers `practice-api/who` with who you are and which seats
 * hold whose robots. A 404 to that question *is* the laptop case — the console
 * asks once and shapes itself around the answer, rather than being built twice.
 *
 * The one genuinely new thing here is dragging. Everything else a team can do
 * to a field — start it, stop it, put the situation back, swap what is
 * driving a robot — is a button; but where a robot and the ball start is the
 * whole question a rehearsal asks, and typing millimetres is not how anybody
 * asks it.
 */

import { FieldRenderer } from '@rcja/shared/renderer';
import type { League } from '@rcja/shared/leagues';
import { applyViewDelta, type ViewFrame, type ViewMessage } from '@rcja/shared/view';

type SeatId = 'violet-1' | 'violet-2' | 'lime-1' | 'lime-2';
const SEATS: SeatId[] = ['violet-1', 'violet-2', 'lime-1', 'lime-2'];

type SeatFill =
  | { kind: 'empty' }
  | { kind: 'built-in' }
  | { kind: 'laptop'; team?: string }
  | { kind: 'submission'; team: string }
  | { kind: 'workspace'; team: string };

/**
 * Who is looking, when a hub is in front of this field.
 *
 * `null` means nobody asked — a standalone practice field, where the console
 * behaves exactly as it did in Phase 4.
 */
interface Who {
  you: string | null;
  owner: string | null;
  guests: string[];
  mayRun: boolean;
  /** An organiser, who may seat anybody's robot. */
  anyTeam: boolean;
  /** Seat id → whose robot is in it. */
  seats: Record<string, { team: string; number: number } | undefined>;
}

let who: Who | null = null;
/** The command that puts a laptop program in a seat, once one has been minted. */
const joinCommands = new Map<string, string>();
/**
 * Which seat's output is being read, and how far the reader has got.
 *
 * One at a time, on purpose: four scrolling panels is a wall, and the thing a
 * student is doing is reading one traceback belonging to one robot.
 */
let openOutput: SeatId | null = null;
/** Seat → the last `outputSeq` this page has actually shown. */
const shownOutput = new Map<string, number>();
/** Seat → the lines fetched so far, oldest first. */
const outputLines = new Map<string, string[]>();

interface SeatState {
  fill: SeatFill;
  onField: boolean;
  removed: boolean;
  filled: boolean;
  connected: boolean;
  detail?: string;
  /** Moves when this seat's program has said something new. */
  outputSeq: number;
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
const notice = document.getElementById('notice')!;
const output = document.getElementById('output')!;
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
    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      reason?: string;
      state?: PracticeState;
      join?: { seat: string; command: string };
    };
    if (!res.ok || !payload.ok) {
      logLine(`${action} refused: ${payload.reason ?? res.status}`);
      return;
    }
    if (!quiet) logLine(action);
    // A token is shown once, in the answer to the request that minted it, and
    // never appears in the field's state — which everybody on the field reads.
    if (payload.join) {
      joinCommands.set(payload.join.seat, payload.join.command);
      logLine('copy the command under that seat and run it in a terminal');
    }
    if (payload.state) {
      state = payload.state;
      seatsKey = '';
      renderSeats();
      renderModes();
    }
  } catch (err) {
    logLine(`${action} failed: ${(err as Error).message}`);
  }
}

/**
 * Fetch what a seat has said since we last looked.
 *
 * Its own request rather than part of the state everybody polls: a traceback is
 * one person reading one seat, and the state is read once a second by everybody
 * on the field. `seq` comes back either way, so a panel that has fallen behind
 * the server's ring buffer knows it rather than waiting for a line that was
 * dropped.
 */
async function fetchOutput(id: SeatId): Promise<void> {
  const since = shownOutput.get(id) ?? 0;
  try {
    const res = await fetch(`${BASE}practice-api/output?seat=${id}&since=${since}&active=0`);
    const payload = (await res.json()) as {
      ok?: boolean;
      seq?: number;
      lines?: { seq: number; text: string }[];
    };
    if (!payload.ok) return;
    // A number that has gone backwards means the seat was emptied or became
    // something else, and the server started counting again. Whatever this page
    // is still holding belonged to the program that was there before, which is
    // the confusion the server's own forgetting was meant to avoid.
    const lines = (payload.seq ?? 0) < since ? [] : (outputLines.get(id) ?? []);
    for (const line of payload.lines ?? []) lines.push(line.text);
    // Same ceiling the server keeps, so a long-running seat cannot grow this
    // page without limit either.
    while (lines.length > 200) lines.shift();
    outputLines.set(id, lines);
    shownOutput.set(id, payload.seq ?? since);
    if (openOutput === id) renderOutput();
  } catch {
    // The field is gone or restarting; the next poll says so.
  }
}

function renderOutput(): void {
  if (!openOutput) {
    output.hidden = true;
    return;
  }
  output.hidden = false;
  const lines = outputLines.get(openOutput) ?? [];
  output.textContent = lines.length > 0 ? lines.join('\n') : 'nothing said yet';
  output.scrollTop = output.scrollHeight;
}

async function refresh(): Promise<void> {
  try {
    // A tab nobody is looking at is not somebody using this field: a poll that
    // says so keeps the page up to date without holding an arena open for a
    // team who closed their laptop hours ago.
    const res = await fetch(`${BASE}practice-api/state?active=${document.hidden ? '0' : '1'}`);
    const payload = (await res.json()) as { ok?: boolean; state?: PracticeState; notice?: string };
    if (payload.state) {
      state = payload.state;
      renderSeats();
      renderModes();
      // Whatever the open seat has said since the last look, if anybody is
      // reading one. Nothing is fetched for the other three.
      if (openOutput && payload.state.seats[openOutput]!.outputSeq !== shownOutput.get(openOutput)) {
        void fetchOutput(openOutput);
      }
    }
    // Only a supervised field is ever told anything; a laptop has nobody to
    // hear from, and the banner simply never appears.
    notice.textContent = payload.notice ?? '';
    notice.hidden = !payload.notice;
  } catch {
    // The field is gone or restarting; the socket's own retry will say so.
  }
}

/**
 * Ask who is looking, once, before anything is drawn.
 *
 * A 404 is the answer on a laptop — there is no hub in front of this field and
 * no accounts anywhere — and it leaves `who` null, which is what every check
 * below reads as "every seat is yours".
 */
async function askWho(): Promise<void> {
  try {
    const res = await fetch(`${BASE}practice-api/who`);
    if (!res.ok) return;
    const payload = (await res.json()) as Who & { ok?: boolean };
    if (payload.ok) who = payload;
  } catch {
    // Same as a 404: nobody is asking.
  }
}

/** Whether this seat is one the person looking may fill. */
function mine(id: SeatId): boolean {
  if (!who) return true;
  if (who.anyTeam) return true;
  const held = who.seats[id];
  if (held) return held.team === who.you;
  // An empty seat on a field is fillable by anybody who is on the field: the
  // owner, and any team they invited.
  return true;
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

/** Whether this seat is the kind that has a program of its own to say things. */
function speaks(seat: SeatState): boolean {
  return seat.fill.kind === 'submission' || seat.fill.kind === 'workspace';
}

function renderSeats(): void {
  if (!state) return;
  // A seat that has become a built-in robot, or nothing, has no Output button
  // any more — so an open panel belonging to it would be one nobody could
  // close. It goes with the button.
  if (openOutput && !speaks(state.seats[openOutput]!)) {
    openOutput = null;
    renderOutput();
  }
  const key = SEATS.map((id) => {
    const seat = state!.seats[id]!;
    const team = seat.fill.kind === 'built-in' || seat.fill.kind === 'empty' ? '' : (seat.fill.team ?? '');
    const said = seat.outputSeq > 0 && seat.outputSeq !== shownOutput.get(id) ? 'said' : '';
    return `${id}:${seat.fill.kind}:${team}:${statusOf(seat)}:${mine(id) ? 'mine' : 'theirs'}:${joinCommands.get(id) ?? ''}:${openOutput === id ? 'open' : ''}:${said}`;
  }).join('|');
  if (key === seatsKey) return;
  seatsKey = key;

  seatsPanel.replaceChildren(
    ...SEATS.map((id) => {
      const seat = state!.seats[id]!;
      const row = document.createElement('div');
      const yours = mine(id);
      row.className = `seat ${id.startsWith('violet') ? 'violet' : 'lime'}${yours ? '' : ' theirs'}`;

      const label = document.createElement('span');
      label.className = 'who';
      label.textContent = labelFor(id);
      const held = who?.seats[id];
      if (held && held.team !== who?.you) label.title = `${held.team}'s robot ${held.number}`;

      const fill = document.createElement('select');
      for (const [value, text] of [
        ['empty', 'not in it'],
        ['built-in', 'built-in robot'],
        ['workspace', 'what I am writing'],
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
      team.value = seat.fill.kind === 'submission' || seat.fill.kind === 'workspace' ? seat.fill.team : '';
      // On a league server you are the only team you may seat, so there is
      // nothing to type and nothing to get wrong. An organiser, who may seat
      // anybody, still gets the box.
      const fixedTeam = who && !who.anyTeam ? who.you : null;
      if (fixedTeam && !team.value) team.value = fixedTeam;
      const needsTeam = (kind: string): boolean => kind === 'submission' || kind === 'workspace';
      team.hidden = !needsTeam(fill.value) || fixedTeam !== null;

      const apply = (): void => {
        const chosen = fill.value;
        const named = (fixedTeam ?? team.value).trim();
        if ((chosen === 'submission' || chosen === 'workspace' || (chosen === 'laptop' && who)) && !named) {
          team.hidden = false;
          team.focus();
          return;
        }
        // `fill` is an object on the wire, the same shape it comes back in.
        // It was once a bare string with the team beside it, which quietly
        // stopped being accepted when the endpoints grew schemas.
        const body =
          chosen === 'submission' || chosen === 'workspace'
            ? { kind: chosen, team: named }
            : chosen === 'laptop' && named
              ? { kind: 'laptop', team: named }
              : { kind: chosen };
        joinCommands.delete(id);
        void act('seat', { seat: id, fill: body });
      };
      fill.addEventListener('change', () => {
        team.hidden = !needsTeam(fill.value) || fixedTeam !== null;
        if (!needsTeam(fill.value) || team.value.trim()) apply();
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

      // Where a traceback goes. Only for a seat that runs a program here — a
      // built-in agent is a function call with nothing to say, and a laptop's
      // program prints into the student's own terminal.
      const said = document.createElement('button');
      said.type = 'button';
      said.className = 'output-toggle';
      said.textContent = openOutput === id ? 'Hide output' : 'Output';
      said.hidden = !speaks(seat);
      // Something has been said that nobody here has read yet.
      if (seat.outputSeq > 0 && seat.outputSeq !== shownOutput.get(id)) said.classList.add('unread');
      said.addEventListener('click', () => {
        openOutput = openOutput === id ? null : id;
        seatsKey = '';
        if (openOutput) void fetchOutput(openOutput);
        else renderOutput();
        renderSeats();
      });
      buttons.append(restart, stop, said);

      // Somebody else's robot: shown, never touched. The server refuses it
      // anyway — this is so nobody tries and reads a refusal instead.
      if (!yours) {
        fill.disabled = true;
        team.disabled = true;
        restart.disabled = true;
        stop.disabled = true;
      }

      row.append(label, fill, team, status, buttons);

      const command = joinCommands.get(id);
      if (command) {
        const box = document.createElement('div');
        box.className = 'join';
        box.textContent = command;
        box.title = 'run this in a terminal, in the folder with your robot';
        row.append(box);
      }
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
  if (message.type === 'frame') {
    previous = latest;
    previousAt = latestAt;
    latest = message.frame;
    latestAt = performance.now();
  } else if (message.type === 'delta') {
    if (!latest) return;
    previous = latest;
    previousAt = latestAt;
    latest = applyViewDelta(latest, message.delta);
    latestAt = performance.now();
  }
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
// Who is looking decides what the seat strip is allowed to offer, so it is
// asked before the first render rather than filled in underneath one.
void askWho().then(() => {
  seatsKey = '';
  return refresh();
});
// The seat strip is answered by every action, but a program connecting or
// dropping out is nobody's action — so ask, rarely, for the things nothing
// told us about.
setInterval(() => void refresh(), 1000);
