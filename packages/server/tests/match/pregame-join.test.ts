/**
 * Arriving for a match, and what that does to a team's robots.
 *
 * The other half of pre-game is in `referee-day.test.ts`, which drives the gate
 * against a fixture id and no child process at all — that file is about who may
 * end pre-game and what the checklist says while it is open. This one is about
 * robots actually moving, so every test here spawns a real fixture arena, and
 * the thing being defended is an invariant `occupancy.ts` has always *claimed*
 * and never kept:
 *
 * > During their match both robots are seated by the hub, so a team has nothing
 * > left to rehearse with.
 *
 * Until this slice that sentence was false. `openFixture` called `preempt`,
 * which released both teams' robots from every practice field and claimed
 * nothing in their place, so a team whose match was playing could walk away and
 * seat both robots on a new field. Nothing in the repository noticed, which is
 * exactly why it is worth the spawn.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LeagueServer } from '../../src/league/league';
import { sandboxAvailable } from '../../src/match/sandbox';
import { hashSubmission } from '../../src/accounts/submission';
import { makeDraw } from '../../src/league/tournament';
import { saveDraw } from '../../src/league/tournament-store';
import type { Fixture } from '../../src/league/tournament';

const PYTHON_LIB_DIR = resolve(import.meta.dirname, '../../../../python');
const PASSWORD = 'a-long-enough-password';

/** Spawning a real robot needs both halves of the sandbox — see lineup.test.ts. */
const canSpawn = spawnSync('python3', ['--version']).status === 0 && sandboxAvailable();

/** A robot that joins and then does nothing, which is all these tests need. */
const COAST_ROBOT = `
import argparse, time
from machine import ADC, PWM, Pin

parser = argparse.ArgumentParser()
parser.add_argument("--team", default="violet")
parser.add_argument("--number", type=int, default=1)
parser.add_argument("--name", default=None)
parser.add_argument("--url", default="ws://localhost:8080/agent")
parser.add_argument("--token", default=None)
args = parser.parse_args()

wheel = PWM(Pin(12), freq=1000, duty_u16=0)
ball = ADC(Pin(4))
while True:
    ball.read_u16()
    wheel.duty_u16(0)
    time.sleep_ms(20)
`;

/** The one that dies at import, which is what a student's bad afternoon is. */
const DEAD_ROBOT = 'import sys\nsys.exit(1)\n';

const servers: LeagueServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Started {
  server: LeagueServer;
  port: number;
  drawId: string;
  submissionsDir: string;
  /** Move the venue's clock forward, in minutes — the penalty clock's unit. */
  wait: (mins: number) => void;
}

/** A venue with a draw on disk and room for a fixture and a field at once. */
async function start(): Promise<Started> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcja-pregame-'));
  const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-sub-'));
  const workspacesDir = await mkdtemp(join(tmpdir(), 'rcja-ws-'));
  dirs.push(dataDir, submissionsDir, workspacesDir);

  const tournamentsDir = join(dataDir, 'tournaments');
  const draw = makeDraw(['Alpha', 'Bravo'], { name: 'test round' });
  await saveDraw(tournamentsDir, draw);

  let offset = 0;
  const server = new LeagueServer({
    port: 0,
    dataDir,
    tournamentsDir,
    tournamentId: draw.id,
    now: () => Date.now() + offset,
    settings: {
      arenas: { max: 3, concurrentFixtures: 1, seatCpuPercent: 50, seatMemoryMb: 512, reserveCores: 1 },
      practice: { open: true, max: null, idleMins: 20, graceMins: 5, perTeam: 2, claimSecs: 90 },
    },
    world: { realtime: false, submissionsDir, workspacesDir, pythonLibDir: PYTHON_LIB_DIR },
  });
  servers.push(server);
  return {
    server,
    port: await server.listen(),
    drawId: draw.id,
    submissionsDir,
    wait: (mins) => {
      offset += mins * 60_000;
    },
  };
}

async function call(
  started: Started,
  path: string,
  init: RequestInit & { cookie?: string | null } = {},
): Promise<{ status: number; payload: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  const res = await fetch(`http://127.0.0.1:${started.port}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
  });
  return { status: res.status, payload: await res.json().catch(() => null) };
}

async function signIn(started: Started, role: 'team' | 'admin', displayName: string): Promise<string> {
  const made = started.server.accounts.createAccount({ role, displayName, password: PASSWORD });
  if (!made.ok) throw new Error(made.reason);
  const res = await fetch(`http://127.0.0.1:${started.port}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: made.value.slug, password: PASSWORD }),
    redirect: 'manual',
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

/** A robot on disk, the way a validated push leaves one. */
async function push(started: Started, slug: string, robot: 1 | 2, code?: string): Promise<string> {
  const dir = join(started.submissionsDir, slug, String(robot));
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'manifest.json'), JSON.stringify({ team: slug, robot, entry: 'robot.py' }));
  await Bun.write(join(dir, 'robot.py'), code ?? `# ${slug} robot ${robot}\n`);
  await Bun.write(join(dir, 'token'), `token-${slug}-${robot}`);
  return hashSubmission(dir);
}

/** The referee's own view of a fixture, which is where the checklist lives. */
async function checklist(started: Started, cookie: string): Promise<Record<string, any>> {
  const { payload } = await call(started, '/api/referee/match/alpha-v-bravo', { cookie });
  const seats: Record<string, any> = {};
  for (const seat of payload.seats ?? []) seats[seat.id] = seat;
  return seats;
}

/**
 * Wait for a checklist to say something, or give up loudly.
 *
 * A sandboxed CPython process takes a moment to come up and a moment more to
 * be given up on, and neither is a number this repository should hard-code
 * into a sleep.
 */
async function settles(
  started: Started,
  cookie: string,
  done: (seats: Record<string, any>) => boolean,
  within = 25_000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + within;
  let seats: Record<string, any> = {};
  for (;;) {
    seats = await checklist(started, cookie);
    if (done(seats)) return seats;
    if (Date.now() > deadline) {
      const said = Object.values(seats).map((s) => `${s.id}=${s.program ?? '—'}`);
      throw new Error(`the checklist never settled: ${said.join(' ')}`);
    }
    await new Promise((ok) => setTimeout(ok, 250));
  }
}

const FIXTURE: Fixture = { id: 'alpha-v-bravo', home: 'Alpha', away: 'Bravo', seeds: [1] } as Fixture;

/** Everything Alpha and Bravo have pushed, which is all four robots. */
async function pushEverything(started: Started): Promise<void> {
  for (const slug of ['alpha', 'bravo']) {
    for (const robot of [1, 2] as const) await push(started, slug, robot);
  }
}

describe('arriving for a match', () => {
  it(
    'seats a team that turned up before the pitch did',
    async () => {
      const started = await start();
      const alpha = await signIn(started, 'team', 'Alpha');
      await pushEverything(started);

      // Nothing is running: this is a team walking up to a pitch that does not
      // exist yet, which is the whole reason arrival is a separate register
      // from the seat claim.
      const early = await call(started, '/api/team/match/alpha-v-bravo/arrive', {
        method: 'POST',
        cookie: alpha,
      });
      expect(early.status).toBe(200);
      expect(early.payload.ready).toBe(false);
      expect(started.server.occupancy.where('alpha', 1)).toBeNull();

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);

      // And the moment there is something to claim, it is claimed — by the
      // server, without the team pressing anything a second time.
      expect(started.server.occupancy.where('alpha', 1)).toMatchObject({
        arenaId,
        seatId: 'violet-1',
      });
      expect(started.server.occupancy.where('alpha', 2)?.seatId).toBe('violet-2');
      // Bravo did not turn up, so Bravo's robots are nowhere.
      expect(started.server.occupancy.where('bravo', 1)).toBeNull();
    },
    40_000,
  );

  it(
    'takes a team out of practice and will not let them back in',
    async () => {
      const started = await start();
      const alpha = await signIn(started, 'team', 'Alpha');
      await pushEverything(started);

      // Rehearsing right up to the whistle, which is what teams do.
      const field = await call(started, '/practice', { method: 'POST', cookie: alpha });
      expect(field.status).toBe(201);
      const fieldId = field.payload.field.id;
      const seated = await call(started, `/a/${fieldId}/practice-api/seat`, {
        method: 'POST',
        cookie: alpha,
        body: JSON.stringify({ seat: 'violet-1', fill: { kind: 'submission', team: 'Alpha' } }),
      });
      expect(seated.status).toBe(200);
      expect(started.server.occupancy.where('alpha', 1)?.arenaId).toBe(fieldId);

      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);

      // Pre-emption took the robot back, and — the part that did not happen
      // before this slice — the fixture is now holding it.
      expect(started.server.occupancy.where('alpha', 1)).toMatchObject({
        arenaId,
        seatId: 'violet-1',
      });

      // So the field they were on cannot have it, and neither can a new one.
      // This is the invariant the whole ledger exists for, kept for the first
      // time at the only moment it actually matters.
      const again = await call(started, '/practice', { method: 'POST', cookie: alpha });
      const other = again.payload.field?.id ?? fieldId;
      const refused = await call(started, `/a/${other}/practice-api/seat`, {
        method: 'POST',
        cookie: alpha,
        body: JSON.stringify({ seat: 'violet-1', fill: { kind: 'submission', team: 'Alpha' } }),
      });
      expect(refused.status).toBe(409);
      // And the refusal names the match rather than "another field" — a team
      // sent looking for a field during their own game finds nothing, and
      // there is no seat here for them to take the robot out of anyway.
      expect(refused.payload.reason).toContain('robot 1 is in the violet-1 seat in your match');
      expect(refused.payload.reason).toContain('comes back when the match is over');
    },
    40_000,
  );

  it(
    'seats a team that turns up after the pitch is already open',
    async () => {
      const started = await start();
      const alpha = await signIn(started, 'team', 'Alpha');
      await pushEverything(started);

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      void started.server.awaitLineup(FIXTURE, started.drawId, arenaId).catch(() => {});
      expect(started.server.occupancy.where('alpha', 1)).toBeNull();

      const arrived = await call(started, '/api/team/match/alpha-v-bravo/arrive', {
        method: 'POST',
        cookie: alpha,
      });
      expect(arrived.payload.ready).toBe(true);
      expect(started.server.occupancy.where('alpha', 2)).toMatchObject({
        arenaId,
        seatId: 'violet-2',
      });

      // Their own screen reads the same thing back, which is the only way a
      // team ever sees any of this.
      const mine = await call(started, '/api/team/alpha', { cookie: alpha });
      expect(mine.payload.yours.match.id).toBe('alpha-v-bravo');
      expect(mine.payload.yours.match.arrived).toBe(true);
      expect(mine.payload.yours.match.seats.map((s: any) => s.id)).toEqual(['violet-1', 'violet-2']);
    },
    40_000,
  );

  it(
    'answers a second press on Start without complaining',
    async () => {
      const started = await start();
      const organiser = await signIn(started, 'admin', 'Organiser');
      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      void started.server.awaitLineup(FIXTURE, started.drawId, arenaId).catch(() => {});

      // Starting a match makes four sandboxed interpreters come up, which takes
      // a moment, and a referee who sees nothing happen presses again.
      expect((await call(started, '/api/referee/match/alpha-v-bravo/start', {
        method: 'POST',
        cookie: organiser,
      })).status).toBe(200);
      const again = await call(started, '/api/referee/match/alpha-v-bravo/start', {
        method: 'POST',
        cookie: organiser,
      });
      expect(again.status).toBe(200);
      expect(again.payload.already).toBe(true);
    },
    40_000,
  );
});

/**
 * The other half of arriving: the robots themselves.
 *
 * Until this slice a fixture arena held no world at all until the referee
 * pressed start, and four sandboxed interpreters came up at the whistle. A
 * submission that would not start was therefore found ten seconds *after* the
 * decision to play had been made, and `waitForSeats` threw — so the fixture
 * did not play at all, wrote nothing, and was simply replayed into the same
 * wall. The team could have fixed it in the twenty minutes nobody was using.
 *
 * So the robots start when their team arrives, and what each program is doing
 * is on the checklist while there is still time to do something about it.
 */
describe.skipIf(!canSpawn)('robots that start when their team arrives', () => {
  it(
    'starts the arriving team\'s robots, and nobody else\'s',
    async () => {
      const started = await start();
      const organiser = await signIn(started, 'admin', 'Organiser');
      const alpha = await signIn(started, 'team', 'Alpha');
      for (const robot of [1, 2] as const) {
        await push(started, 'alpha', robot, COAST_ROBOT);
        await push(started, 'bravo', robot, COAST_ROBOT);
      }

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      void started.server.awaitLineup(FIXTURE, started.drawId, arenaId).catch(() => {});

      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
      const seats = await settles(
        started,
        organiser,
        (s) => s['violet-1']?.program === 'on-field' && s['violet-2']?.program === 'on-field',
      );

      // Bravo have not turned up, so nothing of theirs has been started — the
      // arena has never been told they exist, and says nothing rather than
      // guessing.
      expect(seats['lime-1'].program).toBeUndefined();
      expect(seats['lime-2'].program).toBeUndefined();
      expect(seats['lime-1'].detail).toContain('have not arrived');
    },
    60_000,
  );

  it(
    'says which robot will not start, and still counts the team as here',
    async () => {
      const started = await start();
      const organiser = await signIn(started, 'admin', 'Organiser');
      const alpha = await signIn(started, 'team', 'Alpha');
      const bravo = await signIn(started, 'team', 'Bravo');
      await push(started, 'alpha', 1, COAST_ROBOT);
      await push(started, 'alpha', 2, DEAD_ROBOT);
      for (const robot of [1, 2] as const) await push(started, 'bravo', robot, COAST_ROBOT);

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      void started.server.awaitLineup(FIXTURE, started.drawId, arenaId).catch(() => {});
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: bravo });

      const seats = await settles(
        started,
        organiser,
        (s) => s['violet-2']?.program === 'would-not-start',
      );
      expect(seats['violet-1'].program).toBe('on-field');
      expect(seats['violet-2'].detail).toContain('would not start');

      // And this is the decision that was taken in this round: it is a
      // sentence on a checklist and nothing else. Alpha pushed a robot, Alpha
      // are standing at the pitch, so Alpha are here — the seat is still
      // claimed, the team is still ready, and a program that will not compile
      // is not the same thing as a team that did not come.
      expect(seats['violet-2'].seated).toBe(true);

      const clock = await call(started, '/api/referee/match/alpha-v-bravo/penalty', {
        method: 'POST',
        cookie: organiser,
        body: JSON.stringify({ on: true }),
      });
      expect(clock.status).toBe(200);
      started.wait(5);
      await started.server.sweepPregames();
      const { payload } = await call(started, '/api/referee/match/alpha-v-bravo', { cookie: organiser });
      // Five minutes with a dead program is five minutes of nothing. Both
      // teams are here, so there is nobody to be late.
      expect(payload.pregame.penalty.goals).toEqual({ violet: 0, lime: 0 });
      expect(payload.state).toBe('pregame');
    },
    60_000,
  );

  it(
    'restarts a robot that would not start when the team says they are here again',
    async () => {
      const started = await start();
      const organiser = await signIn(started, 'admin', 'Organiser');
      const alpha = await signIn(started, 'team', 'Alpha');
      await push(started, 'alpha', 1, COAST_ROBOT);
      await push(started, 'alpha', 2, DEAD_ROBOT);

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      void started.server.awaitLineup(FIXTURE, started.drawId, arenaId).catch(() => {});
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
      await settles(started, organiser, (s) => s['violet-2']?.program === 'would-not-start');

      // The fix, pushed from the next table, and the same button pressed
      // again. Nothing else in the server has moved.
      await push(started, 'alpha', 2, COAST_ROBOT);
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });

      const seats = await settles(started, organiser, (s) => s['violet-2']?.program === 'on-field');
      expect(seats['violet-1'].program).toBe('on-field');
    },
    60_000,
  );

  it(
    'plays the match on the code each robot was actually started with',
    async () => {
      const started = await start();
      const alpha = await signIn(started, 'team', 'Alpha');
      const bravo = await signIn(started, 'team', 'Bravo');
      const organiser = await signIn(started, 'admin', 'Organiser');
      const asStarted = await push(started, 'alpha', 1, COAST_ROBOT);
      await push(started, 'alpha', 2, COAST_ROBOT);
      await push(started, 'bravo', 1, COAST_ROBOT);
      await push(started, 'bravo', 2, DEAD_ROBOT);

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      void started.server.awaitLineup(FIXTURE, started.drawId, arenaId).catch(() => {});
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: bravo });
      await settles(
        started,
        organiser,
        (s) =>
          s['violet-1']?.program === 'on-field' &&
          s['lime-1']?.program === 'on-field' &&
          s['lime-2']?.program === 'would-not-start',
      );

      // A push that lands after the robot is already running. The folder on
      // disk is now different code to the program in memory, and the match
      // record has to name the one that plays — otherwise a team could swap
      // their code out from under a hash nobody would ever question.
      const afterwards = await push(started, 'alpha', 1, `${COAST_ROBOT}\n# a later idea\n`);
      expect(afterwards).not.toBe(asStarted);

      const played = await started.server.playLeg('alpha-v-bravo', {
        teams: { violet: 'Alpha', lime: 'Bravo' },
        seed: 1,
        halfSeconds: 1,
        refereed: false,
      });
      expect(played.submissions['violet-1']).toBe(asStarted);
      expect(played.submissions['violet-1']).not.toBe(afterwards);

      // And the seat whose program never came up is *absent*, which is the
      // meaning `FixtureResult.submissions` has always carried: a seat missing
      // from here was filled by the built-in agent. Listing Bravo's hash
      // beside football their code did not play would put their name on it.
      expect(played.submissions['lime-1']).toBeDefined();
      expect(played.submissions['lime-2']).toBeUndefined();
    },
    90_000,
  );
});

/**
 * The lineup lock: the moment a push stops reaching this match.
 *
 * Everything here is about a copy. Locking a seat copies its folder into the
 * arena and starts the program from the copy, because a read-only bind is not
 * a lock — `TeamApi.keep` replaces the folder in the submissions tree
 * outright, and every respawn is a fresh sandbox binding that path again. A
 * flag would have looked identical in every test that did not push twice.
 */
describe.skipIf(!canSpawn)('the lineup lock', () => {
  /** The same robot with a different hash: connects the same, reads different. */
  const LATER_ROBOT = `${COAST_ROBOT}\n# a later idea\n`;

  it(
    'restarts a seat running older code than its team has since pushed',
    async () => {
      const started = await start();
      const alpha = await signIn(started, 'team', 'Alpha');
      const bravo = await signIn(started, 'team', 'Bravo');
      const organiser = await signIn(started, 'admin', 'Organiser');
      const first = await push(started, 'alpha', 1, COAST_ROBOT);
      await push(started, 'alpha', 2, COAST_ROBOT);
      await push(started, 'bravo', 1, COAST_ROBOT);
      await push(started, 'bravo', 2, COAST_ROBOT);

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      void started.server.awaitLineup(FIXTURE, started.drawId, arenaId).catch(() => {});
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: bravo });
      await settles(started, organiser, (s) => s['violet-1']?.program === 'on-field');

      // Alpha fix something and do not press anything, which is the ordinary
      // case: the robot on the field is now behind the folder on disk.
      const second = await push(started, 'alpha', 1, LATER_ROBOT);
      expect(second).not.toBe(first);

      // And the checklist says so before anybody locks, which is the point of
      // saying it: while it is still the team's own to fix.
      const before = await checklist(started, organiser);
      expect(before['violet-1'].loaded.hash).toBe(first);
      expect(before['violet-1'].pushed.hash).toBe(second);
      expect(before['violet-1'].detail).toContain('not the newest push');

      const locked = await call(started, '/api/referee/match/alpha-v-bravo/lock', {
        method: 'POST',
        cookie: organiser,
      });
      expect(locked.status, JSON.stringify(locked.payload)).toBe(200);
      expect(locked.payload.lockedAt).toBeTruthy();

      const after = await settles(
        started,
        organiser,
        (s) => s['violet-1']?.loaded?.hash === second && s['violet-1']?.program === 'on-field',
      );
      expect(after['violet-1'].detail).toBeUndefined();
      // Nobody else's robot was behind, so nobody else's was disturbed.
      expect(after['lime-1'].program).toBe('on-field');
      expect(after['lime-1'].loaded.hash).toBe(after['lime-1'].pushed.hash);

      const played = await started.server.playLeg('alpha-v-bravo', {
        teams: { violet: 'Alpha', lime: 'Bravo' },
        seed: 1,
        halfSeconds: 1,
        refereed: false,
      });
      expect(played.submissions['violet-1']).toBe(second);
    },
    120_000,
  );

  it(
    'locks the code of a team who never arrived, and a push after it does not get in',
    async () => {
      const started = await start();
      const alpha = await signIn(started, 'team', 'Alpha');
      const organiser = await signIn(started, 'admin', 'Organiser');
      await push(started, 'alpha', 1, COAST_ROBOT);
      await push(started, 'alpha', 2, COAST_ROBOT);
      const bravoAt = await push(started, 'bravo', 1, COAST_ROBOT);
      await push(started, 'bravo', 2, COAST_ROBOT);

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      void started.server.awaitLineup(FIXTURE, started.drawId, arenaId).catch(() => {});
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
      await settles(started, organiser, (s) => s['violet-1']?.program === 'on-field');
      // Bravo are not here, so nothing of theirs has been started.
      expect((await checklist(started, organiser))['lime-1'].program).toBeUndefined();

      // Locking is what fills in for a team who never turned up: their code is
      // copied and started now rather than read off disk at the whistle.
      await call(started, '/api/referee/match/alpha-v-bravo/lock', { method: 'POST', cookie: organiser });
      await settles(started, organiser, (s) => s['lime-1']?.program === 'on-field');
      expect((await checklist(started, organiser))['lime-1'].loaded.hash).toBe(bravoAt);

      // Bravo push after the lock. It is kept, and it is not in this match.
      const later = await push(started, 'bravo', 1, LATER_ROBOT);
      expect(later).not.toBe(bravoAt);

      const played = await started.server.playLeg('alpha-v-bravo', {
        teams: { violet: 'Alpha', lime: 'Bravo' },
        seed: 1,
        halfSeconds: 1,
        refereed: false,
      });
      expect(played.submissions['lime-1']).toBe(bravoAt);
      expect(played.submissions['lime-1']).not.toBe(later);
    },
    120_000,
  );

  it(
    'restarts the locked copy when a team says they are here again, not the new push',
    async () => {
      const started = await start();
      const alpha = await signIn(started, 'team', 'Alpha');
      const organiser = await signIn(started, 'admin', 'Organiser');
      await push(started, 'alpha', 1, COAST_ROBOT);
      // The robot that will not start, which is what a team presses the button
      // again *for* — and the one case where the lock has to be able to say no.
      await push(started, 'alpha', 2, DEAD_ROBOT);
      await push(started, 'bravo', 1, COAST_ROBOT);
      await push(started, 'bravo', 2, COAST_ROBOT);

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      void started.server.awaitLineup(FIXTURE, started.drawId, arenaId).catch(() => {});
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
      await settles(
        started,
        organiser,
        (s) => s['violet-1']?.program === 'on-field' && s['violet-2']?.program === 'would-not-start',
      );

      await call(started, '/api/referee/match/alpha-v-bravo/lock', { method: 'POST', cookie: organiser });
      await settles(started, organiser, (s) => s['violet-2']?.program === 'would-not-start');

      // A real fix, pushed too late, and the button that would have loaded it
      // five minutes ago. It restarts the copy that was locked, so the robot is
      // still the one that will not start.
      const fixed = await push(started, 'alpha', 2, COAST_ROBOT);
      const arrived = await call(started, '/api/team/match/alpha-v-bravo/arrive', {
        method: 'POST',
        cookie: alpha,
      });
      expect(arrived.status).toBe(200);
      const seats = await settles(
        started,
        organiser,
        (s) => s['violet-2']?.program === 'would-not-start',
      );
      expect(seats['violet-2'].pushed.hash).toBe(fixed);
      expect(seats['violet-2'].loaded?.hash).not.toBe(fixed);

      // And the referee can still let it in, because pressing Lock again is
      // the unlock — which is why there is no second button.
      await call(started, '/api/referee/match/alpha-v-bravo/lock', { method: 'POST', cookie: organiser });
      const back = await settles(
        started,
        organiser,
        (s) => s['violet-2']?.program === 'on-field',
        40_000,
      );
      expect(back['violet-2'].loaded.hash).toBe(fixed);
    },
    180_000,
  );

  it(
    'tells a team pushing into a locked match that it is for their next game',
    async () => {
      const started = await start();
      const alpha = await signIn(started, 'team', 'Alpha');
      const organiser = await signIn(started, 'admin', 'Organiser');
      await push(started, 'alpha', 1, COAST_ROBOT);
      await push(started, 'alpha', 2, COAST_ROBOT);
      await push(started, 'bravo', 1, COAST_ROBOT);
      await push(started, 'bravo', 2, COAST_ROBOT);

      const minted = await call(started, '/api/keys', {
        method: 'POST',
        cookie: alpha,
        body: JSON.stringify({ label: 'test' }),
      });
      const key = minted.payload.key as string;
      const files = {
        'manifest.json': Buffer.from(
          JSON.stringify({ team: 'Alpha', robot: 1, entry: 'robot.py' }),
        ).toString('base64'),
        'robot.py': Buffer.from(COAST_ROBOT).toString('base64'),
      };
      // Not through `call`, which speaks in session cookies: a push carries a
      // minted key instead, the way `python/submit.py` sends one.
      const submit = async (): Promise<{ status: number; payload: any }> => {
        const res = await fetch(`http://127.0.0.1:${started.port}/submit`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ files }),
        });
        return { status: res.status, payload: await res.json().catch(() => null) };
      };

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      void started.server.awaitLineup(FIXTURE, started.drawId, arenaId).catch(() => {});
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });

      // Before the lock there is nothing to warn about: this push is in.
      const early = await submit();
      expect(early.status, JSON.stringify(early.payload)).toBe(200);
      expect(early.payload.notice).toBeUndefined();

      await call(started, '/api/referee/match/alpha-v-bravo/lock', { method: 'POST', cookie: organiser });

      // After it, the push is still kept — it is their code from the next game
      // on — and the reply is where they find out, rather than a page they may
      // not be looking at.
      const late = await submit();
      expect(late.status, JSON.stringify(late.payload)).toBe(200);
      expect(late.payload.notice).toContain('already locked');
      expect(late.payload.notice).toContain('Bravo');
    },
    120_000,
  );
});

/**
 * Half-time: the one window in a match where a team may change their code.
 *
 * The whole of it end to end, with four sandboxed interpreters actually
 * running: a match kicked off, a fix pushed between the halves, the referee
 * taking it in, both teams saying they are ready, and the record carrying both
 * hashes because both of them played.
 */
describe.skipIf(!canSpawn)('half-time', () => {
  const LATER_ROBOT = `${COAST_ROBOT}\n# a half-time fix\n`;

  /** The console's own surface, reached the way a referee's browser reaches it. */
  function refereeAction(
    started: Started,
    arenaId: string,
    action: string,
    cookie: string,
    body?: unknown,
  ): Promise<{ status: number; payload: any }> {
    return call(started, `/a/${arenaId}/referee-api/${action}`, {
      method: 'POST',
      cookie,
      body: JSON.stringify(body ?? {}),
    });
  }

  /**
   * The first whistle, once there is a match to blow it at.
   *
   * `playLeg` answers the moment the arena accepts the request, and the arena
   * then lets go of the lobby, starts anything that is not up and builds the
   * match — none of which is instant with four sandboxed interpreters. Until
   * it has, the console's own answer is "no refereed match in progress", which
   * is exactly right and is not what this test is about.
   */
  async function kickOff(
    started: Started,
    arenaId: string,
    team: 'violet' | 'lime',
    cookie: string,
    within = 30_000,
  ): Promise<{ status: number; payload: any }> {
    const deadline = Date.now() + within;
    for (;;) {
      const answer = await refereeAction(started, arenaId, 'kickoff', cookie, { team });
      if (answer.payload?.reason !== 'no refereed match in progress') return answer;
      if (Date.now() > deadline) return answer;
      await new Promise((ok) => setTimeout(ok, 250));
    }
  }

  /** Poll the hub until it says something about the match in progress. */
  async function until(
    started: Started,
    cookie: string,
    done: (payload: any) => boolean,
    within = 30_000,
  ): Promise<any> {
    const deadline = Date.now() + within;
    for (;;) {
      const { payload } = await call(started, '/api/referee/match/alpha-v-bravo', { cookie });
      if (done(payload)) return payload;
      if (Date.now() > deadline) {
        throw new Error(`the match never got there: ${JSON.stringify(payload?.halfTime ?? payload?.live)}`);
      }
      await new Promise((ok) => setTimeout(ok, 250));
    }
  }

  it(
    'takes a fix in between the halves, and both hashes are in the record',
    async () => {
      const started = await start();
      const alpha = await signIn(started, 'team', 'Alpha');
      const bravo = await signIn(started, 'team', 'Bravo');
      const organiser = await signIn(started, 'admin', 'Organiser');
      const first = await push(started, 'alpha', 1, COAST_ROBOT);
      await push(started, 'alpha', 2, COAST_ROBOT);
      await push(started, 'bravo', 1, COAST_ROBOT);
      await push(started, 'bravo', 2, COAST_ROBOT);

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      const gate = started.server.awaitLineup(FIXTURE, started.drawId, arenaId);
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: bravo });
      await settles(started, organiser, (s) => s['violet-1']?.program === 'on-field');
      await call(started, '/api/referee/match/alpha-v-bravo/lock', { method: 'POST', cookie: organiser });
      // Pre-game closed properly, because half-time is the *other* room and
      // the one button has to find the right one of the two.
      await call(started, '/api/referee/match/alpha-v-bravo/start', { method: 'POST', cookie: organiser });
      await gate;

      // A refereed match, so nothing happens until somebody blows a whistle —
      // which is the only kind of match that can have a half-time at all.
      const playing = started.server.playLeg('alpha-v-bravo', {
        teams: { violet: 'Alpha', lime: 'Bravo' },
        seed: 1,
        halfSeconds: 1,
        refereed: true,
        halfTimeSeconds: 300,
      });

      await until(started, organiser, (p) => p.state === 'playing' && p.console !== null);
      const kicked = await kickOff(started, arenaId, 'violet', organiser);
      expect(kicked.status, JSON.stringify(kicked.payload)).toBe(200);

      // One second of football, and then the break.
      const atHalfTime = await until(started, organiser, (p) => p.halfTime !== null);
      expect(atHalfTime.halfTime.ready).toEqual({ violet: false, lime: false });
      expect(atHalfTime.halfTime.over).toBe(false);

      // The whistle is held, and the refusal says who it is waiting on.
      const early = await refereeAction(started, arenaId, 'kickoff', organiser, { team: 'lime' });
      expect(early.status).toBe(409);
      expect(early.payload.reason).toContain('Alpha');
      expect(early.payload.reason).toContain('Bravo');

      // Alpha fix something. A push at half-time is kept and is not hopeless:
      // it reaches the second half if the referee takes it in.
      const second = await push(started, 'alpha', 1, LATER_ROBOT);
      expect(second).not.toBe(first);

      const took = await call(started, '/api/referee/match/alpha-v-bravo/lock', {
        method: 'POST',
        cookie: organiser,
      });
      expect(took.status, JSON.stringify(took.payload)).toBe(200);

      // The restarted program rejoins the match in progress — it is not sent
      // off under 5.7.1, because a program that stops while play is stopped has
      // not failed at anything.
      await settles(
        started,
        organiser,
        (s) => s['violet-1']?.loaded?.hash === second && s['violet-1']?.program === 'on-field',
      );

      // Both teams say they are ready, and only then does the whistle come back.
      expect(
        (await call(started, '/api/team/match/alpha-v-bravo/ready', { method: 'POST', cookie: alpha }))
          .status,
      ).toBe(200);
      const stillHeld = await refereeAction(started, arenaId, 'kickoff', organiser, { team: 'lime' });
      expect(stillHeld.status).toBe(409);
      expect(stillHeld.payload.reason).toContain('Bravo');
      expect(stillHeld.payload.reason).not.toContain('Alpha');

      expect(
        (await call(started, '/api/team/match/alpha-v-bravo/ready', { method: 'POST', cookie: bravo }))
          .status,
      ).toBe(200);
      const second_half = await refereeAction(started, arenaId, 'kickoff', organiser, { team: 'lime' });
      expect(second_half.status, JSON.stringify(second_half.payload)).toBe(200);

      const played = await playing;
      // The whole point, in two lines: the code each seat started on, and the
      // code that played the half after the referee took the fix in.
      expect(played.submissions['violet-1']).toBe(first);
      expect(played.secondHalf?.['violet-1']).toBe(second);
      // Nobody else changed anything, so nobody else's record moved.
      expect(played.secondHalf?.['lime-1']).toBe(played.submissions['lime-1']);
    },
    180_000,
  );

  it(
    'writes no second half at all when nobody pushes into the break',
    async () => {
      const started = await start();
      const alpha = await signIn(started, 'team', 'Alpha');
      const bravo = await signIn(started, 'team', 'Bravo');
      const organiser = await signIn(started, 'admin', 'Organiser');
      await push(started, 'alpha', 1, COAST_ROBOT);
      await push(started, 'alpha', 2, COAST_ROBOT);
      await push(started, 'bravo', 1, COAST_ROBOT);
      await push(started, 'bravo', 2, COAST_ROBOT);

      const arenaId = await started.server.openFixture(FIXTURE, started.drawId);
      const gate = started.server.awaitLineup(FIXTURE, started.drawId, arenaId);
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: alpha });
      await call(started, '/api/team/match/alpha-v-bravo/arrive', { method: 'POST', cookie: bravo });
      await settles(started, organiser, (s) => s['violet-1']?.program === 'on-field');
      await call(started, '/api/referee/match/alpha-v-bravo/start', { method: 'POST', cookie: organiser });
      await gate;

      const playing = started.server.playLeg('alpha-v-bravo', {
        teams: { violet: 'Alpha', lime: 'Bravo' },
        seed: 1,
        halfSeconds: 1,
        refereed: true,
        // Short, because this test waits it out for real: half-time runs on
        // the wall clock inside the arena's own process, which is the point of
        // it — a team fixing code lives in wall time — and so it is not
        // something a venue's `now` can be nudged past from out here.
        halfTimeSeconds: 5,
      });

      await until(started, organiser, (p) => p.state === 'playing' && p.console !== null);
      expect((await kickOff(started, arenaId, 'violet', organiser)).status).toBe(200);
      await until(started, organiser, (p) => p.halfTime !== null);

      // Nobody says anything and nobody pushes.
      const held = await refereeAction(started, arenaId, 'kickoff', organiser, { team: 'lime' });
      expect(held.status).toBe(409);

      // And the gate opens by itself, which is what keeps it from ever being
      // authority taken off a referee.
      await until(started, organiser, (p) => p.halfTime?.over === true);
      const freed = await refereeAction(started, arenaId, 'kickoff', organiser, { team: 'lime' });
      expect(freed.status, JSON.stringify(freed.payload)).toBe(200);

      const played = await playing;
      // A match nobody pushed to at half-time writes exactly the record it
      // always did — the field is not there at all.
      expect(played.secondHalf).toBeUndefined();
      expect(played.submissions['violet-1']).toBeTruthy();
    },
    180_000,
  );
});
