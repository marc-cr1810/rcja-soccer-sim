/**
 * The practice field, without the football.
 *
 * These are about the things a rehearsal adds to a match — who is on the
 * field, what drives them, where a restart goes back to, and what a goal does
 * — and deliberately not about play itself, which `match.test.ts` already
 * covers and which is the same code either way. Seats filled by a sandboxed
 * submission are verified live rather than here: they need `bwrap`, a cgroup
 * and a real push, and a test that mocked them would be testing the mock.
 */

import { MatchServer } from '../src/server';
import { PracticeSession } from '../src/practice';

const servers: MatchServer[] = [];

async function field(): Promise<PracticeSession> {
  const server = new MatchServer({ port: 0 });
  servers.push(server);
  await server.listen();
  return new PracticeSession(server, { submissionsDir: 'submissions' });
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** Step until a goal goes in, so what a restart did is read before play moves it. */
function runToGoal(session: PracticeSession, limit = 3, dt = 1 / 100): void {
  const before = session.match.world.score.violet;
  for (let t = 0; t < limit; t += dt) {
    session.syncSeats();
    session.match.step(dt);
    if (session.match.world.score.violet > before) return;
  }
  throw new Error('no goal was scored');
}

/** Step the field as the run loop would, without the loop's wall clock. */
function run(session: PracticeSession, seconds: number, dt = 1 / 100): void {
  for (let t = 0; t < seconds; t += dt) {
    session.syncSeats();
    session.match.step(dt);
  }
}

describe('a practice field', () => {
  it('opens as an ordinary kick-off everything is built-in', async () => {
    const session = await field();
    const state = session.state();

    expect(Object.values(state.seats).every((s) => s.fill.kind === 'built-in')).toBe(true);
    expect(state.arrangement.robots.map((r) => r.id).sort()).toEqual([
      'lime-1',
      'lime-2',
      'violet-1',
      'violet-2',
    ]);
    expect(state.running).toBe(false);
  });

  it('takes a robot out of the situation when its seat is emptied', async () => {
    const session = await field();
    await session.setSeat('violet-2', { kind: 'empty' });
    await session.setSeat('lime-1', { kind: 'empty' });
    await session.setSeat('lime-2', { kind: 'empty' });

    const state = session.state();
    expect(state.arrangement.robots.map((r) => r.id)).toEqual(['violet-1']);
    expect(session.match.world.robots.map((r) => r.id)).toEqual(['violet-1']);
    expect(state.seats['violet-1']!.filled).toBe(true);
    expect(state.seats['lime-1']!.filled).toBe(false);
  });

  it('moves only what was dragged, and remembers it for the restart', async () => {
    const session = await field();
    session.start();
    run(session, 1);

    const before = session.match.world.robots.map((r) => ({ id: r.id, x: r.x, z: r.z }));
    session.place('ball', { x: -400, z: 300 });

    for (const was of before) {
      const now = session.match.world.robots.find((r) => r.id === was.id)!;
      // Untouched by the drag: a robot only moves because it drove there.
      expect(now.x).toBe(was.x);
      expect(now.z).toBe(was.z);
    }
    expect(session.match.world.ball.x).toBe(-400);
    expect(session.state().arrangement.ball).toMatchObject({ x: -400, z: 300 });
  });

  it('puts the arrangement back out on a re-stage, and not before', async () => {
    const session = await field();
    session.place('violet-1', { x: -300, z: 200, heading: 0 });
    session.start();
    run(session, 2);

    const drifted = session.match.world.robots.find((r) => r.id === 'violet-1')!;
    expect(Math.hypot(drifted.x + 300, drifted.z - 200)).toBeGreaterThan(1);

    session.restage();
    const back = session.match.world.robots.find((r) => r.id === 'violet-1')!;
    expect(back.x).toBe(-300);
    expect(back.z).toBe(200);
  });

  it('holds the field still on a goal when it is set to freeze', async () => {
    const session = await field();
    // Nobody in the way of the shot: the keeper is not what is being tested.
    await session.setSeat('lime-2', { kind: 'empty' });
    session.setResolve('freeze');
    session.start();
    // Rolling at the yellow goal, which Violet attacks in the first half.
    session.place('ball', { x: 600, z: 0, vx: 3000 });
    run(session, 2);

    expect(session.match.world.score.violet).toBe(1);
    expect(session.state().running).toBe(false);
  });

  it('plays on from a kick-off of only the robots in the situation', async () => {
    const session = await field();
    await session.setSeat('violet-2', { kind: 'empty' });
    await session.setSeat('lime-2', { kind: 'empty' });
    session.setResolve('play-on');
    session.start();
    session.place('ball', { x: 600, z: 0, vx: 3000 });
    run(session, 2);

    expect(session.match.world.score.violet).toBe(1);
    // A kick-off, not a re-stage — and still two robots, not the usual four.
    expect(session.match.world.robots.map((r) => r.id).sort()).toEqual(['lime-1', 'violet-1']);
    expect(session.state().running).toBe(true);
  });

  it('re-stages after a goal rather than kicking off, by default', async () => {
    const session = await field();
    await session.setSeat('lime-2', { kind: 'empty' });
    session.place('violet-1', { x: -300, z: 200, heading: 0 });
    session.start();
    session.place('ball', { x: 600, z: 0, vx: 3000 });
    runToGoal(session);

    expect(session.match.world.score.violet).toBe(1);
    const violet = session.match.world.robots.find((r) => r.id === 'violet-1')!;
    // Back where it was put, not on a kick-off mark.
    expect(violet.x).toBe(-300);
    expect(violet.z).toBe(200);
  });

  it('nominates the goalie the arrangement asks for, whatever the robot number', async () => {
    const session = await field();
    session.place('violet-1', { x: -700, z: 0, heading: 0 });
    expect(session.match.world.robots.find((r) => r.id === 'violet-1')!.isGoalie).toBe(false);
    expect(session.match.world.robots.find((r) => r.id === 'violet-2')!.isGoalie).toBe(true);
  });
});
