/// <reference types="vite/client" />
/**
 * The league site.
 *
 * One shell, client-routed, with the whole of what a visitor sees built out of
 * JSON the league server folds fresh from the draw and whatever results exist
 * on disk. Nothing here caches anything, for the same reason `deriveTable`
 * caches nothing: a table that can be stale is worse than a table that costs a
 * file read.
 *
 * What is deliberately *not* here: anything that controls a match, edits code
 * or runs a robot. Those are the referee console and the workspace editor,
 * still their own bundles behind their own paths, and the server refuses both
 * to a session without the capability — so a spectator never downloads
 * match-control code. This page only ever links to them.
 */

const view = document.getElementById('view') as HTMLElement;
const nav = document.getElementById('nav') as HTMLElement;
const who = document.getElementById('who') as HTMLElement;

interface Me {
  account: { id: string; slug: string; displayName: string; role: string } | null;
  can: { workspace: boolean; referee: boolean; admin: boolean };
}

let me: Me = { account: null, can: { workspace: false, referee: false, admin: false } };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return (await res.json()) as T;
}

function h(html: string): string {
  return html;
}

/** Everything that reaches the DOM as text goes through here. Team names are user input. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `{hi, lo}` as the 64-bit seed the CLI prints, so pasting it back is obvious. */
function seedText(seed: unknown): string {
  if (typeof seed === 'number') return String(seed);
  if (seed && typeof seed === 'object' && 'hi' in seed && 'lo' in seed) {
    const { hi, lo } = seed as { hi: number; lo: number };
    return `0x${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
  }
  return String(seed);
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A time somebody reads at a venue.
 *
 * Today's matches get a clock time, because everything on the page happened
 * today and repeating the date twelve times says nothing. Anything older
 * carries its date, because by then that is the part you need.
 */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const sameDay =
    at.getDate() === today.getDate() &&
    at.getMonth() === today.getMonth() &&
    at.getFullYear() === today.getFullYear();
  return sameDay ? time : `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

// ------------------------------------------------------------------ routing

type Route = (params: string[]) => Promise<void> | void;

const ROUTES: [RegExp, Route][] = [
  [/^\/$/, front],
  [/^\/schedule$/, schedule],
  [/^\/standings$/, standings],
  [/^\/t\/([^/]+)$/, (p) => teamPage(p[0]!)],
  [/^\/m\/([^/]+)$/, (p) => matchPage(p[0]!)],
  [/^\/login$/, login],
  [/^\/register$/, register],
  [/^\/team$/, dashboard],
  [/^\/team\/settings$/, settings],
  [/^\/admin$/, admin],
  [/^\/admin\/arenas$/, adminArenas],
  [/^\/admin\/tournaments$/, adminTournaments],
  [/^\/admin\/teams$/, adminTeams],
  [/^\/admin\/people$/, adminPeople],
  [/^\/admin\/audit$/, adminAudit],
  [/^\/admin\/settings$/, adminSettings],
  [/^\/referee\/?$/, refereeList],
  [/^\/referee\/m\/([^/]+)$/, (p) => refereeMatch(p[0]!)],
  // END-STATE.md's own name for the pre-game screen, pointed at the same
  // renderer: the match page already *is* the checklist while pre-game is open.
  // Two names rather than two pages, so a referee handed either address by a
  // colleague or by the terminal lands on the right screen.
  [/^\/referee\/m\/([^/]+)\/setup$/, (p) => refereeMatch(p[0]!)],
];

/** Refreshed while something is live, cleared on every navigation. */
let ticking: ReturnType<typeof setInterval> | null = null;

/**
 * Re-run this page on a timer, replacing whatever was already running.
 *
 * A page that refreshes by calling itself renders again on every tick, and
 * setting the interval on the way through without dropping the old one
 * *doubles* the timers each time: a live match left open goes from one request
 * every three seconds to hundreds a second inside a minute. Measured, not
 * theorised — 256 requests in a single burst.
 */
function repoll(again: () => void, ms: number): void {
  if (ticking) clearInterval(ticking);
  ticking = setInterval(again, ms);
}

async function go(path: string, replace = false): Promise<void> {
  freshKey = null;
  if (ticking) {
    clearInterval(ticking);
    ticking = null;
  }
  if (path !== location.pathname) {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
  }
  me = await api<Me>('/api/me');
  chrome();
  for (const [pattern, route] of ROUTES) {
    const match = pattern.exec(location.pathname);
    if (match) {
      await route(match.slice(1));
      return;
    }
  }
  view.innerHTML = h(`<h1>Nothing here</h1><p class="dim">That page does not exist. <a href="/">Back to the front page</a>.</p>`);
}

/** Intercept in-site links so a click does not reload the whole bundle. */
document.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest('a');
  if (!link) return;
  const href = link.getAttribute('href') ?? '';
  // Anything leaving the site - the viewer, the referee console, the
  // workspace - is a real navigation, because those are other bundles.
  if (!href.startsWith('/') || link.hasAttribute('data-full')) return;
  event.preventDefault();
  void go(href);
});

window.addEventListener('popstate', () => void go(location.pathname, true));

function chrome(): void {
  const links: [string, string][] = [
    ['/', 'Now'],
    ['/schedule', 'Schedule'],
    ['/standings', 'Table'],
  ];
  // One personal link, not three. A referee has no workspace and an organiser
  // has no robots, so offering everybody every area is offering most people a
  // door into somewhere that has nothing for them.
  if (me.can.admin) links.push(['/admin', 'Admin']);
  else if (me.can.referee) links.push(['/referee', 'Referee']);
  else if (me.account) links.push(['/team', 'My team']);

  nav.innerHTML = links
    .map(([href, text]) => `<a href="${href}" class="${location.pathname === href ? 'on' : ''}">${text}</a>`)
    .join('');

  if (me.account) {
    who.innerHTML = h(`
      <a href="/team">${esc(me.account.displayName)}</a>
      <button class="quiet" id="logout">Sign out</button>
    `);
    document.getElementById('logout')!.addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' });
      await go('/');
    });
  } else {
    who.innerHTML = h(`<a href="/login">Sign in</a>`);
  }
}

// -------------------------------------------------------------------- pages

interface Card {
  id: string;
  home: string;
  away: string;
  // `resultCard` on the server spells these `…Score`; a `FixtureVerdict`'s own
  // goal totals are the ones called `…Goals`, and reading one shape with the
  // other's names is why every played fixture on this sheet read 0-0.
  homeScore?: number;
  awayScore?: number;
  completedAt?: string;
  state?: string;
  /** When it is due. A programme, not a countdown — nothing starts by itself. */
  playAt?: string;
}

interface Live {
  fixtureId: string;
  /** The child process playing it — there is one per match now. */
  arenaId: string;
  /** Where to watch it. The hub has no single viewer any more. */
  url: string;
  home: string;
  away: string;
  score: { violet: number; lime: number };
  clock: number;
  half: 1 | 2;
  running: boolean;
  /** A demo attraction: no fixture behind it, and it plays forever. */
  demo?: boolean;
}

interface Standing {
  name: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  for: number;
  against: number;
  points: number;
}

/**
 * The match being played, as a match sheet writes it.
 *
 * Two rows rather than a line of "home 2-1 away", because that is how a score
 * is read off a sheet and because it gives each side room for a real team
 * name. The bar beside each name is the colour that side's robots are on the
 * field, which is the one piece of information a person watching needs to
 * connect this page to what is in front of them.
 */
function scoreline(sides: {
  href: string;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  /** The line under the score, as its separate parts. */
  state: string[];
  live?: boolean;
}): string {
  return h(`
    <a class="scoreline" href="${sides.href}">
      <div class="side violet">
        <span class="bar"></span>
        <span class="name">${esc(sides.home)}</span>
        <span class="goals">${sides.homeGoals}</span>
      </div>
      <div class="side lime">
        <span class="bar"></span>
        <span class="name">${esc(sides.away)}</span>
        <span class="goals">${sides.awayGoals}</span>
      </div>
      <div class="state">${sides.state
        .map((part, index) =>
          index === 0 && sides.live
            ? `<span class="live"><span class="pulse"></span>${esc(part)}</span>`
            : `<span>${esc(part)}</span>`,
        )
        .join('<span class="sep">&nbsp;/&nbsp;</span>')}</div>
    </a>
  `);
}

function liveScoreline(live: Live): string {
  const half = `half ${live.half}`;
  return scoreline({
    // A demo has no match page behind it — the arena viewer is the page.
    href: live.demo ? live.url : `/m/${encodeURIComponent(live.fixtureId)}`,
    home: live.home,
    away: live.away,
    homeGoals: live.score.violet,
    awayGoals: live.score.lime,
    state: [
      live.demo ? 'Exhibition' : live.running ? 'live' : 'stopped',
      half,
      clock(live.clock),
    ],
    live: live.running,
  });
}

/**
 * What a state is called on a public sheet.
 *
 * Only the ones that do not read as English on their own. A match whose clock
 * has run out but whose referee has not agreed it yet is at full time, and
 * saying "playing" there would be a small lie told on a projector. `upcoming`
 * is deliberately blank: a row on a list of what is coming does not need to be
 * told it is coming.
 */
const PUBLIC_STATE: Record<string, string> = {
  confirming: 'full time',
  pregame: 'teams are arriving',
  due: 'waiting for the referee',
  opening: 'starting',
  upcoming: '',
};

/** One of the four seats in a fixture, as the hub's checklist sends it. */
interface Seat {
  id: string;
  team: string;
  slug: string;
  number: number;
  arrived: boolean;
  pushed: { hash: string; at: string } | null;
  seated: boolean;
  program?: 'no-push' | 'starting' | 'on-field' | 'would-not-start';
  /** The code the program is actually running, which `pushed` may have moved past. */
  loaded?: { hash: string };
  detail?: string;
}

/**
 * The four seats of a fixture, as a checklist.
 *
 * One row per seat rather than one per team, because the seats are what the
 * match actually has and a team with one robot pushed is a real and ordinary
 * thing. The hash is here for the reason END-STATE gives: a team that pushed a
 * fix ninety seconds ago has to be able to *see* that the fix is the thing
 * loaded, and a team name cannot tell them — it is re-pointed at new code on
 * every push.
 *
 * The badge is the seat's *claim* and not its program. A team whose robot will
 * not start is still here and still ready in every sense the clock cares
 * about; what their program is doing is the sentence beside it, which is the
 * thing they can go and fix.
 */
function seatRows(seats: Seat[]): string {
  return `<div class="rows">${seats
    .map((seat) => {
      const code = seat.pushed
        ? `<span class="mono">${esc(seat.pushed.hash.slice(0, 8))}</span> &middot; pushed ${esc(when(seat.pushed.at))}`
        : 'nothing pushed';
      const badge = seat.program === 'on-field' ? 'on the field' : seat.seated ? 'ready' : 'waiting';
      return `<div class="row">
        <span class="grow">
          ${esc(seat.team)} robot ${seat.number}
          <span class="dim">&mdash; ${code}</span>
          ${seat.detail ? `<span class="dim">&mdash; ${esc(seat.detail)}</span>` : ''}
        </span>
        <span class="state ${seat.seated ? 'playing' : ''}">${badge}</span>
      </div>`;
    })
    .join('')}</div>`;
}

/** Which teams still have nobody standing at the pitch. */
function missingFrom(seats: Seat[]): string[] {
  const teams = [...new Set(seats.map((seat) => seat.team))];
  return teams.filter((team) => !seats.some((seat) => seat.team === team && seat.seated));
}

/** What a pre-game room is waiting on, and what the waiting has cost so far. */
interface PregameRoom {
  since: string;
  /** When a push stopped reaching this match, or `null` while one still does. */
  lockedAt: string | null;
  penalty: {
    available: boolean;
    perMin: number;
    running: boolean;
    since: string | null;
    goals: { violet: number; lime: number };
  };
  autoStartAt: string | null;
  nobodyHere: boolean;
}

/**
 * The penalty clock, and the two things a referee needs beside it.
 *
 * Nothing runs on its own here. The clock is a button, because the referee is
 * the only one at the pitch who can see whether a delay is the team's fault or
 * the venue's network — and a room that starts itself does so only because the
 * venue asked for it in `league.json`, which is worth saying on the page rather
 * than surprising somebody with.
 */
function penaltyPanel(
  fixture: { home: string; away: string },
  room: PregameRoom | null,
): string {
  if (!room) return '';
  const { penalty } = room;
  const owed = [
    penalty.goals.violet > 0 ? `${esc(fixture.home)} ${penalty.goals.violet}` : '',
    penalty.goals.lime > 0 ? `${esc(fixture.away)} ${penalty.goals.lime}` : '',
  ]
    .filter(Boolean)
    .join(' and ');

  return `
    ${
      room.nobodyHere
        ? `<p class="dim" style="margin-top:1rem">Neither team has arrived. Nothing is being awarded &mdash; there is nobody to award it to.</p>`
        : ''
    }
    ${
      penalty.available
        ? `<p style="margin-top:1rem">
             <button id="penalty-clock" data-on="${penalty.running}">${
               penalty.running ? 'Stop the penalty clock' : 'Start the penalty clock'
             }</button>
             <span class="dim">&mdash; ${penalty.perMin} goal${penalty.perMin === 1 ? '' : 's'} a minute to whoever is here${
               penalty.running ? ', running now' : ''
             }</span>
           </p>`
        : ''
    }
    ${owed ? `<p class="dim">Awarded so far: ${owed}. Stopping the clock keeps it.</p>` : ''}
    ${
      room.autoStartAt
        ? `<p class="dim">This room starts itself at ${esc(when(room.autoStartAt))} unless somebody starts it first.</p>`
        : ''
    }
  `;
}

/** A fixture as a line on a sheet: who, the score if there is one, and where it got to. */
function fixtureRow(card: Card): string {
  const played = card.state === 'played';
  const state = card.state ?? '';
  return h(`
    <a class="row" href="/m/${encodeURIComponent(card.id)}">
      ${card.playAt ? `<span class="at">${esc(when(card.playAt))}</span>` : ''}
      <span class="grow">${esc(card.home)}<span class="v">v</span>${esc(card.away)}</span>
      ${played ? `<span class="score">${card.homeScore ?? 0}&ndash;${card.awayScore ?? 0}</span>` : ''}
      <span class="state ${state === 'playing' ? 'playing' : ''}">${
        played ? esc(when(card.completedAt ?? '')) : esc(PUBLIC_STATE[state] ?? state)
      }</span>
    </a>
  `);
}

/**
 * The front page: three bands.
 *
 * Now playing, up next, and what has been played. A person in the hall wants
 * the first one and a person at home wants the third, and neither should have
 * to know which link to press to find out.
 */
async function front(): Promise<void> {
  interface Front {
    tournament: { name: string; fixturesTotal: number } | null;
    live: Live[];
    next: Card | null;
    upcoming: Card[];
    recent: Card[];
    table: Standing[];
  }
  const data = await api<Front>('/api/front');

  if (!data.tournament) {
    if (!data.live.length) {
      view.innerHTML = h(`
        <h1>RCJA Soccer Simulation</h1>
        <p class="dim">No tournament is loaded on this server yet.</p>
        <div class="empty">When a draw is running, this page shows what is on now, what is next and what has been played.</div>
      `);
      return;
    }
    // A demo arena can keep the hall screen busy before any draw is running.
    view.innerHTML = h(`
      <h1>RCJA Soccer Simulation</h1>
      <p class="dim">No tournament is loaded on this server yet.</p>

      <h2>On now</h2>
      ${data.live
        .map(
          (live) => `${liveScoreline(live)}
         <p style="margin-top:.6rem;margin-bottom:1.4rem"><a href="${esc(
           live.url,
         )}" data-full>Watch ${esc(live.home)} v ${esc(live.away)}</a></p>`,
        )
        .join('')}
    `);
    repoll(() => void front(), 3000);
    return;
  }

  const recent = data.recent.map((card) => ({ ...card, state: 'played' }));
  const denied = new URLSearchParams(location.search).get('denied');
  view.innerHTML = h(`
    ${denied ? `<div class="error">Your account may not open that page.</div>` : ''}
    <h1>${esc(data.tournament.name)}</h1>
    <p class="dim">${data.tournament.fixturesTotal} fixtures.</p>

    <h2>On now</h2>
    ${
      data.live.length
        ? data.live
            .map(
              (live) => `${liveScoreline(live)}
           <p style="margin-top:.6rem;margin-bottom:1.4rem"><a href="${esc(live.url)}" data-full>Watch ${esc(
             live.home,
           )} v ${esc(live.away)}</a></p>`,
            )
            .join('')
        : data.next
          ? `<div class="empty">Nothing is on. Next up is ${esc(data.next.home)} against ${esc(data.next.away)}.</div>`
          : `<div class="empty">Nothing is on, and every fixture has been played.</div>`
    }

    <h2>Next</h2>
    ${
      data.upcoming.length
        ? `<div class="rows">${data.upcoming.map(fixtureRow).join('')}</div>`
        : `<div class="empty">Nothing left to play.</div>`
    }

    <h2>Played</h2>
    ${
      data.recent.length
        ? `<div class="rows">${recent.map(fixtureRow).join('')}</div>`
        : `<div class="empty">No fixture has finished yet.</div>`
    }

    <h2>Table</h2>
    ${table(data.table)}
  `);

  // A live score that does not move is worse than no live score at all.
  if (data.live.length) repoll(() => void front(), 3000);
}

function table(rows: Standing[]): string {
  if (rows.length === 0) return `<div class="empty">Nothing played yet.</div>`;
  return h(`
    <table>
      <thead><tr><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>F</th><th>A</th><th>Pts</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (row) => `<tr>
              <td><a href="/t/${encodeURIComponent(slug(row.name))}">${esc(row.name)}</a></td>
              <td>${row.played}</td><td>${row.won}</td><td>${row.drawn}</td><td>${row.lost}</td>
              <td>${row.for}</td><td>${row.against}</td><td class="points">${row.points}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  `);
}

/** The same slugging the server does, so a link lands on the right team. */
function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'team'
  );
}

async function schedule(): Promise<void> {
  const data = await api<{ tournament: { name: string } | null; fixtures: Card[] }>('/api/schedule');
  if (!data.tournament) {
    view.innerHTML = h(`<h1>Schedule</h1><div class="empty">No tournament is loaded.</div>`);
    return;
  }
  view.innerHTML = h(`
    <h1>Schedule</h1>
    <p class="dim">${esc(data.tournament.name)}</p>
    <div class="rows">${data.fixtures.map(fixtureRow).join('')}</div>
  `);
}

async function standings(): Promise<void> {
  const data = await api<{ tournament: { name: string } | null; table: Standing[] }>('/api/standings');
  view.innerHTML = h(`
    <h1>Table</h1>
    <p class="dim">${data.tournament ? esc(data.tournament.name) : 'No tournament is loaded.'}</p>
    ${table(data.table)}
  `);
}

async function teamPage(teamSlug: string): Promise<void> {
  interface TeamData {
    team: { displayName: string } | null;
    fixtures: Card[];
    table: Standing | null;
  }
  const data = await api<TeamData>(`/api/team/${encodeURIComponent(teamSlug)}`);
  if (!data.team) {
    view.innerHTML = h(`<h1>Unknown team</h1><p class="dim">Nobody by that name is in this tournament.</p>`);
    return;
  }
  view.innerHTML = h(`
    <h1>${esc(data.team.displayName)}</h1>
    ${
      data.table
        ? `<p class="dim">${data.table.played} played, ${data.table.points} points,
             ${data.table.for} scored and ${data.table.against} conceded.</p>`
        : `<p class="dim">Has not played yet.</p>`
    }
    <h2>Fixtures</h2>
    ${data.fixtures.length ? `<div class="rows">${data.fixtures.map(fixtureRow).join('')}</div>` : `<div class="empty">None.</div>`}
  `);
}

/**
 * One match.
 *
 * Everything on this page was already being written before Phase 6 existed:
 * the seed each leg played on, the sha256 of the code that was in each seat,
 * and the referee event log kept whole rather than the sixty-entry ring buffer
 * the console's banner uses. A timeline is that log, printed.
 */
interface RobotStat {
  goals: number;
  saves: number;
  shots: number;
  penalties: number;
}

interface MatchLegData {
  seed: unknown;
  score: { violet: number; lime: number };
  clock: number;
  goals?: { team: 'violet' | 'lime'; at: number; half?: 1 | 2; robotId?: string }[];
  calls?: Record<string, number>;
  events: { at: number; kind: string; rule: string; message: string; team?: 'violet' | 'lime'; robotId?: string }[];
  refereeActions?: { action: string; at: number; detail?: string }[];
  robotStats?: Record<string, RobotStat>;
}

interface MatchRecordData {
  completedAt: string;
  submissions: Record<string, string>;
  verdict: {
    homeLegsWon?: number;
    awayLegsWon?: number;
    drawnLegs?: number;
    homeGoals: number;
    awayGoals: number;
    outcome: string;
  };
  legs: MatchLegData[];
}

interface MatchData {
  ok: boolean;
  reason?: string;
  fixture: { id?: string; home: string; away: string };
  state: string;
  live: Live | null;
  record: MatchRecordData | null;
}

interface RobotSummary {
  id: string;
  number: number;
  team: 'violet' | 'lime';
  teamName: string;
  role: string;
  goals: number;
  saves: number;
  shots: number;
  penalties: number;
}

interface ProcessedStats {
  winnerSide: 'violet' | 'lime' | null;
  winnerName: string | null;
  outcomeTitle: string;
  homeGoals: number;
  awayGoals: number;
  homeLegsWon: number;
  awayLegsWon: number;
  drawnLegs: number;
  robots: RobotSummary[];
  topScorer: { robot: RobotSummary; count: number } | null;
  topKeeper: { robot: RobotSummary; count: number } | null;
  topShooter: { robot: RobotSummary; count: number } | null;
  teamMetrics: {
    name: string;
    home: number;
    away: number;
  }[];
  goalsTimeline: { team: 'violet' | 'lime'; at: number; half: number; robotId?: string }[];
}

function processMatchStats(record: MatchRecordData, fixture: { home: string; away: string }): ProcessedStats {
  const v = record.verdict;
  let homeLegsWon = v.homeLegsWon ?? 0;
  let awayLegsWon = v.awayLegsWon ?? 0;
  let drawnLegs = v.drawnLegs ?? 0;

  if (v.homeLegsWon === undefined && record.legs.length > 0) {
    homeLegsWon = 0;
    awayLegsWon = 0;
    drawnLegs = 0;
    for (const leg of record.legs) {
      if (leg.score.violet > leg.score.lime) homeLegsWon++;
      else if (leg.score.lime > leg.score.violet) awayLegsWon++;
      else drawnLegs++;
    }
  }

  const winnerSide: 'violet' | 'lime' | null =
    v.outcome === 'won' ? 'violet' : v.outcome === 'lost' ? 'lime' : null;
  const winnerName = winnerSide === 'violet' ? fixture.home : winnerSide === 'lime' ? fixture.away : null;
  const outcomeTitle = winnerName ? `${winnerName} Victory` : 'Match Drawn';

  const robots: Record<string, RobotSummary> = {
    'violet-1': { id: 'violet-1', number: 1, team: 'violet', teamName: fixture.home, role: 'Striker', goals: 0, saves: 0, shots: 0, penalties: 0 },
    'violet-2': { id: 'violet-2', number: 2, team: 'violet', teamName: fixture.home, role: 'Goalie', goals: 0, saves: 0, shots: 0, penalties: 0 },
    'lime-1': { id: 'lime-1', number: 1, team: 'lime', teamName: fixture.away, role: 'Striker', goals: 0, saves: 0, shots: 0, penalties: 0 },
    'lime-2': { id: 'lime-2', number: 2, team: 'lime', teamName: fixture.away, role: 'Goalie', goals: 0, saves: 0, shots: 0, penalties: 0 },
  };

  let homeRestarts = 0;
  let awayRestarts = 0;
  let homeCleanSheets = 0;
  let awayCleanSheets = 0;
  let homeMultDef = 0;
  let awayMultDef = 0;
  const goalsTimeline: { team: 'violet' | 'lime'; at: number; half: number; robotId?: string }[] = [];

  for (const leg of record.legs) {
    if (leg.score.lime === 0) homeCleanSheets++;
    if (leg.score.violet === 0) awayCleanSheets++;

    if (leg.robotStats) {
      for (const [id, s] of Object.entries(leg.robotStats)) {
        if (robots[id]) {
          robots[id].goals += s.goals ?? 0;
          robots[id].saves += s.saves ?? 0;
          robots[id].shots += s.shots ?? 0;
          robots[id].penalties += s.penalties ?? 0;
        }
      }
    }

    if (leg.goals && leg.goals.length > 0) {
      for (const g of leg.goals) {
        goalsTimeline.push({
          team: g.team,
          at: g.at,
          half: g.half ?? (g.at > leg.clock / 2 ? 2 : 1),
          robotId: g.robotId,
        });
        if (!leg.robotStats) {
          const targetId = g.robotId ?? (g.team === 'violet' ? 'violet-1' : 'lime-1');
          if (robots[targetId]) robots[targetId].goals++;
        }
      }
    } else {
      for (const e of leg.events) {
        if (e.kind === 'goal' && e.team) {
          goalsTimeline.push({
            team: e.team,
            at: e.at,
            half: e.at > leg.clock / 2 ? 2 : 1,
            robotId: e.robotId,
          });
          if (!leg.robotStats) {
            const targetId = e.robotId ?? (e.team === 'violet' ? 'violet-1' : 'lime-1');
            if (robots[targetId]) robots[targetId].goals++;
          }
        }
      }
    }

    for (const e of leg.events) {
      if (e.kind === 'ball-out-of-play' || e.kind === 'kickoff') {
        if (e.team === 'violet') homeRestarts++;
        else if (e.team === 'lime') awayRestarts++;
      }
      if (e.kind === 'possible-multiple-defence') {
        if (e.team === 'violet') homeMultDef++;
        else if (e.team === 'lime') awayMultDef++;
      }
      if (!leg.robotStats && (e.kind === 'possible-damaged' || e.kind === 'illegal-kickoff')) {
        const targetRobot = e.robotId ? robots[e.robotId] : undefined;
        if (targetRobot) {
          targetRobot.penalties++;
        }
      }
    }
  }

  const robotList = Object.values(robots);

  const topScorerRobot = [...robotList].sort((a, b) => b.goals - a.goals)[0];
  const topScorer = topScorerRobot && topScorerRobot.goals > 0
    ? { robot: topScorerRobot, count: topScorerRobot.goals }
    : null;

  const goalies = robotList.filter((r) => r.role === 'Goalie');
  const topKeeperRobot = [...goalies].sort((a, b) => b.saves - a.saves)[0] ?? goalies[0];
  const topKeeper = topKeeperRobot && topKeeperRobot.saves > 0
    ? { robot: topKeeperRobot, count: topKeeperRobot.saves }
    : topKeeperRobot ? { robot: topKeeperRobot, count: 0 } : null;

  const topShooterRobot = [...robotList].sort((a, b) => b.shots - a.shots)[0];
  const topShooter = topShooterRobot && topShooterRobot.shots > 0
    ? { robot: topShooterRobot, count: topShooterRobot.shots }
    : null;

  const totalHomeSaves = (robots['violet-1']?.saves ?? 0) + (robots['violet-2']?.saves ?? 0);
  const totalAwaySaves = (robots['lime-1']?.saves ?? 0) + (robots['lime-2']?.saves ?? 0);
  const totalHomeShots = (robots['violet-1']?.shots ?? 0) + (robots['violet-2']?.shots ?? 0);
  const totalAwayShots = (robots['lime-1']?.shots ?? 0) + (robots['lime-2']?.shots ?? 0);
  const totalHomePenalties = (robots['violet-1']?.penalties ?? 0) + (robots['violet-2']?.penalties ?? 0);
  const totalAwayPenalties = (robots['lime-1']?.penalties ?? 0) + (robots['lime-2']?.penalties ?? 0);

  const teamMetrics = [
    { name: 'Goals Scored', home: v.homeGoals, away: v.awayGoals },
    { name: 'Saves Made', home: totalHomeSaves, away: totalAwaySaves },
    { name: 'Shots Fired', home: totalHomeShots, away: totalAwayShots },
    { name: 'Clean Sheets', home: homeCleanSheets, away: awayCleanSheets },
    { name: 'Stand-downs (§5.7)', home: totalHomePenalties, away: totalAwayPenalties },
    { name: 'Multiple Defence (§5.3)', home: homeMultDef, away: awayMultDef },
    { name: 'Restarts Awarded', home: homeRestarts, away: awayRestarts },
  ];

  return {
    winnerSide,
    winnerName,
    outcomeTitle,
    homeGoals: v.homeGoals,
    awayGoals: v.awayGoals,
    homeLegsWon,
    awayLegsWon,
    drawnLegs,
    robots: robotList,
    topScorer,
    topKeeper,
    topShooter,
    teamMetrics,
    goalsTimeline,
  };
}

/**
 * One match.
 *
 * Full match sheet view with rich post-game summary: outcome banner,
 * final aggregate scoreboard, player accolades (top scorer, top saves),
 * robot roster table, team comparisons, and per-leg timelines.
 */
async function matchPage(fixtureId: string): Promise<void> {
  const data = await api<MatchData>(`/api/match/${encodeURIComponent(fixtureId)}`);
  if (!data.ok) {
    view.innerHTML = h(`<h1>Unknown match</h1><p class="dim">${esc(data.reason ?? '')}</p>`);
    return;
  }

  const head = h(`
    <h1>${esc(data.fixture.home)}<span class="v">v</span>${esc(data.fixture.away)}</h1>
  `);

  // `confirming` is on this branch on purpose: the match is over, the score is
  // final, and the page flips to the full match sheet by itself the moment the
  // referee agrees it. Falling through instead would show "Not played yet"
  // beside a scoreline the hall just watched, and stop refreshing.
  if ((data.state === 'playing' || data.state === 'confirming') && data.live) {
    view.innerHTML = head + h(`
      ${liveScoreline(data.live)}
      ${
        data.state === 'confirming'
          ? `<p class="dim" style="margin-top:1rem">Full time. The result is with the referee.</p>`
          : `<p style="margin-top:1rem"><a href="${esc(data.live.url)}" data-full>Watch the match</a></p>`
      }
    `);
    repoll(() => void matchPage(fixtureId), 3000);
    return;
  }

  // Nothing exists for this fixture yet and that is now a thing somebody chose
  // rather than a thing the schedule has not reached. Worth saying: a team
  // standing at a pitch is owed the difference between "not yet" and "we are
  // waiting for your referee".
  if (data.state === 'due' || data.state === 'opening') {
    view.innerHTML =
      head +
      h(`<div class="empty">${
        data.state === 'due'
          ? 'Waiting for the referee to open this match.'
          : 'The referee has opened this match — the pitch is coming up.'
      }</div>`);
    repoll(() => void matchPage(fixtureId), 3000);
    return;
  }

  if (!data.record) {
    view.innerHTML = head + h(`<div class="empty">Not played yet.</div>`);
    return;
  }

  const record = data.record;
  const stats = processMatchStats(record, data.fixture);

  view.innerHTML = head + h(`
    <!-- Match Summary Hero Card -->
    <div class="match-summary-card ${stats.winnerSide ? `winner-${stats.winnerSide}` : 'is-draw'}">
      <div class="summary-top-banner">
        <div class="verdict-badge ${stats.winnerSide ? `badge-${stats.winnerSide}` : 'badge-draw'}">
          ${stats.winnerSide
            ? `<span class="badge-icon">🏆</span> <span class="badge-text">${esc(stats.outcomeTitle)}</span>`
            : `<span class="badge-icon">🤝</span> <span class="badge-text">Match Drawn</span>`
          }
        </div>
        <span class="completed-label">${
          record.legs.length > 1
            ? `${stats.homeLegsWon}&ndash;${stats.awayLegsWon} legs (${stats.drawnLegs} drawn) &middot; ${esc(when(record.completedAt))}`
            : `Full Time &middot; ${esc(when(record.completedAt))}`
        }</span>
      </div>

      <div class="summary-hero-score">
        <div class="hero-team home violet">
          <div class="team-bar"></div>
          <div class="team-meta">
            <span class="team-role">Home &middot; Violet</span>
            <a href="/t/${encodeURIComponent(slug(data.fixture.home))}" class="team-title">${esc(data.fixture.home)}</a>
            ${record.legs.length > 1 ? `<span class="legs-won-tag">${stats.homeLegsWon} legs won</span>` : ''}
          </div>
          <div class="hero-goals">${stats.homeGoals}</div>
        </div>

        <div class="hero-center">
          <span class="ft-pill">FT</span>
          <span class="vs-dash">&ndash;</span>
          <span class="total-legs">${record.legs.length} ${record.legs.length === 1 ? 'leg' : 'legs'}</span>
        </div>

        <div class="hero-team away lime">
          <div class="hero-goals">${stats.awayGoals}</div>
          <div class="team-meta">
            <span class="team-role">Away &middot; Lime</span>
            <a href="/t/${encodeURIComponent(slug(data.fixture.away))}" class="team-title">${esc(data.fixture.away)}</a>
            ${record.legs.length > 1 ? `<span class="legs-won-tag">${stats.awayLegsWon} legs won</span>` : ''}
          </div>
          <div class="team-bar"></div>
        </div>
      </div>

      ${stats.goalsTimeline.length ? `
        <div class="summary-goals-strip">
          <span class="goals-strip-label">Goals</span>
          <div class="goals-chips">
            ${stats.goalsTimeline
              .map(
                (g) =>
                  `<span class="goal-chip ${g.team}">
                    <span class="chip-ball">⚽</span>
                    <span class="chip-time">${clock(g.at)}</span>
                    <span class="chip-team">${g.team === 'violet' ? esc(data.fixture.home) : esc(data.fixture.away)}</span>
                    ${g.robotId ? `<span class="chip-robot">#${g.robotId.slice(g.robotId.lastIndexOf('-') + 1)}</span>` : ''}
                  </span>`,
              )
              .join('')}
          </div>
        </div>
      ` : ''}
    </div>

    <!-- Player Accolades / Spotlights -->
    <h2>Player Spotlights</h2>
    <div class="accolades-grid">
      <div class="accolade-card top-scorer">
        <div class="accolade-header">
          <span class="accolade-icon">⚽</span>
          <span class="accolade-category">Most Goals Scored</span>
        </div>
        <div class="accolade-body">
          ${stats.topScorer ? `
            <div class="accolade-who">
              <span class="robot-pill ${stats.topScorer.robot.team}">${stats.topScorer.robot.team === 'violet' ? 'Violet' : 'Lime'} ${stats.topScorer.robot.number}</span>
              <span class="team-name">${esc(stats.topScorer.robot.teamName)}</span>
            </div>
            <div class="accolade-stat">
              <span class="stat-number">${stats.topScorer.count}</span>
              <span class="stat-unit">${stats.topScorer.count === 1 ? 'goal' : 'goals'}</span>
            </div>
          ` : `
            <span class="accolade-empty">No goals scored</span>
          `}
        </div>
      </div>

      <div class="accolade-card top-keeper">
        <div class="accolade-header">
          <span class="accolade-icon">🧤</span>
          <span class="accolade-category">Most Goals Saved</span>
        </div>
        <div class="accolade-body">
          ${stats.topKeeper ? `
            <div class="accolade-who">
              <span class="robot-pill ${stats.topKeeper.robot.team}">${stats.topKeeper.robot.team === 'violet' ? 'Violet' : 'Lime'} ${stats.topKeeper.robot.number}</span>
              <span class="team-name">${esc(stats.topKeeper.robot.teamName)}</span>
              <span class="role-badge">${esc(stats.topKeeper.robot.role)}</span>
            </div>
            <div class="accolade-stat">
              <span class="stat-number">${stats.topKeeper.count}</span>
              <span class="stat-unit">${stats.topKeeper.count === 1 ? 'save' : 'saves'}</span>
            </div>
          ` : `
            <span class="accolade-empty">No saves recorded</span>
          `}
        </div>
      </div>

      <div class="accolade-card top-shooter">
        <div class="accolade-header">
          <span class="accolade-icon">🎯</span>
          <span class="accolade-category">Most Shots Fired</span>
        </div>
        <div class="accolade-body">
          ${stats.topShooter ? `
            <div class="accolade-who">
              <span class="robot-pill ${stats.topShooter.robot.team}">${stats.topShooter.robot.team === 'violet' ? 'Violet' : 'Lime'} ${stats.topShooter.robot.number}</span>
              <span class="team-name">${esc(stats.topShooter.robot.teamName)}</span>
            </div>
            <div class="accolade-stat">
              <span class="stat-number">${stats.topShooter.count}</span>
              <span class="stat-unit">${stats.topShooter.count === 1 ? 'shot' : 'shots'}</span>
            </div>
          ` : `
            <span class="accolade-empty">No shots recorded</span>
          `}
        </div>
      </div>
    </div>

    <!-- Full Robot Performance Table -->
    <h2>Robot Performance</h2>
    <div class="table-container">
      <table class="robot-table">
        <thead>
          <tr>
            <th>Robot</th>
            <th>Team</th>
            <th>Role</th>
            <th>Goals</th>
            <th>Saves</th>
            <th>Shots</th>
            <th>Penalties (§5.7)</th>
          </tr>
        </thead>
        <tbody>
          ${stats.robots
            .map(
              (r) => `
            <tr class="robot-row ${r.team}">
              <td class="robot-col">
                <span class="robot-badge ${r.team}">
                  <span class="badge-dot"></span>
                  ${r.team === 'violet' ? 'Violet' : 'Lime'} ${r.number}
                </span>
              </td>
              <td class="team-col">${esc(r.teamName)}</td>
              <td class="role-col"><span class="role-pill ${r.role.toLowerCase()}">${esc(r.role)}</span></td>
              <td class="num-col ${r.goals > 0 ? 'top-stat' : ''}">${r.goals}</td>
              <td class="num-col ${r.saves > 0 ? 'top-stat' : ''}">${r.saves}</td>
              <td class="num-col">${r.shots}</td>
              <td class="num-col ${r.penalties > 0 ? 'warn-stat' : ''}">${r.penalties}</td>
            </tr>
          `,
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <!-- Team Comparison Metrics -->
    <h2>Team Comparison</h2>
    <div class="team-comparison-card">
      <div class="comparison-header">
        <span class="side-title violet">${esc(data.fixture.home)}</span>
        <span class="metric-title">Metric</span>
        <span class="side-title lime">${esc(data.fixture.away)}</span>
      </div>
      ${stats.teamMetrics
        .map((m) => {
          const sum = m.home + m.away;
          const homePct = sum === 0 ? 50 : Math.round((m.home / sum) * 100);
          const awayPct = 100 - homePct;
          return `
          <div class="comparison-row">
            <span class="row-val violet ${m.home > m.away ? 'is-lead' : ''}">${m.home}</span>
            <div class="row-center">
              <span class="row-label">${esc(m.name)}</span>
              <div class="ratio-bar">
                <div class="fill violet" style="width: ${homePct}%"></div>
                <div class="fill lime" style="width: ${awayPct}%"></div>
              </div>
            </div>
            <span class="row-val lime ${m.away > m.home ? 'is-lead' : ''}">${m.away}</span>
          </div>
        `;
        })
        .join('')}
    </div>

    <!-- Fixture Legs Timeline & Code -->
    <h2>Fixture Legs</h2>
    ${record.legs
      .map(
        (leg, index) => `
        <div class="leg-card">
          <div class="leg-card-header">
            <span class="leg-badge">Leg ${index + 1}</span>
            <span class="leg-score">${esc(data.fixture.home)} ${leg.score.violet} &ndash; ${leg.score.lime} ${esc(data.fixture.away)}</span>
            <span class="leg-clock">${clock(leg.clock)}</span>
          </div>
          <p class="dim" style="margin: 0.3rem 0 0.8rem">
            Played on seed <span class="mono">${esc(seedText(leg.seed))}</span>. Replaying that seed replays this match.
          </p>
          <div class="timeline">
            ${
              leg.events.length
                ? leg.events
                    .map(
                      (event) =>
                        `<div>
                           <span class="at">${clock(event.at)}</span>
                           <span class="rule">${esc(event.rule)}</span>
                           <span class="grow">${esc(event.message)}</span>
                         </div>`,
                    )
                    .join('')
                : '<span class="dim">No calls.</span>'
            }
          </div>
        </div>`,
      )
      .join('')}

    <h2>The code that played</h2>
    <div class="hashes">
      ${
        Object.keys(record.submissions).length
          ? Object.entries(record.submissions)
              .map(([seat, hash]) => `<div><span class="seat">${esc(seat)}</span><span>${esc(hash)}</span></div>`)
              .join('')
          : '<span class="dim">Both sides were the built-in reference agent.</span>'
      }
    </div>
  `);
}

// ------------------------------------------------------------------ accounts

/** Where a sign-in ends up: where they were going, or the area their role is for. */
function home(): string {
  if (me.can.admin) return '/admin';
  if (me.can.referee) return '/referee/';
  return '/team';
}

async function login(): Promise<void> {
  const asked = new URLSearchParams(location.search).get('next');
  view.innerHTML = h(`
    <h1>Sign in</h1>
    <form class="panel" id="form">
      <label for="name">Your team or your name</label>
      <input id="name" autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" />
      <button class="primary" type="submit">Sign in</button>
      <div class="error" id="error" hidden></div>
      <span class="dim">Have an invitation code? <a href="/register">Register</a>.</span>
    </form>
  `);

  form('#form', async () => {
    const body = JSON.stringify({
      name: value('#name'),
      password: value('#password'),
    });
    const res = await api<{ ok: boolean; reason?: string }>('/auth/login', { method: 'POST', body });
    if (!res.ok) return res.reason ?? 'that did not work';
    // `me` is refreshed by `go`, so ask it where to send them afterwards.
    me = await api<Me>('/api/me');
    const next = asked ?? home();
    // A referee's own pages are this bundle now; only an arena's console is
    // somewhere else, and nothing sends anybody straight there.
    await go(next);
    return null;
  });
}

async function register(): Promise<void> {
  view.innerHTML = h(`
    <h1>Register</h1>
    <p class="dim">
      Registration is by invitation: your organiser gives you a code, and it works once.
      A team's name is set by the invitation, so nobody can register as somebody else.
    </p>
    <form class="panel" id="form">
      <label for="code">Invitation code</label>
      <input id="code" autocomplete="off" spellcheck="false" />
      <label for="name">Your name <span class="dim">(referees and organisers only)</span></label>
      <input id="name" autocomplete="off" />
      <label for="password">Choose a password</label>
      <input id="password" type="password" autocomplete="new-password" />
      <button class="primary" type="submit">Register</button>
      <div class="error" id="error" hidden></div>
    </form>
  `);

  form('#form', async () => {
    const body = JSON.stringify({
      code: value('#code'),
      name: value('#name'),
      password: value('#password'),
    });
    const res = await api<{ ok: boolean; reason?: string }>('/auth/register', { method: 'POST', body });
    if (!res.ok) return res.reason ?? 'that did not work';
    await go('/team');
    return null;
  });
}

/** What a team's own dashboard is told that the public team page is not. */
/** The break between the halves, as every screen here reads it. */
interface HalfTime {
  since: string;
  seconds: number;
  remaining: number;
  ready: { violet: boolean; lime: boolean };
  over: boolean;
}

interface Yours {
  fields: {
    id: string;
    url: string;
    guests: string[];
    invited: string[];
    /** Set when nobody has used it for a while and it is about to be given back. */
    closingAt: string | null;
  }[];
  guestOf: { id: string; url: string; owner: string | null }[];
  invitations: { arenaId: string; from: string }[];
  robots: {
    number: number;
    at: {
      seatId: string;
      arenaId: string;
      owner: string | null;
      url: string;
      /** In a match rather than on somebody's practice field. */
      fixture: boolean;
    } | null;
  }[];
  queue: { position: number; ahead: number; offer: { until: string } | null } | null;
  perTeam: number;
  /** The match this team is about to play, from `due` onwards. */
  match: {
    id: string;
    home: string;
    away: string;
    state: string;
    arrived: boolean;
    /** When the referee fixed what plays, or `null` while a push still counts. */
    lockedAt: string | null;
    /**
     * The break between the halves, while their own match is in one.
     *
     * The one moment during a match this block exists at all: their screen
     * goes quiet at kick-off, because until half-time there is nothing they
     * can do, and comes back for exactly as long as there is.
     */
    halfTime: HalfTime | null;
    /** Which side they are playing, so they can read the register above. */
    side: 'violet' | 'lime';
    seats: Seat[];
  } | null;
}

/**
 * A team's one screen.
 *
 * Phase 6's version answered the two questions a team had then — where is my
 * code, and when do I play. Phase 8 adds the third, which is the one they ask
 * all day at a venue: *where is my robot right now*. It has exactly one
 * answer, because a robot is in one place; that is the whole reason the rule
 * is worth enforcing rather than merely counting.
 *
 * Phase 10 adds the fourth, which is the one they ask while they are still
 * typing: *run this*. It is one press from here and one from the editor,
 * because a loop measured in seconds cannot afford a page in between.
 */
async function dashboard(): Promise<void> {
  if (!me.account) return void go('/login?next=%2Fteam');
  const mine = me.account;
  const data = await api<{ fixtures: Card[]; table: Standing | null; yours?: Yours }>(
    `/api/team/${encodeURIComponent(mine.slug)}`,
  );

  // A referee or an organiser has no robots. Showing them "your code" invites
  // them to look for a workspace that does not exist and never will.
  if (mine.role !== 'team') {
    view.innerHTML = h(`
      <h1>${esc(mine.displayName)}</h1>
      <p class="dim">Signed in as ${esc(mine.role === 'admin' ? 'an organiser' : 'a referee')}.</p>
      <div class="rows">
        ${me.can.referee ? `<a class="row" href="/referee/" data-full><span class="grow">Referee console</span><span class="state">control a match</span></a>` : ''}
        ${me.can.admin ? `<a class="row" href="/admin"><span class="grow">Administration</span><span class="state">accounts and invitations</span></a>` : ''}
      </div>
    `);
    return;
  }

  view.innerHTML = h(`
    <h1>${esc(mine.displayName)}</h1>
    <p class="dim">Signed in as a team.</p>

    <h2>Your code</h2>
    <div class="rows">
      ${
        me.can.workspace
          ? `<a class="row" href="/workspace/" data-full>
               <span class="grow">Write your robot in the browser</span>
               <span class="state">editor</span>
             </a>`
          : ''
      }
      <div class="row">
        <span class="grow">Push from a laptop with
          <span class="mono">python3 python/submit.py --key &lt;your key&gt;</span></span>
        <a href="/team/settings">Keys</a>
      </div>
    </div>

    ${data.yours?.match ? nextMatchSection(data.yours.match) : ''}

    ${data.yours ? practiceSection(data.yours) : ''}

    <h2>Your fixtures</h2>
    ${data.fixtures.length ? `<div class="rows">${data.fixtures.map(fixtureRow).join('')}</div>` : `<div class="empty">You are not in the current draw.</div>`}
  `);

  if (data.yours) wirePractice(mine.slug, data.yours);

  const match = data.yours?.match ?? null;
  if (match) {
    document.getElementById('arrive')?.addEventListener('click', () => {
      const button = document.getElementById('arrive') as HTMLButtonElement;
      button.disabled = true;
      void (async () => {
        const res = await api<{ ok: boolean; reason?: string; notice?: string }>(
          `/api/team/match/${encodeURIComponent(match.id)}/arrive`,
          { method: 'POST' },
        );
        // A robot left on a practice field is the refusal worth reading, and
        // the hub phrases it — it is the only thing that knows which field.
        if (!res.ok && res.reason) alert(res.reason);
        else if (res.notice) alert(res.notice);
        await go('/team', true);
      })();
    });

    // Half-time's one button. The whistle is waiting on it, so it says so on
    // itself the moment it is pressed rather than after the next poll.
    document.getElementById('ready')?.addEventListener('click', () => {
      const button = document.getElementById('ready') as HTMLButtonElement;
      button.disabled = true;
      button.textContent = 'Told the referee';
      void (async () => {
        const res = await api<{ ok: boolean; reason?: string }>(
          `/api/team/match/${encodeURIComponent(match.id)}/ready`,
          { method: 'POST' },
        );
        if (!res.ok && res.reason) alert(res.reason);
        await go('/team', true);
      })();
    });

    // So a team can leave this open and watch their pitch come up. Quickly at
    // half-time, where five minutes are running out under a clock on the
    // screen; slowly otherwise, because the part that moves is one row.
    repoll(() => void dashboard(), match.halfTime ? 2000 : 5000);
  }
}

/**
 * The match this team is about to play, and the one button they press for it.
 *
 * Above practice on purpose: when this block exists it is the most important
 * thing on the screen, and everything below it is about to be taken away from
 * them anyway — a fixture pre-empts practice, and both their robots are needed
 * here.
 *
 * Arriving is offered from *due* onwards rather than only once a pitch is
 * free, because that is how a hall works: teams turn up and wait, and a referee
 * opening the pitch should find them already standing there. The hub holds the
 * arrival against the fixture and seats the robots by itself when the arena
 * comes up.
 */
function nextMatchSection(match: NonNullable<Yours['match']>): string {
  const waiting = match.state === 'due' || match.state === 'opening';
  const stuck = match.seats.some((seat) => seat.program === 'would-not-start');
  // Half-time is a different screen, not a different sentence on this one.
  // Nothing else on this block is true during a match: they have arrived, the
  // lineup is locked, and the only question left is whether they are ready.
  if (match.halfTime) return halfTimeSection(match, match.halfTime);
  return h(`
    <h2>Your next match</h2>
    <div class="rows">
      <div class="row">
        <span class="grow">${esc(match.home)}<span class="v">v</span>${esc(match.away)}</span>
        <span class="state">${esc(PUBLIC_STATE[match.state] ?? match.state)}</span>
      </div>
    </div>
    ${match.arrived ? seatRows(match.seats) : ''}
    <p class="dim" style="margin-top:0.75rem">${
      // The locked sentence comes before every other one, because once it is
      // true it changes what all of them mean: a stuck robot can no longer be
      // fixed by pushing, and a push made now is for the game after this.
      match.lockedAt
        ? 'The referee has locked the lineup. This is the code that plays &mdash; a push now is for your next game, and pressing the button below restarts the locked code, not the new one.'
        : match.arrived
          ? waiting
            ? 'You are on the list. Your robots take their seats the moment the referee opens the pitch.'
            : stuck
              ? 'Your program is not running. Push a fix and press the button again &mdash; only a robot that is not on the field is started over.'
              : 'You are at the pitch, and your robots are running on it. The referee starts the match when both teams are ready.'
          : 'Say you are here and your robots are taken off every practice field, put in their seats for this match, and started.'
    }</p>
    <p style="margin-top:0.75rem"><button id="arrive">${
      // The same button, because to a team it is the same act: this is where
      // we are. Pressing it again is how a robot that would not start gets
      // started again, and one that is already on the field is left alone.
      match.arrived ? 'Start my robots again' : 'We&rsquo;re here'
    }</button></p>
  `);
}

/**
 * Half-time, from the team's side of the hall.
 *
 * Five minutes and one decision. A push made now is not refused and not
 * hopeless — it reaches the second half if the referee takes it in — so this
 * says who has to do what, in the order it has to happen: fix it, watch the
 * robot come back up, then tell the referee.
 *
 * The clock is the server's own `remaining`, redrawn on the poll rather than
 * ticked locally: a countdown that runs on this laptop's clock is a countdown
 * that disagrees with the referee's, and the whole point of it is that they
 * are looking at the same number.
 */
function halfTimeSection(match: NonNullable<Yours['match']>, halfTime: HalfTime): string {
  const left = Math.ceil(halfTime.remaining);
  const ready = halfTime.ready[match.side];
  const other = match.side === 'violet' ? 'lime' : 'violet';
  return h(`
    <h2>Half-time</h2>
    <div class="rows">
      <div class="row">
        <span class="grow">${esc(match.home)}<span class="v">v</span>${esc(match.away)}</span>
        <span class="state">${
          halfTime.over
            ? 'time is up'
            : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`
        }</span>
      </div>
    </div>
    ${seatRows(match.seats)}
    <p class="dim" style="margin-top:0.75rem">${
      ready
        ? halfTime.ready[other]
          ? 'Both teams are ready. The referee restarts when they are.'
          : 'You have told the referee you are ready. They kick off once the other team has too, or when the clock runs out.'
        : 'This is the one window where you can change your code. Push a fix, wait for your robot to come back up, then say you are ready &mdash; the referee takes every new push in at once when they lock the lineup again.'
    }</p>
    <p style="margin-top:0.75rem"><button id="ready"${ready ? ' disabled' : ''}>${
      ready ? 'You said you are ready' : 'We&rsquo;re ready'
    }</button></p>
  `);
}

/**
 * The practice half of a team's screen.
 *
 * Three questions in the order they get asked at a venue: have I got a field,
 * where are my two robots, and is anybody waiting on me. Each robot gets a row
 * whether or not it is anywhere — an empty row is an answer, and a robot
 * missing from a list is not.
 */
function practiceSection(yours: Yours): string {
  const field = yours.fields[0];
  const offered = yours.queue?.offer ?? null;

  const robots = yours.robots
    .map((robot) => {
      // Run is offered against a robot that is nowhere, because that is exactly
      // when a team wants it: the code is written and nothing is watching it.
      if (!robot.at) {
        return `<div class="row">
          <span class="grow">Robot ${robot.number}</span>
          <span class="state">not in a seat</span>
          <button data-run="${robot.number}">Run it</button>
        </div>`;
      }
      // A robot in a fixture's seat is not on anybody's field, and sending a
      // team to a practice page that does not exist is worse than not linking.
      const where = robot.at.fixture
        ? 'in your match'
        : `on ${robot.at.owner === null ? 'a field' : `${esc(robot.at.owner)}'s field`}`;
      return `<div class="row">
        <span class="grow">Robot ${robot.number} — in ${esc(robot.at.seatId)} ${where}</span>
        <a href="${esc(robot.at.url)}" data-full>${robot.at.fixture ? 'Watch' : 'Open'}</a>
      </div>`;
    })
    .join('');

  const guest = yours.guestOf
    .map(
      (one) => `<div class="row">
        <span class="grow">A guest on ${esc(one.owner ?? 'another team')}'s field</span>
        <a href="${esc(one.url)}" data-full>Open</a>
        <button class="quiet" data-leave="${esc(one.id)}">Leave</button>
      </div>`,
    )
    .join('');

  const invitations = yours.invitations
    .map(
      (one) => `<div class="row">
        <span class="grow">${esc(one.from)} has invited you onto their practice field</span>
        <button data-accept="${esc(one.arenaId)}">Accept</button>
        <button class="quiet" data-decline="${esc(one.arenaId)}">No thanks</button>
      </div>`,
    )
    .join('');

  const yourField = field
    ? `<div class="row">
         <span class="grow">Your practice field${field.guests.length ? ` — with ${field.guests.map(esc).join(', ')}` : ''}</span>
         <a href="${esc(field.url)}" data-full>Open</a>
         <button class="quiet" id="close-field">Close</button>
       </div>
       ${
         field.closingAt
           ? `<div class="row">
                <span class="grow">Nobody has used it for a while — it closes at
                ${esc(new Date(field.closingAt).toLocaleTimeString())} unless you go back to it.
                Your arrangement is kept either way.</span>
                <a href="${esc(field.url)}" data-full>Keep it</a>
              </div>`
           : ''
       }
       <div class="row">
         <span class="grow"><input id="invite-team" placeholder="invite a team by name" /></span>
         <button id="invite">Invite</button>
       </div>
       ${field.invited.length ? `<div class="row"><span class="grow dim">Waiting on ${field.invited.map(esc).join(', ')}</span></div>` : ''}`
    : offered
      ? `<div class="row">
           <span class="grow">A field is being held for you until ${esc(new Date(offered.until).toLocaleTimeString())}</span>
           <button id="claim-field">Claim it</button>
         </div>`
      : yours.queue
        ? `<div class="row">
             <span class="grow">You are number ${yours.queue.position} in the queue for a field${yours.queue.ahead ? ` — ${yours.queue.ahead} ahead of you` : ''}</span>
             <button class="quiet" id="leave-queue">Give up my place</button>
           </div>`
        : `<div class="row">
             <span class="grow">You have no practice field open</span>
             <button id="open-field">Open one</button>
           </div>`;

  return `
    <h2>Your practice field</h2>
    <div class="rows">${yourField}${guest}</div>
    ${invitations ? `<h2>Invitations</h2><div class="rows">${invitations}</div>` : ''}

    <h2>Your robots</h2>
    <div class="rows">${robots}</div>
    <p class="dim">Each of your two robots can be in one seat at a time, anywhere on this server.</p>
  `;
}

/**
 * The buttons under the practice section.
 *
 * Every one of them ends in `go('/team', true)`, because the answer to all of
 * them is a changed dashboard and re-asking the server is cheaper than keeping
 * a second copy of the truth in the page. A refusal is shown as it came — the
 * server writes these to be read by a fifteen-year-old, and rewording them
 * here would be a second voice saying a worse version of it.
 */
function wirePractice(_slug: string, yours: Yours): void {
  const post = async (path: string, body?: unknown): Promise<void> => {
    const res = await api<{ ok: boolean; reason?: string }>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok && res.reason) alert(res.reason);
    await go('/team', true);
  };

  const on = (selector: string, run: () => Promise<void>): void => {
    document.querySelector(selector)?.addEventListener('click', () => void run());
  };

  on('#open-field', () => post('/practice'));
  on('#claim-field', () => post('/practice/claim'));
  on('#leave-queue', () => post('/practice/leave'));
  on('#close-field', () => post(`/api/fields/${yours.fields[0]!.id}/close`));
  on('#invite', () => {
    const input = document.querySelector<HTMLInputElement>('#invite-team');
    const team = input?.value.trim();
    if (!team) {
      input?.focus();
      return Promise.resolve();
    }
    return post(`/api/fields/${yours.fields[0]!.id}/invite`, { team });
  });

  for (const button of document.querySelectorAll<HTMLElement>('[data-run]')) {
    button.addEventListener('click', () => {
      void (async () => {
        const res = await api<{ ok: boolean; reason?: string; field?: { url: string } }>('/practice/run', {
          method: 'POST',
          body: JSON.stringify({ robot: Number(button.dataset['run']) }),
        });
        // Straight to the field it landed on. A refusal — queued, capped,
        // practice closed — is shown as the server phrased it.
        if (res.ok && res.field) location.href = res.field.url;
        else if (res.reason) alert(res.reason);
        else await go('/team', true);
      })();
    });
  }

  for (const button of document.querySelectorAll<HTMLElement>('[data-accept]')) {
    button.addEventListener('click', () => void post(`/api/fields/${button.dataset['accept']}/accept`));
  }
  for (const button of document.querySelectorAll<HTMLElement>('[data-decline]')) {
    button.addEventListener('click', () => void post(`/api/fields/${button.dataset['decline']}/decline`));
  }
  for (const button of document.querySelectorAll<HTMLElement>('[data-leave]')) {
    button.addEventListener('click', () => void post(`/api/fields/${button.dataset['leave']}/leave`));
  }
}

/**
 * The key shown once, held across the one re-render that follows minting it.
 *
 * The list has to be redrawn — a key that does not appear in "your keys" reads
 * as a key that was not made — and the key itself is never fetchable again, so
 * it has to survive that redraw in memory or it is lost the moment it appears.
 */
let freshKey: string | null = null;

async function settings(): Promise<void> {
  if (!me.account) return void go('/login?next=%2Fteam%2Fsettings');
  const data = await api<{ ok: boolean; keys: { id: string; label: string; createdAt: string; revokedAt: string | null }[] }>(
    '/api/keys',
  );

  view.innerHTML = h(`
    <h1>Push keys</h1>
    <p class="dim">
      A key is what <span class="mono">python/submit.py</span> presents so the server knows the push is yours.
      It is shown once, here, when you make it — if you lose it, revoke it and make another.
    </p>

    <form class="panel" id="form">
      <label for="label">What is this key for?</label>
      <input id="label" placeholder="Ada's laptop" />
      <button class="primary" type="submit">Make a key</button>
      <div class="error" id="error" hidden></div>
    </form>

    <div class="note" id="fresh" ${freshKey ? '' : 'hidden'}>
      ${
        freshKey
          ? `Your new key — copy it now, it is not shown again:
             <div class="mono" style="margin-top:.4rem">${esc(freshKey)}</div>`
          : ''
      }
    </div>

    <h2>Your keys</h2>
    ${
      (data.keys ?? []).length
        ? `<div class="rows">${data.keys
            .map(
              (key) => `<div class="row">
                <span class="grow">${esc(key.label)}</span>
                <span class="state">made ${esc(when(key.createdAt))}</span>
                ${
                  key.revokedAt
                    ? `<span class="state">revoked</span>`
                    : `<button class="quiet" data-revoke="${esc(key.id)}">Revoke</button>`
                }
              </div>`,
            )
            .join('')}</div>`
        : `<div class="empty">You have no keys yet.</div>`
    }
  `);

  for (const button of view.querySelectorAll<HTMLButtonElement>('[data-revoke]')) {
    button.addEventListener('click', async () => {
      await api(`/api/keys/${button.dataset.revoke}/revoke`, { method: 'POST' });
      await settings();
    });
  }

  form('#form', async () => {
    const res = await api<{ ok: boolean; reason?: string; key?: string }>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ label: value('#label') }),
    });
    if (!res.ok) return res.reason ?? 'that did not work';
    freshKey = res.key ?? null;
    await settings();
    return null;
  });
}

interface RefereeCard {
  id: string;
  home: string;
  away: string;
  state: string;
  playAt?: string;
  live?: Live;
  console?: string;
  /** The draw no longer has this fixture, but this room is still standing. */
  voided?: boolean;
}

/** What a state is called on a referee's own list. */
const REFEREE_STATE: Record<string, string> = {
  playing: 'on now',
  confirming: 'waiting on you',
  pregame: 'teams arriving',
  opening: 'opening',
  due: 'ready to open',
  upcoming: 'not started',
  played: 'played',
};

/**
 * A referee's day: the matches they have been given.
 *
 * Their assignments rather than whatever happens to be running, so the game
 * they are standing at twenty minutes early is on this page — which is the
 * whole point of a referee having a screen at all. The console itself is not
 * here and cannot be: it lives on the arena playing the match. What is here is
 * a name for each match that does not move.
 */
async function refereeList(): Promise<void> {
  if (!me.can.referee) return void go('/login?next=%2Freferee');
  const { fixtures } = await api<{ fixtures: RefereeCard[] }>('/api/referee/fixtures');

  view.innerHTML = h(`
    <h1>Refereeing</h1>
    ${
      fixtures.length
        ? `<div class="rows">${fixtures
            .map(
              (fixture) => `<a class="row" href="/referee/m/${encodeURIComponent(fixture.id)}">
                ${fixture.playAt ? `<span class="at">${esc(when(fixture.playAt))}</span>` : ''}
                <span class="grow">${esc(fixture.home)} v ${esc(fixture.away)}</span>
                <span class="state">${
                  fixture.voided ? 'voided' : esc(REFEREE_STATE[fixture.state] ?? fixture.state)
                }</span>
              </a>`,
            )
            .join('')}</div>`
        : `<div class="empty">Nothing is assigned to you yet. An organiser puts your games here.</div>`
    }
  `);
  // So a referee can leave this open and watch their game come round.
  if (fixtures.some((one) => one.state !== 'played')) {
    repoll(() => void refereeList(), 5000);
  }
}

/**
 * One match a referee is to run, at a URL that outlives the arena.
 *
 * Openable before there is anything to open — that is the point. An arena id
 * exists only while the match does, so this page is what a referee can be
 * given in advance, and it grows the console link by itself the moment the
 * match is spawned.
 */
async function refereeMatch(fixtureId: string): Promise<void> {
  if (!me.can.referee) return void go(`/login?next=${encodeURIComponent(`/referee/m/${fixtureId}`)}`);
  const data = await api<{
    ok: boolean;
    reason?: string;
    fixture: { id: string; home: string; away: string; playAt?: string };
    state: string;
    /** The draw no longer has this fixture; see `heldButVoided` on the server. */
    voided?: boolean;
    live: Live | null;
    halfTime: HalfTime | null;
    console: string | null;
    seats: Seat[] | null;
    pregame: {
      since: string;
      lockedAt: string | null;
      penalty: {
        available: boolean;
        perMin: number;
        running: boolean;
        since: string | null;
        goals: { violet: number; lime: number };
      };
      autoStartAt: string | null;
      nobodyHere: boolean;
    } | null;
    final: { homeScore: number; awayScore: number } | null;
  }>(`/api/referee/match/${encodeURIComponent(fixtureId)}`);

  if (!data.ok) {
    view.innerHTML = h(`
      <h1>Not your match</h1>
      <p class="dim">${esc(data.reason ?? '')}</p>
      <p><a href="/referee">Back to your games</a></p>
    `);
    return;
  }

  const head = h(`
    <p class="dim"><a href="/referee">Refereeing</a></p>
    <h1>${esc(data.fixture.home)}<span class="v">v</span>${esc(data.fixture.away)}</h1>
    ${data.fixture.playAt ? `<p class="dim">Due ${esc(when(data.fixture.playAt))}.</p>` : ''}
    ${
      // The room outlives the draw that named it, so this page keeps working
      // and says why rather than pretending nothing happened. Nobody pulls a
      // pitch out from under a whistle: ending it is still this referee's.
      data.voided
        ? `<p class="warn">An organiser has taken this fixture out of the draw. Whatever happens
           here will not count. The pitch is still yours &mdash; abandon the match when you are
           ready and it gives the pitch back.</p>`
        : ''
    }
  `);

  // Full time, and nothing is on disk yet. This is the one page in the site that
  // decides something rather than showing it: until a button here is pressed the
  // fixture is not in the table, does not count, and is holding its arena open
  // so the referee can go back and look at the board.
  if (data.state === 'confirming' && data.final) {
    view.innerHTML =
      head +
      h(`
      ${scoreline({
        href: `/m/${encodeURIComponent(data.fixture.id)}`,
        home: data.fixture.home,
        away: data.fixture.away,
        homeGoals: data.final.homeScore,
        awayGoals: data.final.awayScore,
        state: ['full time', 'not recorded yet'],
      })}
      <p class="dim" style="margin-top:1rem">Nothing is written down until you confirm it.</p>
      <p style="margin-top:1rem">
        <button id="confirm-result">Confirm the result</button>
        <button id="replay-match" class="quiet">Play it again</button>
      </p>
      ${data.console ? `<p class="dim"><a href="${esc(data.console)}" data-full>Back to the console</a></p>` : ''}
    `);

    const answer = async (verb: 'confirm' | 'replay'): Promise<void> => {
      const res = await api<{ ok: boolean; reason?: string }>(
        `/api/referee/match/${encodeURIComponent(fixtureId)}/${verb}`,
        { method: 'POST' },
      );
      // Shown as the server phrased it — somebody else confirming it first is
      // the likely refusal, and that is worth reading rather than rewording.
      if (!res.ok && res.reason) alert(res.reason);
      await go(`/referee/m/${encodeURIComponent(fixtureId)}`, true);
    };
    document.getElementById('confirm-result')?.addEventListener('click', () => void answer('confirm'));

    // Two presses, because this one throws away a match that was actually
    // played and it sits next to the button that keeps it. Said on the button
    // itself rather than in a modal — the rest of this site, including the
    // admin's stop-an-arena button, never puts a dialog in front of anybody.
    const replay = document.getElementById('replay-match') as HTMLButtonElement | null;
    let armed = false;
    replay?.addEventListener('click', () => {
      if (armed) return void answer('replay');
      armed = true;
      replay.textContent = 'Press again to discard it';
      // `button.stop` is the danger outline the admin's arena list already uses.
      replay.classList.remove('quiet');
      replay.classList.add('stop');
      // And stop re-rendering: a poll that redrew the page here would disarm
      // the button under the hand that just armed it.
      if (ticking) {
        clearInterval(ticking);
        ticking = null;
      }
    });

    // Slowly, and only so an admin confirming elsewhere is noticed: a re-render
    // under somebody's cursor is how a button gets pressed by accident.
    repoll(() => void refereeMatch(fixtureId), 5000);
    return;
  }

  // The one control in this site that makes a computer start. Until it is
  // pressed nothing exists for this fixture at all — no arena, no robots, no
  // sandboxed interpreters — so this page is where a referee's match begins
  // rather than where it is reported. A button rather than the page load
  // itself: this page is polled, bookmarked and reached with the back button,
  // and none of those should spawn five processes at a venue.
  if (data.state === 'due' || data.state === 'opening') {
    const waiting = data.state === 'opening';
    view.innerHTML =
      head +
      h(`
      <div class="empty">${
        waiting
          ? 'Opening the pitch. This takes a moment &mdash; longer if every pitch at the venue is busy.'
          : 'Nothing is running yet. Opening this starts the pitch and lets both teams take their seats. It does not kick off &mdash; you start the match yourself once they are here.'
      }</div>
      ${waiting ? '' : `<p style="margin-top:1rem"><button id="open-pregame">Open pre-game</button></p>`}
    `);

    const open = document.getElementById('open-pregame') as HTMLButtonElement | null;
    open?.addEventListener('click', () => {
      // No two-press guard, unlike the discard button at full time: this one
      // only ever makes something exist.
      open.disabled = true;
      open.textContent = 'Opening\u2026';
      void (async () => {
        const res = await api<{ ok: boolean; reason?: string }>(
          `/api/referee/match/${encodeURIComponent(fixtureId)}/open`,
          { method: 'POST' },
        );
        if (!res.ok && res.reason) alert(res.reason);
        await go(`/referee/m/${encodeURIComponent(fixtureId)}`, true);
      })();
    });

    // Quickly while a pitch is coming up, because that is about to change;
    // slowly while it is merely due, because a re-render under somebody's
    // cursor is how a button gets pressed by accident.
    repoll(() => void refereeMatch(fixtureId), waiting ? 2000 : 5000);
    return;
  }

  // Pre-game: the pitch is up, nobody has kicked off, and this is the twenty
  // minutes the sport actually has. What it shows is what a referee walking up
  // to a pitch needs to know in one look — is anybody here, and is the code in
  // front of me the code they think they pushed.
  if (data.state === 'pregame' && data.seats) {
    const missing = missingFrom(data.seats);
    const stuck = data.seats
      .filter((seat) => seat.program === 'would-not-start')
      .map((seat) => `${seat.team} robot ${seat.number}`);
    const room = data.pregame;
    const clock = room?.penalty ?? null;
    const owed = clock ? clock.goals.violet + clock.goals.lime : 0;
    view.innerHTML =
      head +
      h(`
      <p class="dim">Pre-game. Nothing is playing yet.</p>
      ${seatRows(data.seats)}
      <p class="dim" style="margin-top:1rem">${
        missing.length
          ? `Still waiting on ${esc(missing.join(' and '))}. You can start anyway &mdash; a team that is not here plays whatever they last pushed.`
          : 'Both teams are here. A team is ready with one robot.'
      }</p>
      ${
        // Said once, plainly, because it is the decision this whole room
        // exists to inform: a robot that will not come up is one the match
        // will be played without, and the team can still fix it from here.
        stuck.length
          ? `<p class="dim">${esc(stuck.join(' and '))} will not start. Starting now plays the match without ${
              stuck.length > 1 ? 'them' : 'it'
            } &mdash; the team can push a fix and say they are here again.</p>`
          : ''
      }
      ${penaltyPanel(data.fixture, room)}
      <p style="margin-top:1rem">
        <button id="lock-lineup">${room?.lockedAt ? 'Lock again' : 'Lock the lineup'}</button>
        <span class="dim">&mdash; ${
          // There is no unlock, and pressing this again is why there does not
          // need to be: it takes in whatever has been pushed since. Said here
          // because a referee holding a locked room and a team with a fix has
          // to know the way out is this same button.
          room?.lockedAt
            ? `locked ${esc(when(room.lockedAt))}. A push since then is not in this match &mdash; press again to take the newest code from every team.`
            : 'fixes what each robot is running. Until then a team can still push and restart their own.'
        }</span>
      </p>
      <p style="margin-top:1rem"><button id="start-match">Start the match${
        owed > 0 ? ` at ${clock!.goals.violet}&ndash;${clock!.goals.lime}` : ''
      }</button></p>
      ${data.console ? `<p class="dim"><a href="${esc(data.console)}" data-full>Go to the console</a></p>` : ''}
    `);

    // The clock is a button because the referee is the only one who can see
    // whether the delay is the team's fault or the venue's network. Stopping it
    // keeps whatever it earned: a scoreline that could be wound back by turning
    // up would make it pointless.
    const penalty = document.getElementById('penalty-clock') as HTMLButtonElement | null;
    penalty?.addEventListener('click', () => {
      const on = penalty.dataset.on !== 'true';
      penalty.disabled = true;
      void (async () => {
        const res = await api<{ ok: boolean; reason?: string }>(
          `/api/referee/match/${encodeURIComponent(fixtureId)}/penalty`,
          { method: 'POST', body: JSON.stringify({ on }) },
        );
        if (!res.ok && res.reason) alert(res.reason);
        await go(`/referee/m/${encodeURIComponent(fixtureId)}`, true);
      })();
    });

    // Locking takes a moment: it restarts every seat running older code than
    // its team has since pushed, and a sandboxed interpreter takes a second to
    // come up. Disabled while it does, or a second press lands mid-restart.
    const lock = document.getElementById('lock-lineup') as HTMLButtonElement | null;
    lock?.addEventListener('click', () => {
      lock.disabled = true;
      lock.textContent = 'Locking…';
      void (async () => {
        const res = await api<{ ok: boolean; reason?: string }>(
          `/api/referee/match/${encodeURIComponent(fixtureId)}/lock`,
          { method: 'POST' },
        );
        if (!res.ok && res.reason) alert(res.reason);
        await go(`/referee/m/${encodeURIComponent(fixtureId)}`, true);
      })();
    });

    // Never disabled, however empty the list is. A referee decides when a match
    // starts, and a team that never turns up has to be able to delay a fixture
    // without being able to stop one.
    const start = document.getElementById('start-match') as HTMLButtonElement | null;
    start?.addEventListener('click', () => {
      start.disabled = true;
      start.textContent = 'Starting…';
      void (async () => {
        const res = await api<{ ok: boolean; reason?: string }>(
          `/api/referee/match/${encodeURIComponent(fixtureId)}/start`,
          { method: 'POST' },
        );
        if (!res.ok && res.reason) alert(res.reason);
        await go(`/referee/m/${encodeURIComponent(fixtureId)}`, true);
      })();
    });

    // Quickly: this list changes under the referee while they read it, as each
    // team presses their own button on the other side of the hall.
    repoll(() => void refereeMatch(fixtureId), 2000);
    return;
  }

  if (data.state === 'playing' && data.live && data.console) {
    // Half-time is the one part of a match this page has a decision on. The
    // whistle stays on the console, where a referee watching the football
    // already is; what is here is the thing the console deliberately does not
    // have — taking a team's correction in, which has a capability behind it
    // and an audit line after it, exactly as it does before kick-off.
    const halfTime = data.halfTime;
    const left = halfTime ? Math.ceil(halfTime.remaining) : 0;
    const waiting = halfTime
      ? (['violet', 'lime'] as const)
          .filter((team) => !halfTime.ready[team])
          .map((team) => (team === 'violet' ? data.fixture.home : data.fixture.away))
      : [];
    view.innerHTML =
      head +
      h(`
      ${liveScoreline(data.live)}
      ${
        halfTime
          ? `<h2 style="margin-top:1.4rem">Half-time <span class="dim">${
              halfTime.over
                ? '&mdash; time is up'
                : `&mdash; ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`
            }</span></h2>
        <p class="dim">${
          waiting.length
            ? `Waiting on ${esc(waiting.join(' and '))}. The console holds the kick-off until both teams say they are ready, or until the clock runs out.`
            : 'Both teams are ready. Kick off from the console whenever you are.'
        }</p>
        ${data.seats ? seatRows(data.seats) : ''}
        <p style="margin-top:1rem">
          <button id="lock-lineup">Take the new code in</button>
          <span class="dim">&mdash; restarts any robot whose team has pushed a fix since the match started. It takes a second to come back up, so do it before you kick off.</span>
        </p>`
          : ''
      }
      <p style="margin-top:1rem"><a href="${esc(data.console)}" data-full>Take the match</a></p>
    `);

    // The same press as in pre-game, and the same reason it is disabled while
    // it works: a sandboxed interpreter takes a second to come up, and a
    // second press lands mid-restart.
    const relock = document.getElementById('lock-lineup') as HTMLButtonElement | null;
    relock?.addEventListener('click', () => {
      relock.disabled = true;
      relock.textContent = 'Taking it in…';
      void (async () => {
        const res = await api<{ ok: boolean; reason?: string }>(
          `/api/referee/match/${encodeURIComponent(fixtureId)}/lock`,
          { method: 'POST' },
        );
        if (!res.ok && res.reason) alert(res.reason);
        await go(`/referee/m/${encodeURIComponent(fixtureId)}`, true);
      })();
    });

    // Quickly at half-time — there is a clock on the screen and two teams
    // pressing a button on the other side of the hall.
    repoll(() => void refereeMatch(fixtureId), halfTime ? 2000 : 3000);
    return;
  }

  if (data.state === 'played') {
    view.innerHTML =
      head +
      h(`
      <div class="empty">This match has been played.</div>
      <p><a href="/m/${encodeURIComponent(data.fixture.id)}">See the record</a></p>
    `);
    return;
  }

  view.innerHTML =
    head +
    h(`
    <div class="empty">Not started yet. This page becomes the match when it opens — leave it up.</div>
  `);
  repoll(() => void refereeMatch(fixtureId), 3000);
}

/**
 * Enough administration to run a venue without an ssh session.
 *
 * Phase 12 is the real admin area. What is here is what Phase 6 itself creates
 * and therefore has to be able to undo: who exists, and who may register.
 */
/**
 * An index, and nothing else.
 *
 * Until Phase 12 G this page also held the invitation form and the list of
 * accounts, which is where they went when there was nowhere else to put them.
 * Everything else about running a venue has had its own screen since slice E;
 * people are the last subject to get one, and a hub that is six links reads in
 * one glance where a hub with a form buried under it did not.
 */
async function admin(): Promise<void> {
  if (!me.can.admin) return void go('/login?next=%2Fadmin');
  const load = await api<AdminArenas>('/api/admin/arenas');

  view.innerHTML = h(`
    <h1>Administration</h1>

    <div class="rows">
      <a class="row" href="/admin/arenas">
        <span class="grow">What is running</span>
        <span class="state">${load.running} ${load.running === 1 ? 'arena' : 'arenas'}${
          load.queue.length ? `, ${load.queue.length} waiting` : ''
        }</span>
      </a>
      <a class="row" href="/admin/tournaments">
        <span class="grow">Correct the draw</span>
        <span class="state">move, void, withdraw, play it again</span>
      </a>
      <a class="row" href="/admin/teams">
        <span class="grow">Team files</span>
        <span class="state">what is loaded, and putting an earlier push back</span>
      </a>
      <a class="row" href="/admin/people">
        <span class="grow">People</span>
        <span class="state">accounts, invitations, who may do what, and who referees what</span>
      </a>
      <a class="row" href="/admin/audit">
        <span class="grow">Who did what</span>
        <span class="state">every act at this venue, newest first</span>
      </a>
      <a class="row" href="/admin/settings">
        <span class="grow">Settings</span>
        <span class="state">what this venue has turned, and it takes effect now</span>
      </a>
    </div>
  `);
}

interface AdminArenas {
  machine: { cores: number; memoryMb: number; sandboxUnavailable: string | null };
  budget: {
    max: number;
    set: boolean;
    guaranteed: number;
    limitedBy: string;
    fixtures: number;
    practice: number;
    enforced: boolean;
    warnings: string[];
    seatCpuPercent: number;
    seatMemoryMb: number;
  };
  inUse: { cores: number; memoryMb: number; processes: number };
  running: number;
  arenas: {
    id: string;
    kind: string;
    owner: string | null;
    url: string;
    createdAt: string;
    usage: { cores: number; memoryMb: number } | null;
    fidelity: number | null;
    lastUsed: string;
    closingAt: string | null;
    open: number;
  }[];
  /** The teams waiting for a field, front first. */
  queue: { slug: string; offer: string | null }[];
}

/**
 * Three numbers, never one.
 *
 * What you set, what the hardware guarantees, and what is actually in use —
 * because a console showing only the first turns teams away for nothing, and
 * one showing only the last budgets on teams staying bad at this.
 */
function budgetPanel(load: AdminArenas): string {
  const { budget, machine, inUse } = load;
  return h(`
    <h2>Load</h2>
    <div class="panel">
      <div class="rows">
        <div class="row"><span class="grow">Arenas running</span>
          <span class="state">${load.running} of ${budget.max}${budget.set ? '' : ' (computed)'}</span></div>
        <div class="row"><span class="grow">This machine guarantees</span>
          <span class="state">${budget.guaranteed} arenas · ${budget.limitedBy} runs out first</span></div>
        <div class="row"><span class="grow">In use right now</span>
          <span class="state">${inUse.cores.toFixed(2)} of ${machine.cores} cores ·
            ${Math.round(inUse.memoryMb)} MB of ${Math.round(machine.memoryMb / 1024)} GB</span></div>
        <div class="row"><span class="grow">Per-seat grant</span>
          <span class="state">${budget.seatCpuPercent}% of a core · ${budget.seatMemoryMb} MB${
            budget.enforced ? '' : ' — unenforced'
          }</span></div>
        <div class="row"><span class="grow">Held for fixtures / open to practice</span>
          <span class="state">${budget.fixtures} / ${budget.practice}</span></div>
      </div>
      ${budget.warnings.map((warning) => `<div class="note">${esc(warning)}</div>`).join('')}
    </div>
  `);
}

/**
 * Every child process, and the button to stop it.
 *
 * A venue's real failure mode is not a subtle bug, it is four things running
 * that should not be and nobody knowing which machine they are on.
 */
/**
 * A time with its seconds, for a list whose whole job is *which came first*.
 *
 * `when()` stops at minutes, which is right for a kick-off and wrong here:
 * two pushes forty seconds apart both read "10:54 AM", and a history nobody
 * can put in order is not a history.
 */
function whenExact(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const today = new Date();
  const sameDay =
    at.getDate() === today.getDate() &&
    at.getMonth() === today.getMonth() &&
    at.getFullYear() === today.getFullYear();
  return sameDay ? time : `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/** "4m ago", for a column where a wall-clock time would be noise. */
function since(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

/** The other direction, for a field that has been warned it is closing. */
function inAbout(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'any moment';
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? 'in under a minute' : `in ${minutes}m`;
}

function arenaRows(load: AdminArenas): string {
  if (load.arenas.length === 0) {
    return h(`<h2>Arenas</h2><div class="empty">Nothing is running.</div>`);
  }
  const now = Date.now();
  return h(`
    <h2>Arenas</h2>
    <div class="rows">
      ${load.arenas
        .map((arena) => {
          const age = Math.max(0, Math.round((now - Date.parse(arena.createdAt)) / 60000));
          // Who is on it, and when somebody last was. A field with people on it
          // says so and nothing more: `lastUsed` on an occupied field is simply
          // now, and printing "just now" beside "2 here" is noise.
          const presence = arena.open > 0 ? `${arena.open} here` : `quiet, ${since(arena.lastUsed)}`;
          return `<div class="row">
            <a class="grow" href="${esc(arena.url)}">${esc(arena.kind)} ${esc(arena.id)}</a>
            <span class="state">${esc(arena.owner ?? '')}</span>
            <span class="state">${age}m old</span>
            <span class="state${arena.open > 0 ? ' playing' : ''}">${esc(presence)}</span>
            <span class="state">${arena.usage ? `${arena.usage.cores.toFixed(2)} cores · ${Math.round(arena.usage.memoryMb)} MB` : 'measuring…'}</span>
            <span class="state">${arena.fidelity === null ? '' : `realtime ${(arena.fidelity * 100).toFixed(0)}%`}</span>
            ${
              arena.closingAt
                ? `<span class="state closing">closing ${esc(inAbout(arena.closingAt))}</span>`
                : ''
            }
            <button class="stop" data-arena="${esc(arena.id)}">Stop</button>
          </div>`;
        })
        .join('')}
    </div>
  `);
}

/**
 * The line for a practice field.
 *
 * It belongs beside the fields rather than on a screen of its own, because a
 * queue is not only a list of teams — it is what makes the idle sweep
 * impatient. With nobody waiting a field sits for the full quiet time; with
 * somebody waiting that halves, and only the quietest field goes per sweep.
 * An organiser reading "closing in 2m" needs the reason in the same eyeful.
 */
function queueRows(load: AdminArenas): string {
  if (load.queue.length === 0) {
    return h(`<h2>Waiting for a field</h2><div class="empty">Nobody is waiting.</div>`);
  }
  return h(`
    <h2>Waiting for a field</h2>
    <div class="rows">
      ${load.queue
        .map(
          (one, index) => `<div class="row">
            <span class="at">${index + 1}</span>
            <span class="grow">${esc(one.slug)}</span>
            <span class="state">${one.offer ? `offered a field until ${esc(when(one.offer))}` : ''}</span>
          </div>`,
        )
        .join('')}
    </div>
  `);
}

/**
 * Every arena on the machine, and the button to stop it.
 *
 * Its own screen since Phase 12 — a venue's failure mode is four things
 * running that should not be and nobody knowing which machine they are on, and
 * that question deserves a page rather than a panel above the invitations.
 * It polls, because every number on it is a live one.
 */
async function adminArenas(): Promise<void> {
  if (!me.can.admin) return void go('/login?next=%2Fadmin%2Farenas');
  const load = await api<AdminArenas>('/api/admin/arenas');

  view.innerHTML = h(`
    <p class="dim"><a href="/admin">Administration</a></p>
    <h1>What is running</h1>

    ${budgetPanel(load)}
    ${arenaRows(load)}
    ${queueRows(load)}
  `);

  for (const button of view.querySelectorAll<HTMLButtonElement>('button.stop')) {
    button.addEventListener('click', async () => {
      const id = button.dataset.arena;
      if (!id) return;
      // Armed, not immediate. The list re-renders every few seconds and this
      // button kills somebody's field: one press on a row that moved under the
      // cursor is not a decision anybody made.
      if (button.dataset.armed !== 'yes') {
        for (const other of view.querySelectorAll<HTMLButtonElement>('button.stop[data-armed=yes]')) {
          other.dataset.armed = 'no';
          other.textContent = 'Stop';
        }
        button.dataset.armed = 'yes';
        button.textContent = 'Stop it — sure?';
        return;
      }
      button.disabled = true;
      await api(`/api/admin/arenas/${encodeURIComponent(id)}/stop`, { method: 'POST' });
      await adminArenas();
    });
  }

  // Paused while somebody is mid-decision: a re-render would throw the armed
  // button away and put an unarmed one under their finger.
  repoll(() => {
    if (view.querySelector('button.stop[data-armed=yes]')) return;
    void adminArenas();
  }, 5000);
}


// ------------------------------------------------- administering a draw

interface AdminFixture extends Card {
  /** Held by a referee right now, so not an organiser's to correct. */
  theirs?: boolean;
  /** The draw no longer has it, but a room is still standing on it. */
  voided?: boolean;
  /** Why the schedule gave up on it. Present only on an abandoned fixture. */
  stalled?: string;
}

interface AdminAmendment {
  n: number;
  kind: string;
  at: string;
  by: { id: string | null; slug: string };
  reason: string;
  fixtureId?: string;
  team?: string;
  replacement?: string;
  goals?: number;
  times?: Record<string, string>;
}

/** The correction an organiser has started but not yet confirmed, if any. */
let pending: { kind: string; fixtureId?: string; team?: string; title: string } | null = null;

/** What each correction is called where a person has to choose it. */
const AMEND_TITLE: Record<string, string> = {
  void: 'Take this fixture out of the draw',
  restore: 'Put this fixture back',
  schedule: 'Move this fixture',
  replay: 'Play this fixture again',
  withdraw: 'Withdraw this team from the draw',
  substitute: 'Put somebody else in their place',
};

/**
 * The draw, and every correction that can be made to it.
 *
 * The terminal has been able to do all of this since Slice B; this is the same
 * records through the same writer, for the organiser who has a laptop open and
 * no shell on it. Two sections, because the corrections divide cleanly: one
 * acts on a fixture, the other on a team across the whole draw, and a button
 * that withdraws a team does not belong among twelve that void one match.
 */
async function adminTournaments(): Promise<void> {
  if (!me.can.admin) return void go('/login?next=%2Fadmin%2Ftournaments');
  const data = await api<{
    ok: boolean;
    tournament: { name: string; fixturesTotal: number } | null;
    entrants: string[];
    fixtures: AdminFixture[];
    amendments: AdminAmendment[];
    scheduleRunning?: boolean;
  }>('/api/admin/tournament');

  if (!data.tournament) {
    view.innerHTML = h(`
      <p class="dim"><a href="/admin">Administration</a></p>
      <h1>The draw</h1>
      <div class="empty">This server is not running a tournament.</div>
    `);
    return;
  }

  view.innerHTML = h(`
    <p class="dim"><a href="/admin">Administration</a></p>
    <h1>The draw</h1>
    <p class="dim">${esc(data.tournament.name)} &middot; ${
      data.scheduleRunning
        ? 'the schedule is running'
        : 'nothing is being offered &mdash; put a fixture back and it starts again'
    }</p>

    <h2>Programme</h2>
    <div class="rows">${data.fixtures.map(fixtureAdminRow).join('')}</div>

    <h2>Entrants</h2>
    <div class="rows">${data.entrants.map(entrantAdminRow).join('')}</div>

    <h2>Corrections</h2>
    ${
      data.amendments.length
        ? `<div class="rows">${data.amendments.map(amendmentRow).join('')}</div>`
        : `<div class="empty">This draw has never been amended.</div>`
    }
  `);

  for (const button of view.querySelectorAll<HTMLButtonElement>('button[data-act]')) {
    button.addEventListener('click', () => {
      const kind = button.dataset.act!;
      pending = {
        kind,
        fixtureId: button.dataset.fixture,
        team: button.dataset.team,
        title: AMEND_TITLE[kind] ?? kind,
      };
      void adminTournaments();
    });
  }
  const cancel = view.querySelector<HTMLButtonElement>('#amend-cancel');
  cancel?.addEventListener('click', () => {
    pending = null;
    void adminTournaments();
  });
  if (pending) form('#amend-form', submitAmend);
  view.querySelector<HTMLInputElement>('#amend-why')?.focus();
}

/**
 * Nothing is written without a reason typed here.
 *
 * The same rule the terminal keeps — an amendment without a reason is an edit —
 * and the reason a browser needs it more, not less: a button is much easier to
 * press by accident than a command is to type.
 */
async function submitAmend(): Promise<string | null> {
  if (!pending) return null;
  const reason = value('#amend-why');
  if (!reason) return 'Say why. An amendment without a reason is an edit.';

  const path =
    pending.kind === 'replay' ? '/api/admin/tournament/replay' : '/api/admin/tournament/amend';
  const body: Record<string, unknown> =
    pending.kind === 'replay'
      ? { fixtureId: pending.fixtureId, reason }
      : {
          kind: pending.kind,
          reason,
          ...(pending.fixtureId ? { fixtureId: pending.fixtureId } : {}),
          ...(pending.team ? { team: pending.team } : {}),
          ...(pending.kind === 'schedule' ? { playAt: new Date(value('#amend-at')).toISOString() } : {}),
          ...(pending.kind === 'substitute' ? { replacement: value('#amend-with') } : {}),
        };

  if (pending.kind === 'schedule' && Number.isNaN(Date.parse(value('#amend-at')))) {
    return 'That is not a time.';
  }
  if (pending.kind === 'substitute' && !value('#amend-with')) {
    return 'Who takes their place?';
  }

  const res = await api<{ ok: boolean; reason?: string }>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) return res.reason ?? 'that did not work';
  pending = null;
  await adminTournaments();
  return null;
}

/** The panel that asks for a reason, under whichever row it belongs to. */
function amendPanel(): string {
  if (!pending) return '';
  return h(`
    <form class="panel amend" id="amend-form">
      <strong>${esc(pending.title)}</strong>
      ${
        pending.kind === 'schedule'
          ? `<label for="amend-at">Kick-off</label><input id="amend-at" type="datetime-local" />`
          : ''
      }
      ${
        pending.kind === 'substitute'
          ? `<label for="amend-with">Who takes their place</label><input id="amend-with" />`
          : ''
      }
      <label for="amend-why">Why</label>
      <input id="amend-why" placeholder="their bus did not arrive" />
      <div>
        <button class="primary" type="submit">Record it</button>
        <button class="quiet" type="button" id="amend-cancel">Cancel</button>
      </div>
      <div class="error" id="error" hidden></div>
    </form>
  `);
}

/** Whether the panel currently open belongs under this row. */
function panelFor(what: { fixtureId?: string; team?: string }): string {
  if (!pending) return '';
  const mine =
    (what.fixtureId !== undefined && pending.fixtureId === what.fixtureId) ||
    (what.team !== undefined && pending.team === what.team);
  return mine ? amendPanel() : '';
}

/** One fixture, with whichever corrections apply to the state it is in. */
function fixtureAdminRow(card: AdminFixture): string {
  const played = card.state === 'played';
  const buttons = card.theirs
    ? // The reach rule, said rather than enforced silently: a match somebody is
      // standing at belongs to its referee until they end it.
      `<span class="state">a referee has it</span>`
    : card.voided
      ? `<button class="quiet" data-act="restore" data-fixture="${esc(card.id)}">Restore</button>`
      : [
          played || card.stalled
            ? `<button class="quiet" data-act="replay" data-fixture="${esc(card.id)}">Play it again</button>`
            : '',
          `<button class="quiet" data-act="schedule" data-fixture="${esc(card.id)}">Move</button>`,
          `<button class="stop" data-act="void" data-fixture="${esc(card.id)}">Void</button>`,
        ].join('');
  return h(`
    <div class="row">
      ${card.playAt ? `<span class="at">${esc(when(card.playAt))}</span>` : ''}
      <span class="grow">${esc(card.home)}<span class="v">v</span>${esc(card.away)}</span>
      ${played ? `<span class="score">${card.homeScore ?? 0}&ndash;${card.awayScore ?? 0}</span>` : ''}
      <span class="state">${
        card.stalled
          ? // Already a sentence — `runDraw` reports "the match was abandoned
            // (why)" — so prefixing it would say abandoned twice.
            esc(card.stalled)
          : card.voided
            ? 'voided'
            : esc(PUBLIC_STATE[card.state ?? ''] ?? card.state ?? '')
      }</span>
      ${buttons}
    </div>
    ${panelFor({ fixtureId: card.id })}
  `);
}

/** One entrant, with the two corrections that act on a team rather than a match. */
function entrantAdminRow(team: string): string {
  return h(`
    <div class="row">
      <a class="grow" href="/t/${encodeURIComponent(slug(team))}">${esc(team)}</a>
      <button class="quiet" data-act="substitute" data-team="${esc(team)}">Substitute</button>
      <button class="stop" data-act="withdraw" data-team="${esc(team)}">Withdraw</button>
    </div>
    ${panelFor({ team })}
  `);
}

/** One appended correction: what, who, when and why. */
function amendmentRow(record: AdminAmendment): string {
  const about =
    record.kind === 'substitute'
      ? `${record.team} → ${record.replacement}`
      : record.kind === 'withdraw'
        ? `${record.team} (${record.goals}–0)`
        : record.kind === 'schedule'
          ? `${Object.keys(record.times ?? {}).length} fixture(s)`
          : (record.fixtureId ?? '');
  return h(`
    <div class="row">
      <span class="at">${String(record.n).padStart(4, '0')}</span>
      <span class="grow">${esc(record.kind)} &middot; ${esc(about)}
        <br /><span class="dim">${esc(record.reason)}</span></span>
      <span class="state">${esc(record.by.slug)}${record.by.id ? '' : ' (terminal)'}</span>
      <span class="state">${esc(when(record.at))}</span>
    </div>
  `);
}

// ------------------------------------------------- a team's files

interface LiveFolder {
  entry: string | null;
  team: string | null;
  /** Will this actually load, or will the built-in agent play in their name? */
  loads: boolean;
  /** Why not, in the validator's own words. */
  why: string | null;
  at: string;
  files: { name: string; bytes: number }[];
}

interface AdminRobot {
  robot: 1 | 2;
  live: LiveFolder | null;
  kept: number;
}

interface KeptPush {
  stamp: string;
  at: string;
  by: { id: string | null; slug: string };
  via: string;
  team: string;
  robot: number;
  entry: string;
  files: { name: string; bytes: number }[];
}

/** Which robot's history is open, and which of its pushes is being read. */
let openRobot: { slug: string; robot: 1 | 2 } | null = null;
let openPush: string | null = null;

/**
 * Team files, and putting an earlier push back.
 *
 * Read-only, deliberately: an organiser cannot type into a team's folder here,
 * because a folder somebody hand-edited is a folder that never went through
 * the validator. What they can do is put back a push that did — which is the
 * ordinary push path, so it is checked, re-tokened and archived like any
 * other.
 */
async function adminTeams(): Promise<void> {
  if (!me.can.admin) return void go('/login?next=%2Fadmin%2Fteams');
  const data = await api<{ ok: boolean; teams: { slug: string; displayName: string; disabled: boolean; robots: AdminRobot[] }[] }>(
    '/api/admin/teams',
  );

  const open = openRobot
    ? await api<{ ok: boolean; pushes: KeptPush[]; live: LiveFolder | null }>(
        `/api/admin/teams/${encodeURIComponent(openRobot.slug)}/${openRobot.robot}`,
      )
    : null;
  const reading =
    openRobot && openPush
      ? await api<{ ok: boolean; push: KeptPush; files: { name: string; bytes: number; text?: string; binary?: true }[] }>(
          `/api/admin/teams/${encodeURIComponent(openRobot.slug)}/${openRobot.robot}/${openPush}`,
        )
      : null;

  view.innerHTML = h(`
    <p class="dim"><a href="/admin">Administration</a></p>
    <h1>Team files</h1>
    <p class="dim">What each robot has on the server, and every push kept before it.</p>

    ${
      data.teams.length === 0
        ? `<div class="empty">No team accounts yet.</div>`
        : data.teams.map((team) => teamFilesBlock(team, open?.pushes ?? [], reading)).join('')
    }
  `);

  for (const button of view.querySelectorAll<HTMLButtonElement>('button[data-robot]')) {
    button.addEventListener('click', async () => {
      const slug = button.dataset.team!;
      const robot = button.dataset.robot === '2' ? 2 : 1;
      const same = openRobot?.slug === slug && openRobot.robot === robot;
      openRobot = same ? null : { slug, robot };
      openPush = null;
      pending = null;
      await adminTeams();
    });
  }

  for (const row of view.querySelectorAll<HTMLElement>('[data-stamp]')) {
    row.addEventListener('click', async () => {
      const stamp = row.dataset.stamp!;
      openPush = openPush === stamp ? null : stamp;
      pending = null;
      await adminTeams();
    });
  }

  for (const button of view.querySelectorAll<HTMLButtonElement>('button.rollback')) {
    button.addEventListener('click', async () => {
      pending = { kind: 'rollback', title: 'Put this push back', fixtureId: button.dataset.stamp! };
      await adminTeams();
    });
  }

  if (view.querySelector('#rollback-form')) {
    form('#rollback-form', submitRollback);
    view.querySelector('#rollback-cancel')!.addEventListener('click', async () => {
      pending = null;
      await adminTeams();
    });
  }
}

function teamFilesBlock(
  team: { slug: string; displayName: string; disabled: boolean; robots: AdminRobot[] },
  pushes: KeptPush[],
  reading: { push: KeptPush; files: { name: string; bytes: number; text?: string; binary?: true }[] } | null,
): string {
  return h(`
    <h2>${esc(team.displayName)}${team.disabled ? ' <span class="dim">(disabled)</span>' : ''}</h2>
    <div class="rows">
      ${team.robots.map((robot) => robotFilesRow(team.slug, robot)).join('')}
    </div>
    ${
      openRobot?.slug === team.slug
        ? pushesBlock(pushes, reading)
        : ''
    }
  `);
}

function robotFilesRow(slug: string, robot: AdminRobot): string {
  const open = openRobot?.slug === slug && openRobot.robot === robot.robot;
  if (!robot.live) {
    return h(`<div class="row">
      <span class="at">${robot.robot}</span>
      <span class="grow dim">nothing pushed</span>
    </div>`);
  }
  return h(`
    <div class="row">
      <span class="at">${robot.robot}</span>
      <span class="grow">${esc(robot.live.entry ?? 'no entry point')}
        <br /><span class="dim">${robot.live.files.map((f) => esc(f.name)).join(', ')}</span></span>
      <span class="state">${esc(when(robot.live.at))}</span>
      <span class="state${robot.live.loads ? '' : ' closing'}">${
        robot.live.loads ? 'loads' : esc(robot.live.why ?? 'will not load')
      }</span>
      <button data-team="${esc(slug)}" data-robot="${robot.robot}">${
        open ? 'Hide' : `${robot.kept} kept`
      }</button>
    </div>
  `);
}

function pushesBlock(
  pushes: KeptPush[],
  reading: { push: KeptPush; files: { name: string; bytes: number; text?: string; binary?: true }[] } | null,
): string {
  // Which robot this is a history of, said out loud: the list renders under a
  // team's two rows and would otherwise read as the team's rather than one
  // robot's.
  const heading = `<h3>Robot ${openRobot?.robot ?? 1} &middot; earlier pushes</h3>`;
  if (pushes.length === 0) {
    return h(`${heading}<div class="empty">Nothing kept for this robot yet.</div>`);
  }
  return h(`
    ${heading}
    <div class="rows">
      ${pushes
        .map(
          (push) => `<div class="row pointer" data-stamp="${esc(push.stamp)}">
            <span class="at">${esc(whenExact(push.at))}</span>
            <span class="grow">${esc(push.files.map((f) => f.name).join(', '))}</span>
            <span class="state">${esc(push.by.slug)}${push.by.id ? '' : ' (key)'}</span>
            <span class="state">${push.via === 'rollback' ? 'put back' : esc(push.via)}</span>
          </div>
          ${reading && reading.push.stamp === push.stamp ? pushDetail(reading) : ''}`,
        )
        .join('')}
    </div>
  `);
}

function pushDetail(reading: {
  push: KeptPush;
  files: { name: string; bytes: number; text?: string; binary?: true }[];
}): string {
  return h(`
    <div class="panel">
      ${reading.files
        .map(
          (file) => `<div class="filename">${esc(file.name)} <span class="dim">${file.bytes} bytes</span></div>
          ${
            file.text === undefined
              ? `<p class="dim">Not text — shown by name and size only.</p>`
              : `<pre class="code">${esc(file.text)}</pre>`
          }`,
        )
        .join('')}
      ${
        // Armed where the button was, not at the bottom of the list: the
        // decision and the code it is about have to be in one eyeful.
        pending?.kind === 'rollback' && pending.fixtureId === reading.push.stamp
          ? rollbackPanel()
          : `<button class="rollback" data-stamp="${esc(reading.push.stamp)}">Put this back</button>`
      }
    </div>
  `);
}

function rollbackPanel(): string {
  return h(`
    <form class="panel amend" id="rollback-form">
      <strong>Put this push back</strong>
      <p class="dim">It goes through the validator like any push, and gets a new join token.
        The team's own workspace is <em>not</em> touched — their next Run or push will
        put back whatever is in their editor.</p>
      <label for="rollback-why">Why</label>
      <input id="rollback-why" placeholder="they uploaded robot 2's file" />
      <div>
        <button class="primary" type="submit">Put it back</button>
        <button class="quiet" type="button" id="rollback-cancel">Cancel</button>
      </div>
      <div class="error" id="error" hidden></div>
    </form>
  `);
}

async function submitRollback(): Promise<string | null> {
  if (!pending || !openRobot) return null;
  const reason = value('#rollback-why');
  if (!reason) return 'Say why. A rollback without a reason is an edit.';

  const res = await api<{ ok: boolean; reason?: string; notice?: string }>(
    `/api/admin/teams/${encodeURIComponent(openRobot.slug)}/${openRobot.robot}/rollback`,
    { method: 'POST', body: JSON.stringify({ stamp: pending.fixtureId, reason }) },
  );
  if (!res.ok) return res.reason ?? 'that did not work';
  pending = null;
  openPush = null;
  await adminTeams();
  // Phase 11's lineup lock, answering exactly as it does for a team's own
  // push: the code is in, and it is for the game after the one already locked.
  if (res.notice) {
    const note = document.createElement('div');
    note.className = 'warn';
    note.textContent = res.notice;
    view.querySelector('h1')?.after(note);
  }
  return null;
}

// ----------------------------------------------------------------- people

interface Grant {
  capability: string;
  scope: string;
  target: string | null;
}

interface Person {
  id: string;
  slug: string;
  displayName: string;
  role: string;
  kind: string;
  createdAt: string;
  disabledAt: string | null;
  grants: Grant[];
  roleCapabilities: { capability: string; scope: string }[];
  assignments: { drawId: string; fixtureId: string }[];
}

interface PeopleLoad {
  people: Person[];
  invites: { code: string; role: string; team: string | null; createdAt: string; usedAt: string | null }[];
  draw: {
    id: string;
    name: string;
    fixtures: {
      id: string;
      home: string;
      away: string;
      voided?: boolean;
      referees: { accountId: string; displayName: string }[];
    }[];
  } | null;
  capabilities: string[];
  scopes: string[];
}

/** Which person's card is open. One at a time, like the team files screen. */
let openPerson: string | null = null;

/**
 * Everybody at the venue, and what each of them may do.
 *
 * Three things that had never been on one screen: a role, the rows in `grants`
 * that go beyond it, and the fixtures somebody has been given. Two of them had
 * never been on *any* screen — until Phase 12 G, `capability.grant` and
 * `referee.assign` had no HTTP route at all, so handing a referee a match
 * meant a shell on the machine running the venue.
 */
async function adminPeople(): Promise<void> {
  if (!me.can.admin) return void go('/login?next=%2Fadmin%2Fpeople');
  const load = await api<PeopleLoad>('/api/admin/people');
  const open = load.people.find((one) => one.id === openPerson) ?? null;

  view.innerHTML = h(`
    <p class="dim"><a href="/admin">Administration</a></p>
    <h1>People</h1>

    <h2>Accounts</h2>
    <div class="rows">
      ${load.people.map((one) => personRow(one, open)).join('')}
    </div>
    ${open ? personCard(open, load) : ''}

    ${refereeFixtures(load)}

    <h2>Invite somebody</h2>
    <form class="panel" id="form">
      <label for="role">Role</label>
      <select id="role">
        <option value="team">Team</option>
        <option value="referee">Referee</option>
        <option value="admin">Organiser</option>
      </select>
      <label for="team">Team name <span class="dim">(teams only — this is the name they will play under)</span></label>
      <input id="team" />
      <button class="primary" type="submit">Issue a code</button>
      <div class="error" id="error" hidden></div>
    </form>
    <div class="note" id="fresh" hidden></div>

    <h2>Invitations</h2>
    ${
      load.invites.length
        ? `<div class="rows">${load.invites
            .map(
              (invite) => `<div class="row">
                <span class="grow">${esc(invite.team ?? invite.role)}</span>
                <span class="mono">${esc(invite.code)}</span>
                <span class="state">${invite.usedAt ? 'used' : 'open'}</span>
              </div>`,
            )
            .join('')}</div>`
        : `<div class="empty">None issued.</div>`
    }
  `);

  wirePeople(open);
}

function personRow(one: Person, open: Person | null): string {
  return h(`<div class="row">
    <button class="link grow" data-person="${esc(one.id)}">${esc(one.displayName)}${
      one.id === me.account?.id ? ' <span class="dim">(you)</span>' : ''
    }</button>
    <span class="mono dim">${esc(one.slug)}</span>
    <span class="state">${esc(one.role)}</span>
    ${one.grants.length ? `<span class="state">+${one.grants.length}</span>` : ''}
    ${one.disabledAt ? `<span class="state closing">disabled</span>` : ''}
    <span class="state">${one.id === open?.id ? 'open' : ''}</span>
  </div>`);
}

/**
 * What a grant is worth saying out loud.
 *
 * The form offers every combination the `grants` table can hold rather than a
 * curated subset, because a screen narrower than the table is a second answer
 * to the same question. The price of that is that some combinations need a
 * sentence, and this is where they get one — against the choice actually being
 * made, not in a block of help above the form.
 */
function grantNote(capability: string, scope: string, target: string, person: Person): string {
  if (scope === 'assigned' && !target) {
    return 'A grant scoped to "assigned" with nothing named reaches nothing at all — being assigned is naming the thing. This will be refused.';
  }
  if (target) {
    return `Named things win: this reaches ${target} and nothing else, whatever the scope says.`;
  }

  // What the role already carries, *and how far*. The bare name is not enough:
  // a referee holds `match.control` over nothing until a fixture is named, so
  // "they already have it" and "this changes nothing" are different sentences.
  const held = person.roleCapabilities.find((one) => one.capability === capability);
  if (held?.scope === 'any') {
    return `Their role already carries ${capability} over everything. This row would change nothing.`;
  }
  if (held?.scope === 'assigned' && scope !== 'assigned') {
    return `Their role holds ${capability} only over the fixtures they are assigned. This widens it to every match at the venue — including the one on the next pitch over.`;
  }
  if (held?.scope === 'own' && scope === 'any') {
    return `Their role carries ${capability} over their own things only. This widens it to everybody's.`;
  }
  if (scope === 'own') {
    return `Reaches only things named "${person.slug}", which is what "own" means.`;
  }
  return '';
}

function personCard(one: Person, load: PeopleLoad): string {
  return h(`
    <div class="panel">
      <h3>${esc(one.displayName)}</h3>
      <div class="rows">
        <div class="row"><span class="grow">Signs in as</span><span class="mono">${esc(one.slug)}</span></div>
        <div class="row"><span class="grow">Role</span><span class="state">${esc(one.role)} <span class="dim">(fixed when the account was made)</span></span></div>
        <div class="row"><span class="grow">Made</span><span class="state">${esc(when(one.createdAt))}</span></div>
        <div class="row">
          <span class="grow">${one.disabledAt ? 'Disabled — cannot sign in' : 'Can sign in'}</span>
          <button class="${one.disabledAt ? 'primary' : ''}" data-disable="${esc(one.id)}" data-to="${one.disabledAt ? 'false' : 'true'}">
            ${one.disabledAt ? 'Let them back in' : 'Disable'}
          </button>
        </div>
      </div>
      <div class="error" id="person-error" hidden></div>

      <h3>What they may do</h3>
      <p class="dim">Their role carries ${one.roleCapabilities.length}: ${esc(
        one.roleCapabilities.map((r) => `${r.capability} (${r.scope})`).join(', '),
      )}.</p>
      ${
        one.grants.length
          ? `<div class="rows">${one.grants
              .map(
                (grant) => `<div class="row">
                  <span class="grow mono">${esc(grant.capability)}</span>
                  <span class="state">${esc(grant.scope)}</span>
                  <span class="mono dim">${esc(grant.target ?? '')}</span>
                  <button data-revoke="${esc(grant.capability)}" data-scope="${esc(grant.scope)}"
                          data-target="${esc(grant.target ?? '')}">Revoke</button>
                </div>`,
              )
              .join('')}</div>`
          : `<div class="empty">Nothing beyond their role.</div>`
      }

      <form class="panel" id="grant-form">
        <label for="capability">Also let them</label>
        <select id="capability">
          ${load.capabilities.map((cap) => `<option value="${esc(cap)}">${esc(cap)}</option>`).join('')}
        </select>
        <label for="scope">Reaching</label>
        <select id="scope">
          ${load.scopes.map((scope) => `<option value="${esc(scope)}"${scope === 'any' ? ' selected' : ''}>${esc(scope)}</option>`).join('')}
        </select>
        <label for="target">Only this thing <span class="dim">(a team slug, or draw:fixture — leave empty for everything)</span></label>
        <input id="target" />
        <p class="dim" id="grant-note"></p>
        <button class="primary" type="submit">Grant it</button>
        <div class="error" id="error" hidden></div>
      </form>

      <h3>Fixtures they referee</h3>
      ${
        one.assignments.length
          ? `<div class="rows">${one.assignments
              .map(
                // With a Take back of its own, and not only for tidiness: a
                // voided fixture nobody is standing at drops out of the draw
                // and off the list below, so an assignment to one would be
                // visible here and removable nowhere.
                (a) => `<div class="row"><span class="grow mono">${esc(a.fixtureId)}</span>
                  <span class="state dim">${esc(a.drawId)}</span>
                  <button data-unassign="${esc(a.fixtureId)}" data-who="${esc(one.id)}">Take back</button></div>`,
              )
              .join('')}</div>`
          : `<div class="empty">None. ${
              one.role === 'referee' || one.role === 'admin'
                ? 'Give them one below.'
                : 'A ' + esc(one.role) + ' account does not referee.'
            }</div>`
      }
    </div>
  `);
}

/**
 * Who referees what, fixture first.
 *
 * The buttons live on this side rather than on a person's card because this is
 * the organiser's actual question on the day — *has match 7 got somebody* —
 * and a screen that could only answer it person by person would be asking them
 * to hold the draw in their head.
 */
function refereeFixtures(load: PeopleLoad): string {
  if (!load.draw) return '';
  // Referees first, because a picker that defaults to an organiser quietly
  // suggests the wrong answer on every row — and nobody who is disabled, because
  // giving a match to an account that cannot sign in is giving it to nobody.
  const referees = load.people
    .filter((one) => (one.role === 'referee' || one.role === 'admin') && !one.disabledAt)
    .sort((a, b) => (a.role === b.role ? 0 : a.role === 'referee' ? -1 : 1));
  if (!referees.length) {
    return h(`<h2>Who referees what</h2>
      <div class="empty">No referee accounts yet — invite one above.</div>`);
  }
  return h(`
    <h2>Who referees what</h2>
    <p class="dim">${esc(load.draw.name)}. A referee holds the matches named here and no others.</p>
    <div class="rows">
      ${load.draw.fixtures
        .map(
          (fixture) => `<div class="row">
            <span class="grow">${esc(fixture.home)} v ${esc(fixture.away)}${
              fixture.voided ? ' <span class="dim">(voided)</span>' : ''
            }</span>
            ${
              fixture.referees.length
                ? fixture.referees
                    .map(
                      (ref) => `<span class="state">${esc(ref.displayName)}</span>
                        <button data-unassign="${esc(fixture.id)}" data-who="${esc(ref.accountId)}">Take back</button>`,
                    )
                    .join('')
                : `<span class="state dim">unassigned</span>`
            }
            ${
              fixture.voided
                ? ''
                : `<select data-pick="${esc(fixture.id)}">
                    ${referees.map((one) => `<option value="${esc(one.id)}">${esc(one.displayName)}</option>`).join('')}
                  </select>
                  <button data-assign="${esc(fixture.id)}">Assign</button>`
            }
          </div>`,
        )
        .join('')}
    </div>
    <div class="error" id="assign-error" hidden></div>
  `);
}

/** Everything the people screen listens to. One place, because it is a long page. */
function wirePeople(open: Person | null): void {
  for (const button of view.querySelectorAll<HTMLButtonElement>('button[data-person]')) {
    button.addEventListener('click', async () => {
      const id = button.dataset.person!;
      openPerson = openPerson === id ? null : id;
      await adminPeople();
    });
  }

  const complain = (selector: string, reason: string): void => {
    const box = view.querySelector(selector) as HTMLElement | null;
    if (!box) return;
    box.textContent = reason;
    box.hidden = false;
  };

  for (const button of view.querySelectorAll<HTMLButtonElement>('button[data-disable]')) {
    button.addEventListener('click', async () => {
      const res = await api<{ ok: boolean; reason?: string }>(
        `/api/admin/accounts/${encodeURIComponent(button.dataset.disable!)}/disabled`,
        { method: 'POST', body: JSON.stringify({ disabled: button.dataset.to === 'true' }) },
      );
      if (!res.ok) return complain('#person-error', res.reason ?? 'that did not work');
      await adminPeople();
    });
  }

  for (const button of view.querySelectorAll<HTMLButtonElement>('button[data-revoke]')) {
    button.addEventListener('click', async () => {
      const target = button.dataset.target ?? '';
      const res = await api<{ ok: boolean; reason?: string }>(
        `/api/admin/accounts/${encodeURIComponent(open!.id)}/grants/revoke`,
        {
          method: 'POST',
          body: JSON.stringify({
            capability: button.dataset.revoke,
            scope: button.dataset.scope,
            ...(target ? { target } : {}),
          }),
        },
      );
      if (!res.ok) return complain('#person-error', res.reason ?? 'that did not work');
      await adminPeople();
    });
  }

  if (open && view.querySelector('#grant-form')) {
    // The note follows the choice being made rather than sitting above the
    // form, because the thing worth saying depends on all three fields.
    const note = (): void => {
      const element = view.querySelector('#grant-note') as HTMLElement;
      element.textContent = grantNote(value('#capability'), value('#scope'), value('#target'), open);
    };
    for (const selector of ['#capability', '#scope', '#target']) {
      view.querySelector(selector)!.addEventListener('input', note);
      view.querySelector(selector)!.addEventListener('change', note);
    }
    note();

    form('#grant-form', async () => {
      const target = value('#target');
      const res = await api<{ ok: boolean; reason?: string }>(
        `/api/admin/accounts/${encodeURIComponent(open.id)}/grants`,
        {
          method: 'POST',
          body: JSON.stringify({
            capability: value('#capability'),
            scope: value('#scope'),
            ...(target ? { target } : {}),
          }),
        },
      );
      if (!res.ok) return res.reason ?? 'that did not work';
      await adminPeople();
      return null;
    });
  }

  const assign = async (fixtureId: string, accountId: string, remove: boolean): Promise<void> => {
    const res = await api<{ ok: boolean; reason?: string }>('/api/admin/assignments', {
      method: 'POST',
      body: JSON.stringify({ fixtureId, accountId, ...(remove ? { remove: true } : {}) }),
    });
    if (!res.ok) return complain('#assign-error', res.reason ?? 'that did not work');
    await adminPeople();
  };

  for (const button of view.querySelectorAll<HTMLButtonElement>('button[data-assign]')) {
    button.addEventListener('click', async () => {
      const fixtureId = button.dataset.assign!;
      const picker = view.querySelector(`select[data-pick="${CSS.escape(fixtureId)}"]`) as HTMLSelectElement;
      await assign(fixtureId, picker.value, false);
    });
  }
  for (const button of view.querySelectorAll<HTMLButtonElement>('button[data-unassign]')) {
    button.addEventListener('click', () => void assign(button.dataset.unassign!, button.dataset.who!, true));
  }

  form('#form', async () => {
    const res = await api<{ ok: boolean; reason?: string; invite?: { code: string } }>('/api/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ role: value('#role'), team: value('#team') }),
    });
    if (!res.ok) return res.reason ?? 'that did not work';
    const code = res.invite?.code;
    await adminPeople();
    const fresh = document.getElementById('fresh')!;
    fresh.hidden = false;
    fresh.innerHTML = h(`Hand this over — it works once:
      <div class="mono" style="margin-top:.4rem">${esc(code)}</div>`);
    return null;
  });
}

// ------------------------------------------------------------- who did what

interface AuditRow {
  at: string;
  actorId: string | null;
  actorName: string | null;
  capability: string;
  target: string | null;
  detail: string | null;
}

interface AuditLoad {
  audit: AuditRow[];
  counts: { capability: string; rows: number }[];
  people: { id: string; slug: string; displayName: string }[];
}

/**
 * What the screen opens on hides, and why.
 *
 * The venue records **everything**, the browser editor's autosave included —
 * which on an afternoon with twenty students typing is tens of thousands of
 * rows. Nothing is dropped; this list is what the first page leaves out, the
 * count beside the toggle says how much, and one press brings it all back. A
 * log that buried the dozen rows somebody came for would be a log nobody
 * opened twice.
 */
const NOISY = ['team.workspace.write'];

let auditShowAll = false;
let auditCapability = '';
let auditActor = '';

async function adminAudit(): Promise<void> {
  if (!me.can.admin) return void go('/login?next=%2Fadmin%2Faudit');

  const ask = new URLSearchParams();
  if (auditCapability) ask.set('capability', auditCapability);
  else if (!auditShowAll) for (const one of NOISY) ask.append('without', one);
  if (auditActor) ask.set('actor', auditActor);
  const load = await api<AuditLoad>(`/api/admin/audit?${ask.toString()}`);

  const hidden = load.counts
    .filter((one) => NOISY.includes(one.capability))
    .reduce((sum, one) => sum + one.rows, 0);
  const kinds = load.counts.map((one) => one.capability).sort();

  view.innerHTML = h(`
    <p class="dim"><a href="/admin">Administration</a></p>
    <h1>Who did what</h1>

    <div class="panel">
      <label for="cap">Act</label>
      <select id="cap">
        <option value="">Everything</option>
        ${kinds
          .map(
            (kind) =>
              `<option value="${esc(kind)}"${kind === auditCapability ? ' selected' : ''}>${esc(kind)}</option>`,
          )
          .join('')}
      </select>
      <label for="who">Person</label>
      <select id="who">
        <option value="">Anybody</option>
        ${load.people
          .map(
            (one) =>
              `<option value="${esc(one.id)}"${one.id === auditActor ? ' selected' : ''}>${esc(
                one.displayName,
              )}</option>`,
          )
          .join('')}
      </select>
      ${
        auditCapability
          ? ''
          : `<p class="dim">${
              auditShowAll
                ? 'Showing everything, editor saves included.'
                : `Editor autosaves are hidden — ${hidden} ${hidden === 1 ? 'row' : 'rows'} of them.`
            }
             <button class="link" id="toggle" type="button">${
               auditShowAll ? 'Hide them again' : 'Show them anyway'
             }</button></p>`
      }
    </div>

    ${auditRows(load.audit)}
  `);

  const cap = view.querySelector('#cap') as HTMLSelectElement;
  cap.addEventListener('change', () => {
    auditCapability = cap.value;
    void adminAudit();
  });
  const who = view.querySelector('#who') as HTMLSelectElement;
  who.addEventListener('change', () => {
    auditActor = who.value;
    void adminAudit();
  });
  view.querySelector('#toggle')?.addEventListener('click', () => {
    auditShowAll = !auditShowAll;
    void adminAudit();
  });
}

function auditRows(rows: AuditRow[]): string {
  if (!rows.length) {
    return '<p class="note">Nothing here yet under those terms.</p>';
  }
  return `<div class="rows">${rows
    .map(
      (row) => `<div class="row">
        <span class="mono">${esc(whenExact(row.at))}</span>
        <span class="grow">
          <strong>${esc(row.actorName ?? 'nobody signed in')}</strong>
          ${row.detail ? `<br><span class="dim">${esc(row.detail)}</span>` : ''}
        </span>
        <span class="state">${esc(row.capability)}</span>
        ${row.target ? `<span class="mono dim">${esc(row.target)}</span>` : ''}
      </div>`,
    )
    .join('')}</div>`;
}

// -------------------------------------------------------------- the settings

interface SettingsLoad {
  settings: Record<string, Record<string, unknown>>;
  sources: Record<string, 'default' | 'file' | 'flag'>;
  budget: { max: number; guaranteed?: number; limitedBy?: string; practice: number; warnings: string[] };
  complaints?: string[];
}

type FieldKind = 'number' | 'nullable' | 'text' | 'switch';

interface Field {
  path: string;
  label: string;
  kind: FieldKind;
  note?: string;
}

/**
 * The file, as a form.
 *
 * Grouped as `league.json` is grouped, because the promise this repository
 * keeps making is that an organiser can open the broken thing in a text editor
 * at eleven at night — and a screen that reorganised the file into something
 * prettier would be a second arrangement to hold in your head at exactly the
 * wrong moment.
 *
 * No bounds here. They live in `loadSettings`, the browser's change goes
 * through it, and a second copy of them in this file would be a second thing
 * to get out of step with the first.
 */
const SETTING_GROUPS: { title: string; note?: string; fields: Field[] }[] = [
  {
    title: 'Arenas',
    note: 'Lowering the ceiling refuses the next arena. It never stops a match already being played.',
    fields: [
      { path: 'arenas.max', label: 'How many at once', kind: 'nullable', note: 'blank = whatever this machine can guarantee' },
      { path: 'arenas.concurrentFixtures', label: 'Held for fixtures', kind: 'number' },
      { path: 'arenas.seatCpuPercent', label: 'CPU per seat (% of a core)', kind: 'number', note: 'arenas started from now' },
      { path: 'arenas.seatMemoryMb', label: 'Memory per seat (MB)', kind: 'number', note: 'arenas started from now' },
      { path: 'arenas.reserveCores', label: 'Cores held back for the hub', kind: 'number' },
    ],
  },
  {
    title: 'Practice fields',
    fields: [
      { path: 'practice.open', label: 'Practice is open', kind: 'switch' },
      { path: 'practice.max', label: 'Cap on practice fields', kind: 'nullable', note: 'blank = whatever is spare' },
      { path: 'practice.idleMins', label: 'Quiet minutes before a warning', kind: 'number' },
      { path: 'practice.graceMins', label: 'Minutes between the warning and closing', kind: 'number' },
      { path: 'practice.perTeam', label: 'Fields one team may own', kind: 'number' },
      { path: 'practice.claimSecs', label: 'Seconds a freed field is held', kind: 'number' },
    ],
  },
  {
    title: 'Before kick-off',
    fields: [
      { path: 'pregame.autoStartMins', label: 'Start itself after (minutes)', kind: 'nullable', note: 'blank = never, and a referee can always start it' },
      { path: 'pregame.penaltyPerMin', label: 'Penalty goals a minute', kind: 'number', note: '0 removes the button' },
    ],
  },
  {
    title: 'Rules this venue sets',
    fields: [
      { path: 'rules.mercyMargin', label: 'Goal difference that ends a match', kind: 'nullable', note: 'blank = no limit' },
      { path: 'rules.halfTimeSeconds', label: 'Half-time (seconds)', kind: 'number' },
      { path: 'rules.heldBallSeconds', label: 'Sitting on the ball (seconds)', kind: 'number', note: '0 = a robot may keep it as long as it likes' },
    ],
  },
  {
    title: 'Team code',
    fields: [{ path: 'pushes.keep', label: 'Pushes kept per robot', kind: 'number' }],
  },
];

async function adminSettings(): Promise<void> {
  if (!me.can.admin) return void go('/login?next=%2Fadmin%2Fsettings');
  const load = await api<SettingsLoad>('/api/admin/settings');
  renderSettings(load);
}

function renderSettings(load: SettingsLoad): void {
  view.innerHTML = h(`
    <p class="dim"><a href="/admin">Administration</a></p>
    <h1>Settings</h1>
    <p class="dim">Saved to <span class="mono">league.json</span> and in force straight away —
      this venue is not restarted for any of it.</p>

    <form id="form">
      ${SETTING_GROUPS.map((group) => settingGroup(group, load)).join('')}
      <button class="primary" type="submit">Save</button>
      <div class="error" id="error" hidden></div>
    </form>
    <div class="note" id="said" hidden></div>
  `);

  form('#form', () => saveVenueSettings(load));
}

function settingGroup(group: { title: string; note?: string; fields: Field[] }, load: SettingsLoad): string {
  return `
    <h2>${esc(group.title)}</h2>
    ${group.note ? `<p class="dim">${esc(group.note)}</p>` : ''}
    <div class="rows">
      ${group.fields.map((field) => settingField(field, load)).join('')}
    </div>`;
}

/**
 * One setting, as a row.
 *
 * A row rather than a stacked label-over-input, because `form.panel`'s column
 * layout is on the *form* and these are groups inside one — and a settings
 * sheet whose labels have come away from their boxes is worse than no screen:
 * the boxes are all short numbers and every one of them looks like every
 * other. Found by looking at it.
 */
function settingField(field: Field, load: SettingsLoad): string {
  const [section, key] = field.path.split('.') as [string, string];
  const value = load.settings[section]?.[key];
  const source = load.sources[field.path] ?? 'default';
  // Only a flag is worth saying out loud. "default" and "file" both just mean
  // "this is the number", and a badge on every row is a badge nobody reads.
  const flagged =
    source === 'flag'
      ? `<br><span class="dim">set by a flag for this run — saving here takes it back</span>`
      : '';
  const id = `set-${field.path.replace('.', '-')}`;

  const control =
    field.kind === 'switch'
      ? `<select id="${id}" data-path="${esc(field.path)}" data-kind="switch">
           <option value="yes"${value === true ? ' selected' : ''}>Yes</option>
           <option value="no"${value === true ? '' : ' selected'}>No</option>
         </select>`
      : `<input class="setting" id="${id}" data-path="${esc(field.path)}" data-kind="${field.kind}" value="${
          value === null || value === undefined ? '' : esc(String(value))
        }" />`;

  return `<div class="row">
    <label class="grow" for="${id}">${esc(field.label)}${
      field.note ? `<br><span class="dim">${esc(field.note)}</span>` : ''
    }${flagged}</label>
    ${control}
  </div>`;
}

async function saveVenueSettings(load: SettingsLoad): Promise<string | null> {
  const change: Record<string, Record<string, unknown>> = {};
  for (const element of view.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-path]')) {
    const path = element.dataset.path!;
    const [section, key] = path.split('.') as [string, string];
    const kind = element.dataset.kind as FieldKind;
    const raw = element.value.trim();

    let next: unknown;
    if (kind === 'switch') next = raw === 'yes';
    else if (raw === '') {
      if (kind !== 'nullable') return `${path} cannot be left empty.`;
      next = null;
    } else {
      next = Number(raw);
      if (!Number.isFinite(next as number)) return `${path} must be a number.`;
    }

    // Only what actually changed. A change that named every key would take
    // every flag back at once, and somebody adjusting one number has not asked
    // for that.
    if (next === (load.settings[section]?.[key] ?? null)) continue;
    (change[section] ??= {})[key] = next;
  }

  if (Object.keys(change).length === 0) return 'Nothing has changed.';

  const res = await api<SettingsLoad & { ok: boolean; reason?: string }>('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(change),
  });
  if (!res.ok) return res.reason ?? 'that did not work';

  renderSettings(res);
  const said = view.querySelector('#said') as HTMLElement;
  // The file's own complaints, in the file's own words — an out-of-range
  // number is clamped rather than refused, and the screen would be lying if it
  // showed the number back without saying that happened.
  const lines = [...(res.complaints ?? []), ...(res.budget.warnings ?? [])];
  said.textContent = lines.length ? lines.join(' · ') : 'Saved, and in force now.';
  said.hidden = false;
  return null;
}

// ----------------------------------------------------------------- plumbing

function value(selector: string): string {
  return (view.querySelector(selector) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? '';
}

/** Submit handling, with the failure shown where the person is looking. */
function form(selector: string, submit: () => Promise<string | null>): void {
  const element = view.querySelector(selector) as HTMLFormElement;
  element.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = element.querySelector('#error') as HTMLElement;
    error.hidden = true;
    const button = element.querySelector('button[type=submit]') as HTMLButtonElement;
    button.disabled = true;
    try {
      const reason = await submit();
      if (reason) {
        error.textContent = reason;
        error.hidden = false;
      }
    } finally {
      button.disabled = false;
    }
  });
}

void go(location.pathname, true);
