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

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MatchServer } from '../src/server';
import { PracticeSession, scrub } from '../src/practice';

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

  it('keeps going past a ten-goal difference, because a rehearsal has no result', async () => {
    // The mercy rule ends every other match in this repository at ten. A field
    // is the one exception: there is nothing to shorten, and stopping one
    // because the built-in agent ran away with it would be taking the field
    // off the team who booked it.
    const session = await field();
    session.start();
    session.match.world.score.violet = 12;
    run(session, 1);

    expect(session.match.isEnded).toBe(false);
    expect(session.state().running).toBe(true);
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

/**
 * What a seat said, and where the field was left.
 *
 * The first is the only thing a student gets when their code does not parse —
 * before this, the one symptom was a seat reading "not answering" — and the
 * second is what makes reclaiming an idle field a lost process rather than a
 * lost afternoon. Neither needs a real sandboxed program to be tested: the
 * buffer is fed by the same path whatever is talking, and the arrangement is
 * dragging and a file.
 */
describe('scrub', () => {
  const dir = '/tmp/run-abc123';
  const socketUrl = 'unix:///tmp/agent.sock?path=%2Fagent';

  it('takes the run directory out of a traceback path', () => {
    expect(scrub(`File "${dir}/robot.py", line 3`, dir, socketUrl)).toBe('File "robot.py", line 3');
  });

  it('replaces the agent socket URL with something a student recognises', () => {
    expect(scrub(`[Striker] connected to ${socketUrl}`, dir, socketUrl)).toBe('[Striker] connected to this field');
  });

  it('leaves text with neither in it alone', () => {
    expect(scrub('SyntaxError: invalid syntax', dir, socketUrl)).toBe('SyntaxError: invalid syntax');
  });
});

describe('what a seat has said', () => {
  it('is nothing at all until something says something', async () => {
    const session = await field();
    expect(session.outputOf('violet-1')).toEqual({ seq: 0, lines: [] });
    expect(session.state().seats['violet-1']!.outputSeq).toBe(0);
  });

  it('says why a seat could not start, where it is read', async () => {
    const session = await field();
    // A server with no python/ cannot run a submission, and the old answer to
    // that was a seat detail nobody was looking at.
    await session.setSeat('violet-1', { kind: 'submission', team: 'Nobody' });

    const state = session.state().seats['violet-1']!;
    expect(state.detail).toContain('cannot run submissions');
    expect(session.outputOf('violet-1').lines.map((l) => l.text)).toEqual([state.detail!]);
    expect(state.outputSeq).toBe(1);
  });

  it('is forgotten when the seat becomes something else', async () => {
    const session = await field();
    await session.setSeat('violet-1', { kind: 'submission', team: 'Nobody' });
    expect(session.outputOf('violet-1').lines).toHaveLength(1);

    await session.setSeat('violet-1', { kind: 'built-in' });
    // A traceback belongs to a program. Reading the last occupant's crash
    // under a different robot's name is worse than reading nothing.
    expect(session.outputOf('violet-1')).toEqual({ seq: 0, lines: [] });
  });

  it('is kept across a restart, with a line to say one happened', async () => {
    const session = await field();
    await session.setSeat('violet-1', { kind: 'submission', team: 'Nobody' });
    await session.restartSeat('violet-1');

    // What a student is doing here is comparing the crash with what happened
    // next; clearing the panel takes away the half they already had.
    const lines = session.outputOf('violet-1').lines.map((l) => l.text);
    expect(lines).toContain('— restarted —');
    expect(lines.filter((l) => l.includes('cannot run submissions'))).toHaveLength(2);
  });

  it('answers only what the reader has not seen', async () => {
    const session = await field();
    await session.setSeat('violet-1', { kind: 'submission', team: 'Nobody' });
    const first = session.outputOf('violet-1');
    expect(first.lines).toHaveLength(1);

    await session.restartSeat('violet-1');
    const next = session.outputOf('violet-1', first.seq);
    expect(next.lines.map((l) => l.text)).toEqual(['— restarted —', first.lines[0]!.text]);
    // The number comes back either way, so a reader that has fallen behind the
    // ring buffer knows it rather than waiting for a line that was dropped.
    expect(next.seq).toBe(3);
  });
});

describe('a field that is given back', () => {
  it('writes the arrangement down, and opens on it next time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcja-field-'));
    const path = join(dir, 'act-robotics', 'field.json');
    try {
      const server = new MatchServer({ port: 0 });
      servers.push(server);
      await server.listen();

      const session = new PracticeSession(server, { submissionsDir: 'submissions', fieldStatePath: path });
      session.place('violet-1', { x: -300, z: 200, heading: 1 });
      await session.setSeat('lime-2', { kind: 'empty' });
      session.place('ball', { x: 450, z: -120 });
      // Debounced: a drag is a stream of these and the file only has to be
      // right shortly after somebody stops moving things.
      await new Promise((done) => setTimeout(done, 2_400));

      const saved = JSON.parse(await readFile(path, 'utf8')) as {
        arrangement: { robots: { id: string; x: number }[]; ball: { x: number } };
      };
      expect(saved.arrangement.ball.x).toBe(450);
      expect(saved.arrangement.robots.map((r) => r.id).sort()).toEqual(['lime-1', 'violet-1', 'violet-2']);

      // The process is lost. The twenty minutes somebody spent dragging is not.
      const reopened = new PracticeSession(server, { submissionsDir: 'submissions', fieldStatePath: path });
      const violet = reopened.match.world.robots.find((r) => r.id === 'violet-1')!;
      expect(violet.x).toBeCloseTo(-300, 5);
      expect(violet.z).toBeCloseTo(200, 5);
      expect(reopened.match.world.ball.x).toBeCloseTo(450, 5);
      expect(reopened.match.world.robots.some((r) => r.id === 'lime-2')).toBe(false);
      reopened.close();
      session.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('opens on the defaults when the saved file is nonsense', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcja-field-'));
    const path = join(dir, 'field.json');
    try {
      await writeFile(path, '{ half a file');
      const server = new MatchServer({ port: 0 });
      servers.push(server);
      await server.listen();

      // Hand-editable is the promise, so hand-broken is a case: a scratch file
      // somebody mangled must not be why a team cannot open a field.
      const session = new PracticeSession(server, { submissionsDir: 'submissions', fieldStatePath: path });
      expect(session.match.world.robots).toHaveLength(4);
      session.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
