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

import { FieldRenderer } from '@rcja/shared/renderer';
import type { League } from '@rcja/shared/leagues';
import type { ViewFrame, ViewMessage } from '@rcja/shared/view';
import type { MatchResult } from '@rcja/server/src/match/match';

const canvas = document.getElementById('field') as HTMLCanvasElement;
const status = document.getElementById('status')!;
const call = document.getElementById('call')!;
const standdown = document.getElementById('standdown')!;
const cameras = document.getElementById('cameras')!;

const summaryModal = document.getElementById('match-summary')!;
const summaryCloseBtn = document.getElementById('summary-close')!;
const summaryDismissBtn = document.getElementById('summary-dismiss')!;
const summaryTitle = document.getElementById('summary-title')!;
const sumVioletName = document.getElementById('sum-violet-name')!;
const sumLimeName = document.getElementById('sum-lime-name')!;
const sumVioletScore = document.getElementById('sum-violet-score')!;
const sumLimeScore = document.getElementById('sum-lime-score')!;
const summarySpotlights = document.getElementById('summary-spotlights')!;
const summaryTeams = document.getElementById('summary-teams')!;
const summaryRobotsBody = document.getElementById('summary-robots-body')!;
const summaryStatusPill = document.getElementById('summary-status-pill');

let currentSummaryData: MatchResult | null = null;
let currentNextMatchIn: number | undefined;
let summaryShown = false;
let matchFinished = false;
let summaryButton: HTMLButtonElement | null = null;
let nextMatchCountdownTimer: ReturnType<typeof setInterval> | null = null;

function clearNextMatchTimer(): void {
  if (nextMatchCountdownTimer !== null) {
    clearInterval(nextMatchCountdownTimer);
    nextMatchCountdownTimer = null;
  }
}

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
  const isFinished = frame.half === 2 && !frame.running && frame.clock >= 2 * halfSeconds - 0.5;
  board.half.textContent = isFinished
    ? 'full time'
    : frame.running
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
    clearNextMatchTimer();
    league = message.league;
    halfSeconds = message.halfSeconds;
    currentSummaryData = null;
    currentNextMatchIn = undefined;
    summaryShown = false;
    matchFinished = false;
    summaryModal.hidden = true;
    updateSummaryButton();
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
      wireSummaryInteractions();
    } else {
      renderer.setLeague(league);
    }
    return;
  }

  if (message.type === 'summary') {
    currentSummaryData = message.result;
    currentNextMatchIn = message.nextMatchIn;
    matchFinished = true;
    updateSummaryButton();
    if (!summaryShown) {
      showSummary({ ...message.result, nextMatchIn: message.nextMatchIn });
    }
    return;
  }

  if (message.type === 'frame') {
    previous = latest;
    previousAt = latestAt;
    latest = message.frame;
    latestAt = performance.now();

    // If a new match has started (or pre-match of half 1), ensure summary modal is hidden
    if (!summaryModal.hidden && latest.half === 1 && (latest.running || latest.clock < 1)) {
      clearNextMatchTimer();
      summaryModal.hidden = true;
      summaryShown = false;
    }

    const isFullTime = latest.half === 2 && !latest.running && latest.clock >= 2 * halfSeconds - 0.5;
    if (isFullTime && !matchFinished) {
      matchFinished = true;
      updateSummaryButton();
      if (!summaryShown) {
        showSummary(currentSummaryData ? { ...currentSummaryData, nextMatchIn: currentNextMatchIn } : {
          score: latest.score,
          events: latest.events,
          nextMatchIn: currentNextMatchIn,
        });
      }
    }
  }
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
  if (!summaryModal.hidden) return;
  setCamera(cameraIndex + 1);
}

function updateSummaryButton(): void {
  if (!matchFinished) {
    if (summaryButton) summaryButton.hidden = true;
    return;
  }
  if (!summaryButton) {
    summaryButton = document.createElement('button');
    summaryButton.type = 'button';
    summaryButton.textContent = 'Summary';
    summaryButton.title = 'View full-time match summary';
    summaryButton.addEventListener('click', () => {
      if (currentSummaryData) {
        showSummary({ ...currentSummaryData, nextMatchIn: currentNextMatchIn });
      } else if (latest) {
        showSummary({ score: latest.score, events: latest.events, nextMatchIn: currentNextMatchIn });
      }
    });
    cameras.append(summaryButton);
  }
  summaryButton.hidden = false;
}

function wireSummaryInteractions(): void {
  summaryCloseBtn.addEventListener('click', () => {
    clearNextMatchTimer();
    summaryModal.hidden = true;
  });
  summaryDismissBtn.addEventListener('click', () => {
    clearNextMatchTimer();
    summaryModal.hidden = true;
  });
  summaryModal.addEventListener('click', (event) => {
    if (event.target === summaryModal) {
      clearNextMatchTimer();
      summaryModal.hidden = true;
    }
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !summaryModal.hidden) {
      clearNextMatchTimer();
      summaryModal.hidden = true;
    }
  });
  board.element.addEventListener('click', () => {
    if (matchFinished) {
      if (currentSummaryData) {
        showSummary({ ...currentSummaryData, nextMatchIn: currentNextMatchIn });
      } else if (latest) {
        showSummary({ score: latest.score, events: latest.events, nextMatchIn: currentNextMatchIn });
      }
    }
  });
}

function showSummary(data: {
  score: { violet: number; lime: number };
  robotStats?: Record<string, { goals: number; saves: number; shots: number; penalties: number }>;
  goals?: { team: 'violet' | 'lime'; at: number; robotId?: string }[];
  events?: { kind: string; at: number; team?: 'violet' | 'lime'; robotId?: string }[];
  nextMatchIn?: number;
}): void {
  summaryShown = true;
  summaryModal.hidden = false;

  clearNextMatchTimer();
  if (typeof data.nextMatchIn === 'number' && data.nextMatchIn > 0) {
    let remaining = Math.round(data.nextMatchIn);
    const updatePill = () => {
      if (summaryStatusPill) {
        summaryStatusPill.textContent = `Full Time • Next match in ${remaining}s`;
      }
    };
    updatePill();
    nextMatchCountdownTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearNextMatchTimer();
        if (summaryStatusPill) {
          summaryStatusPill.textContent = 'Next match starting…';
        }
      } else {
        updatePill();
      }
    }, 1000);
  } else if (summaryStatusPill) {
    summaryStatusPill.textContent = 'Full Time Summary';
  }

  const violetTeam = latest?.teams.violet ?? 'Violet';
  const limeTeam = latest?.teams.lime ?? 'Lime';
  const vScore = data.score.violet;
  const lScore = data.score.lime;

  let verdict = 'Match Drawn';
  if (vScore > lScore) verdict = `🏆 ${violetTeam} Victory!`;
  else if (lScore > vScore) verdict = `🏆 ${limeTeam} Victory!`;

  summaryTitle.textContent = verdict;
  sumVioletName.textContent = violetTeam;
  sumLimeName.textContent = limeTeam;
  sumVioletScore.textContent = String(vScore);
  sumLimeScore.textContent = String(lScore);

  interface RobotEntry {
    id: string;
    number: number;
    team: 'violet' | 'lime';
    teamName: string;
    role: 'Goalie' | 'Striker';
    goals: number;
    saves: number;
    shots: number;
    penalties: number;
  }

  const isGoalie = (id: string, defaultGoalie: boolean): boolean => {
    const r = latest?.robots.find((bot) => bot.id === id);
    return r ? r.isGoalie : defaultGoalie;
  };

  const robots: Record<string, RobotEntry> = {
    'violet-1': {
      id: 'violet-1',
      number: 1,
      team: 'violet',
      teamName: violetTeam,
      role: isGoalie('violet-1', false) ? 'Goalie' : 'Striker',
      goals: 0,
      saves: 0,
      shots: 0,
      penalties: 0,
    },
    'violet-2': {
      id: 'violet-2',
      number: 2,
      team: 'violet',
      teamName: violetTeam,
      role: isGoalie('violet-2', true) ? 'Goalie' : 'Striker',
      goals: 0,
      saves: 0,
      shots: 0,
      penalties: 0,
    },
    'lime-1': {
      id: 'lime-1',
      number: 1,
      team: 'lime',
      teamName: limeTeam,
      role: isGoalie('lime-1', false) ? 'Goalie' : 'Striker',
      goals: 0,
      saves: 0,
      shots: 0,
      penalties: 0,
    },
    'lime-2': {
      id: 'lime-2',
      number: 2,
      team: 'lime',
      teamName: limeTeam,
      role: isGoalie('lime-2', true) ? 'Goalie' : 'Striker',
      goals: 0,
      saves: 0,
      shots: 0,
      penalties: 0,
    },
  };

  if (data.robotStats) {
    for (const [id, s] of Object.entries(data.robotStats)) {
      if (robots[id]) {
        robots[id].goals += s.goals ?? 0;
        robots[id].saves += s.saves ?? 0;
        robots[id].shots += s.shots ?? 0;
        robots[id].penalties += s.penalties ?? 0;
      }
    }
  } else {
    if (data.goals) {
      for (const g of data.goals) {
        const id = g.robotId ?? (g.team === 'violet' ? 'violet-1' : 'lime-1');
        const target = robots[id];
        if (target) target.goals++;
      }
    }
    if (data.events) {
      for (const e of data.events) {
        if (e.kind === 'goal' && !data.goals) {
          const id = e.robotId ?? (e.team === 'violet' ? 'violet-1' : 'lime-1');
          const target = robots[id];
          if (target) target.goals++;
        }
        if (e.kind === 'possible-damaged' || e.kind === 'illegal-kickoff') {
          const target = e.robotId ? robots[e.robotId] : undefined;
          if (target) target.penalties++;
        }
      }
    }
  }

  const robotList = Object.values(robots);

  const topScorer = [...robotList].sort((a, b) => b.goals - a.goals)[0];
  const goalies = robotList.filter((r) => r.role === 'Goalie');
  const topKeeper = [...goalies].sort((a, b) => b.saves - a.saves)[0] ?? goalies[0];
  const topShooter = [...robotList].sort((a, b) => b.shots - a.shots)[0];

  const spotlights: string[] = [];

  if (topScorer && topScorer.goals > 0) {
    spotlights.push(`
      <div class="summary-spotlight-card ${topScorer.team}">
        <div class="spotlight-icon">⚽</div>
        <div class="spotlight-details">
          <div class="spotlight-label">Top Scorer</div>
          <div class="spotlight-robot">${topScorer.teamName} ${topScorer.number}</div>
          <div class="spotlight-team ${topScorer.team}">${topScorer.role} &bull; ${topScorer.teamName}</div>
        </div>
        <div class="spotlight-count">${topScorer.goals}</div>
      </div>
    `);
  } else {
    spotlights.push(`
      <div class="summary-spotlight-card">
        <div class="spotlight-icon">⚽</div>
        <div class="spotlight-details">
          <div class="spotlight-label">Top Scorer</div>
          <div class="spotlight-robot">None</div>
          <div class="spotlight-team">No goals scored</div>
        </div>
        <div class="spotlight-count">0</div>
      </div>
    `);
  }

  if (topKeeper) {
    spotlights.push(`
      <div class="summary-spotlight-card ${topKeeper.team}">
        <div class="spotlight-icon">🧤</div>
        <div class="spotlight-details">
          <div class="spotlight-label">Top Goalie</div>
          <div class="spotlight-robot">${topKeeper.teamName} ${topKeeper.number}</div>
          <div class="spotlight-team ${topKeeper.team}">${topKeeper.role} &bull; ${topKeeper.teamName}</div>
        </div>
        <div class="spotlight-count">${topKeeper.saves}</div>
      </div>
    `);
  }

  if (topShooter && topShooter.shots > 0) {
    spotlights.push(`
      <div class="summary-spotlight-card ${topShooter.team}">
        <div class="spotlight-icon">🎯</div>
        <div class="spotlight-details">
          <div class="spotlight-label">Most Shots</div>
          <div class="spotlight-robot">${topShooter.teamName} ${topShooter.number}</div>
          <div class="spotlight-team ${topShooter.team}">${topShooter.role} &bull; ${topShooter.teamName}</div>
        </div>
        <div class="spotlight-count">${topShooter.shots}</div>
      </div>
    `);
  }

  summarySpotlights.innerHTML = spotlights.join('');

  const vSaves = robots['violet-1']!.saves + robots['violet-2']!.saves;
  const lSaves = robots['lime-1']!.saves + robots['lime-2']!.saves;
  const vShots = robots['violet-1']!.shots + robots['violet-2']!.shots;
  const lShots = robots['lime-1']!.shots + robots['lime-2']!.shots;
  const vCards = robots['violet-1']!.penalties + robots['violet-2']!.penalties;
  const lCards = robots['lime-1']!.penalties + robots['lime-2']!.penalties;

  function renderCompRow(label: string, vVal: number, lVal: number): string {
    const total = vVal + lVal;
    const vPct = total > 0 ? (vVal / total) * 100 : 50;
    const lPct = total > 0 ? (lVal / total) * 100 : 50;
    return `
      <div class="comparison-row">
        <div class="comparison-header">
          <span class="comp-num violet">${vVal}</span>
          <span class="comp-label">${label}</span>
          <span class="comp-num lime">${lVal}</span>
        </div>
        <div class="comp-bar">
          <div class="comp-bar-fill violet" style="width: ${vPct}%"></div>
          <div class="comp-bar-fill lime" style="width: ${lPct}%"></div>
        </div>
      </div>
    `;
  }

  summaryTeams.innerHTML = [
    renderCompRow('Goals', vScore, lScore),
    renderCompRow('Saves', vSaves, lSaves),
    renderCompRow('Shots', vShots, lShots),
    renderCompRow('Penalties & Cards', vCards, lCards),
  ].join('');

  summaryRobotsBody.innerHTML = robotList
    .map((r) => {
      const isViolet = r.team === 'violet';
      return `
        <tr>
          <td>
            <div class="robot-cell">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${
                isViolet ? 'var(--violet)' : 'var(--lime)'
              }"></span>
              ${r.teamName} ${r.number}
            </div>
          </td>
          <td style="color:${isViolet ? 'var(--violet)' : 'var(--lime)'}; font-weight:600;">${r.teamName}</td>
          <td><span class="role-pill ${r.role.toLowerCase()}">${r.role}</span></td>
          <td style="font-weight:${r.goals > 0 ? '700' : '400'}; color:${r.goals > 0 ? '#4ade80' : 'inherit'};">${r.goals}</td>
          <td style="font-weight:${r.saves > 0 ? '700' : '400'};">${r.saves}</td>
          <td>${r.shots}</td>
          <td style="color:${r.penalties > 0 ? '#f87171' : 'inherit'};">${r.penalties}</td>
        </tr>
      `;
    })
    .join('');
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
