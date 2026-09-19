/// <reference types="vite/client" />
/**
 * The referee console.
 *
 * A second, separate client from the spectator viewer — its own HTML entry,
 * its own Vite build (`vite.referee.config.ts`, output to `dist/referee/`),
 * and no import of anything under `viewer/`. PHASES.md is explicit that this
 * has to be a genuinely different surface, authenticated and never reachable
 * from the untrusted spectator bundle, not the same page with buttons added.
 *
 * It watches the match exactly the way any spectator does — the same
 * unauthenticated WebSocket, the same `hello`/`frame` messages — because
 * *receiving* a frame is not a privilege boundary; only *acting* on one is.
 * Every control here calls `POST /referee-api/<action>` with a bearer token
 * the referee types in once, matching Phase 1's hand-issued credential: there
 * is no account, and the token is never embedded in this bundle.
 */

import { FieldRenderer } from '@rcja/shared/renderer';
import type { League } from '@rcja/shared/leagues';
import { applyViewDelta, type ViewFrame, type ViewMessage } from '@rcja/shared/view';

const TOKEN_KEY = 'rcja-referee-token';

const login = document.getElementById('login') as HTMLDivElement;
const loginForm = document.getElementById('login-form') as HTMLFormElement;
const tokenInput = document.getElementById('token-input') as HTMLInputElement;
const app = document.getElementById('app') as HTMLDivElement;

const canvas = document.getElementById('field') as HTMLCanvasElement;
const call = document.getElementById('call')!;
const standdown = document.getElementById('standdown')!;
const log = document.getElementById('log')!;

const board = {
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
let countdownRingStart = 3;
let countdownFadeTimer: number | undefined;
const skipCountdown = document.querySelector('button[data-action="skip-kickoff-countdown"]') as HTMLButtonElement | null;
const kickoffButtons = [
  ...document.querySelectorAll<HTMLButtonElement>('button[data-action="kickoff"]'),
];

const halfTimePanel = document.getElementById('half-time')!;
const halfTimeLeft = document.getElementById('ht-left')!;
const halfTimeReady = document.getElementById('ht-ready')!;
const halfTimeNote = document.getElementById('ht-note')!;

const abandonReason = document.getElementById('abandon-reason') as HTMLInputElement;
const correctTeam = document.getElementById('correct-team') as HTMLSelectElement;
const correctTo = document.getElementById('correct-to') as HTMLInputElement;
const correctReason = document.getElementById('correct-reason') as HTMLInputElement;
const removeRobotSelect = document.getElementById('remove-robot') as HTMLSelectElement;
const removeRule = document.getElementById('remove-rule') as HTMLInputElement;
const removeReason = document.getElementById('remove-reason') as HTMLInputElement;

let token: string | null = sessionStorage.getItem(TOKEN_KEY);
let renderer: FieldRenderer | null = null;
let league: League | null = null;
let halfSeconds = 300;

/** Same interpolation as the spectator viewer. Kept as a small, separate copy — see the header note. */
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

function formatClock(seconds: number, half: number): string {
  const into = Math.max(0, seconds - (half - 1) * halfSeconds);
  const m = Math.floor(into / 60);
  const s = Math.floor(into % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function logLine(text: string): void {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  log.prepend(line);
  while (log.childNodes.length > 20) log.lastChild?.remove();
}

/**
 * Where this console was served from, with a trailing slash.
 *
 * The console used to be at exactly one address — `/referee/` on the one world
 * a server had — so it asked for `/referee-api/…` and opened its socket at the
 * root. Phase 7 moved every world into a child arena, so the same bundle is now
 * served at `/a/<id>/referee/` and both of those absolute paths arrive at the
 * hub's front door instead of at the match. The viewer and the practice console
 * have derived their prefix this way since Phase 4 and 6 respectively, for the
 * same reason and with the same three lines.
 */
function basePath(): string {
  const path = location.pathname.endsWith('/') ? location.pathname : `${location.pathname}/`;
  return new URL('../', `${location.origin}${path}`).pathname;
}

/**
 * Call a referee action.
 *
 * The token is never sent anywhere except this server's own /referee-api, and
 * on a league server there is no token at all: the person signed in to the
 * site, and the session cookie the browser already sends is what authorises
 * this. Either way the server decides — this only avoids sending a header it
 * does not have.
 */
async function act(action: string, body?: unknown): Promise<boolean> {
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${basePath()}referee-api/${action}`, {
      method: 'POST',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      logLine(action);
      return true;
    }
    const err = (await res.json().catch(() => ({}))) as { reason?: string };
    logLine(`${action} refused: ${err.reason ?? res.status}`);
    return false;
  } catch (err) {
    logLine(`${action} failed: ${(err as Error).message}`);
    return false;
  }
}

/** Same countdown overlay as the viewer, plus the "Kick off now" button state. */
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
  if (skipCountdown) skipCountdown.disabled = !(countdown > 0);
}

/**
 * Half-time, and why the second half's whistle is held.
 *
 * The server refuses the kick-off itself — this only says so first, because a
 * button that refuses without warning is a referee pressing it twice and then
 * reading a log. The gate opens by itself when the clock runs out, so nothing
 * here can leave a referee stuck: at zero both buttons come back whatever
 * either team has said.
 */
function updateHalfTime(frame: ViewFrame): void {
  const halfTime = frame.halfTime;
  if (!halfTime) {
    halfTimePanel.hidden = true;
    for (const button of kickoffButtons) {
      button.disabled = false;
      button.title = '';
    }
    return;
  }

  halfTimePanel.hidden = false;
  const left = Math.ceil(halfTime.remaining);
  halfTimeLeft.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  const waiting = (['violet', 'lime'] as const).filter((team) => !halfTime.ready[team]);
  halfTimeReady.replaceChildren(
    ...(['violet', 'lime'] as const).map((team) => {
      const row = document.createElement('div');
      row.className = `ht-row ${team}${halfTime.ready[team] ? ' ready' : ''}`;
      row.textContent = `${frame.teams[team]} — ${halfTime.ready[team] ? 'ready' : 'still working'}`;
      return row;
    }),
  );

  const held = waiting.length > 0 && !halfTime.over;
  halfTimeNote.textContent = held
    ? 'Kick off once both teams say they are ready, or when the clock runs out. A push made now goes in when you lock the lineup again, from the match page.'
    : 'Half-time is over as far as the whistle is concerned — kick off when you are ready.';
  for (const button of kickoffButtons) {
    button.disabled = held;
    button.title = held ? `waiting on ${waiting.map((team) => frame.teams[team]).join(' and ')}` : '';
  }
}

function updateBoard(frame: ViewFrame): void {
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
    call.textContent = `Rule ${last.rule} — ${last.message}`;
  } else {
    call.hidden = true;
  }

  // The "remove a robot" list tracks who is actually on the field, rebuilt
  // only when it has actually changed rather than every frame.
  //
  // Keyed on the labels, not the ids. The ids never change — they are always
  // the same four seats — so keying on them alone meant the list was built once
  // and then never again, and the team names in it stayed those of the first
  // match this console ever saw. One `serve` playing the same two teams all day
  // hid that completely; a tournament, where the next fixture is a different
  // pair, turned it into a referee sending off the robot they did not pick.
  const onField = frame.robots.filter((r) => !r.removed);
  const labels = onField.map((r) => `${r.id}:${frame.teams[r.team]}`).join(',');
  if (removeRobotSelect.dataset['ids'] !== labels) {
    removeRobotSelect.dataset['ids'] = labels;
    removeRobotSelect.replaceChildren(
      ...onField.map((r) => {
        const opt = document.createElement('option');
        opt.value = r.id;
        const number = r.id.split('-')[1] ?? '';
        opt.textContent = `${frame.teams[r.team]} ${number}`;
        return opt;
      }),
    );
  }
}

/** Rule 5.7: off the field, with a Return button that only works once the referee agrees it is ready (5.7.4). */
function updateStandDown(frame: ViewFrame): void {
  const out = frame.robots.filter((r) => r.removed);
  if (out.length === 0) {
    standdown.hidden = true;
    standdown.replaceChildren();
    return;
  }

  standdown.hidden = false;
  const cards = out.map((robot) => {
    const seconds = robot.penaltyRemaining;
    const known = Number.isFinite(seconds);
    const left = known ? Math.ceil(seconds) : 0;
    const ready = known && left <= 0;

    const card = document.createElement('div');
    card.className = `sd-card ${robot.team}`;

    const who = document.createElement('span');
    who.className = 'who';
    const number = robot.id.split('-')[1] ?? '';
    who.textContent = `${frame.teams[robot.team]} ${number}`;

    const rule = document.createElement('span');
    rule.className = 'rule';
    rule.textContent = `§${robot.removalRule ?? '5.7'}`;
    if (robot.removalReason) card.title = robot.removalReason;

    const timer = document.createElement('span');
    timer.className = ready ? 'timer ready' : 'timer';
    timer.textContent = !known ? '—' : ready ? 'Ready' : `${left}s`;

    const returnButton = document.createElement('button');
    returnButton.type = 'button';
    returnButton.textContent = 'Return';
    returnButton.disabled = !ready;
    returnButton.addEventListener('click', () => void act('return-robot', { robotId: robot.id }));

    card.append(who, rule, timer, returnButton);
    return card;
  });
  standdown.replaceChildren(...cards);
}

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
  updateStandDown(latest);
  updateKickoff(latest);
  updateHalfTime(latest);
}

function receive(message: ViewMessage): void {
  if (message.type === 'hello') {
    league = message.league;
    halfSeconds = message.halfSeconds;
    if (!renderer) {
      renderer = new FieldRenderer(canvas, league);
      // Overhead, not broadcast: this view exists to settle exactly where a
      // robot was, which a broadcast angle hides and an overhead one does not.
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
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${basePath()}`;
  const socket = new WebSocket(url);
  socket.addEventListener('message', (event) => {
    receive(JSON.parse(String(event.data)) as ViewMessage);
  });
  socket.addEventListener('close', () => setTimeout(connect, 1000));
  socket.addEventListener('error', () => socket.close());
}

function numberInputValue(input: HTMLInputElement): number {
  return Number(input.value);
}

document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset['action']!;
    switch (action) {
      case 'kickoff':
        void act('kickoff', { team: button.dataset['team'] });
        break;
      case 'abandon': {
        const reason = abandonReason.value.trim();
        if (!reason) {
          logLine('abandon needs a reason');
          return;
        }
        void act('abandon', { reason });
        break;
      }
      case 'correct-score': {
        const to = numberInputValue(correctTo);
        const reason = correctReason.value.trim();
        if (!Number.isInteger(to) || to < 0 || !reason) {
          logLine('a score correction needs a whole number and a reason');
          return;
        }
        void act('correct-score', { team: correctTeam.value, to, reason });
        break;
      }
      case 'remove-robot': {
        const robotId = removeRobotSelect.value;
        const rule = removeRule.value.trim();
        const reason = removeReason.value.trim();
        if (!robotId || !rule || !reason) {
          logLine('removing a robot needs a rule and a reason');
          return;
        }
        void act('remove-robot', { robotId, rule, reason });
        break;
      }
      default:
        void act(action);
    }
  });
});

function enterConsole(): void {
  login.hidden = true;
  app.hidden = false;
  connect();
  draw();
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = tokenInput.value.trim();
  if (!value) return;
  token = value;
  sessionStorage.setItem(TOKEN_KEY, value);
  enterConsole();
});

if (token) {
  enterConsole();
} else {
  // No token, but the server may already know who this is: on a league server
  // the console is only served to a session that may control a match, so
  // asking is the difference between the console opening and a login screen
  // demanding a secret that was replaced by an account.
  void fetch(`${basePath()}referee-api/session`)
    .then((res) => {
      if (res.ok) enterConsole();
    })
    .catch(() => {
      // A match server without --referee, or no network. The login stays up,
      // which is the right fallback in both cases.
    });
}
