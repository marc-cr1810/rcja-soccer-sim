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
  account: { slug: string; displayName: string; role: string } | null;
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
];

/** Refreshed while something is live, cleared on every navigation. */
let ticking: ReturnType<typeof setInterval> | null = null;

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
  else if (me.can.referee) links.push(['/referee/', 'Referee']);
  else if (me.account) links.push(['/team', 'My team']);

  nav.innerHTML = links
    .map(
      ([href, text]) =>
        `<a href="${href}"${href.startsWith('/referee') ? ' data-full' : ''} class="${
          location.pathname === href ? 'on' : ''
        }">${text}</a>`,
    )
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
  homeGoals?: number;
  awayGoals?: number;
  completedAt?: string;
  state?: string;
}

interface Live {
  fixtureId: string;
  home: string;
  away: string;
  score: { violet: number; lime: number };
  clock: number;
  half: 1 | 2;
  running: boolean;
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
    href: `/m/${encodeURIComponent(live.fixtureId)}`,
    home: live.home,
    away: live.away,
    homeGoals: live.score.violet,
    awayGoals: live.score.lime,
    state: [live.running ? 'live' : 'stopped', half, clock(live.clock)],
    live: live.running,
  });
}

/** A fixture as a line on a sheet: who, the score if there is one, and where it got to. */
function fixtureRow(card: Card): string {
  const played = card.state === 'played';
  return h(`
    <a class="row" href="/m/${encodeURIComponent(card.id)}">
      <span class="grow">${esc(card.home)}<span class="v">v</span>${esc(card.away)}</span>
      ${played ? `<span class="score">${card.homeGoals ?? 0}&ndash;${card.awayGoals ?? 0}</span>` : ''}
      <span class="state ${card.state === 'playing' ? 'playing' : ''}">${
        played ? esc(when(card.completedAt ?? '')) : esc(card.state ?? '')
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
    tournament: { name: string; fixtures: number } | null;
    live: Live | null;
    next: Card | null;
    upcoming: Card[];
    recent: Card[];
    table: Standing[];
  }
  const data = await api<Front>('/api/front');

  if (!data.tournament) {
    view.innerHTML = h(`
      <h1>RCJA Soccer Simulation</h1>
      <p class="dim">No tournament is loaded on this server yet.</p>
      <div class="empty">When a draw is running, this page shows what is on now, what is next and what has been played.</div>
    `);
    return;
  }

  const recent = data.recent.map((card) => ({ ...card, state: 'played' }));
  const denied = new URLSearchParams(location.search).get('denied');
  view.innerHTML = h(`
    ${denied ? `<div class="error">Your account may not open that page.</div>` : ''}
    <h1>${esc(data.tournament.name)}</h1>
    <p class="dim">${data.tournament.fixtures} fixtures. Watching is open to anybody.</p>

    <h2>On now</h2>
    ${
      data.live
        ? `${liveScoreline(data.live)}
           <p style="margin-top:1rem"><a href="/live/" data-full>Watch the match</a></p>`
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
  if (data.live) ticking = setInterval(() => void front(), 3000);
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
async function matchPage(fixtureId: string): Promise<void> {
  interface MatchData {
    ok: boolean;
    reason?: string;
    fixture: { home: string; away: string };
    state: string;
    live: Live | null;
    record: {
      completedAt: string;
      submissions: Record<string, string>;
      verdict: { homeGoals: number; awayGoals: number; outcome: string };
      legs: {
        seed: unknown;
        score: { violet: number; lime: number };
        clock: number;
        events: { at: number; kind: string; rule: string; message: string }[];
      }[];
    } | null;
  }
  const data = await api<MatchData>(`/api/match/${encodeURIComponent(fixtureId)}`);
  if (!data.ok) {
    view.innerHTML = h(`<h1>Unknown match</h1><p class="dim">${esc(data.reason ?? '')}</p>`);
    return;
  }

  const head = h(`
    <h1>${esc(data.fixture.home)}<span class="v">v</span>${esc(data.fixture.away)}</h1>
  `);

  if (data.state === 'playing' && data.live) {
    view.innerHTML = head + h(`
      ${liveScoreline(data.live)}
      <p style="margin-top:1rem"><a href="/live/" data-full>Watch the match</a></p>
    `);
    ticking = setInterval(() => void matchPage(fixtureId), 3000);
    return;
  }

  if (!data.record) {
    view.innerHTML = head + h(`<div class="empty">Not played yet.</div>`);
    return;
  }

  const record = data.record;
  view.innerHTML = head + h(`
    <p class="dim">Finished ${esc(when(record.completedAt))}. ${
      record.verdict.outcome === 'drawn'
        ? 'It was a draw'
        : `${esc(record.verdict.outcome === 'won' ? data.fixture.home : data.fixture.away)} took it`
    }, ${record.verdict.homeGoals}&ndash;${record.verdict.awayGoals}.</p>

    ${record.legs
      .map(
        (leg, index) => `
        <h2>Leg ${index + 1}</h2>
        <p class="dim">${leg.score.violet}&ndash;${leg.score.lime} over ${clock(leg.clock)},
          on seed <span class="mono">${esc(seedText(leg.seed))}</span>. Replaying that seed
          replays this match.</p>
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
    <p class="dim">Teams, referees and organisers. Watching needs no account.</p>
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
    // The referee console is its own bundle, so going there is a real
    // navigation rather than a route change.
    if (next.startsWith('/referee')) location.href = next;
    else await go(next);
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

/**
 * A team's one screen.
 *
 * Phase 6's version answers the two questions a team has today — where is my
 * code, and when do I play. The changing "what do I do now" state, the Run
 * button and a field of their own are Phases 8 and 9; this does not pretend to
 * them.
 */
async function dashboard(): Promise<void> {
  if (!me.account) return void go('/login?next=%2Fteam');
  const mine = me.account;
  const data = await api<{ fixtures: Card[]; table: Standing | null }>(
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

    <h2>Your fixtures</h2>
    ${data.fixtures.length ? `<div class="rows">${data.fixtures.map(fixtureRow).join('')}</div>` : `<div class="empty">You are not in the current draw.</div>`}
  `);
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

/**
 * Enough administration to run a venue without an ssh session.
 *
 * Phase 10 is the real admin area. What is here is what Phase 6 itself creates
 * and therefore has to be able to undo: who exists, and who may register.
 */
async function admin(): Promise<void> {
  if (!me.can.admin) return void go('/login?next=%2Fadmin');
  const [accounts, invites] = await Promise.all([
    api<{ accounts: { id: string; slug: string; displayName: string; role: string; disabled: boolean }[] }>(
      '/api/admin/accounts',
    ),
    api<{ invites: { code: string; role: string; team: string | null; usedAt: string | null }[] }>(
      '/api/admin/invites',
    ),
  ]);

  view.innerHTML = h(`
    <h1>Administration</h1>

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
      invites.invites.length
        ? `<div class="rows">${invites.invites
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

    <h2>Accounts</h2>
    <div class="rows">
      ${accounts.accounts
        .map(
          (account) => `<div class="row">
            <span class="grow">${esc(account.displayName)}</span>
            <span class="state">${esc(account.slug)}</span>
            <span class="state">${esc(account.role)}${account.disabled ? ', disabled' : ''}</span>
          </div>`,
        )
        .join('')}
    </div>
  `);

  form('#form', async () => {
    const res = await api<{ ok: boolean; reason?: string; invite?: { code: string } }>('/api/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ role: value('#role'), team: value('#team') }),
    });
    if (!res.ok) return res.reason ?? 'that did not work';
    const fresh = document.getElementById('fresh')!;
    fresh.hidden = false;
    fresh.innerHTML = h(`Hand this over — it works once:
      <div class="mono" style="margin-top:.4rem">${esc(res.invite?.code)}</div>`);
    await admin();
    return null;
  });
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
