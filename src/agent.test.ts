/**
 * The promise this layer makes is that a badly-behaved program damages only
 * its own team. These tests are that promise.
 */

import { describe, expect, it } from 'vitest';
import { AgentSlot, LocalTransport, sanitise, type Agent } from './agent';
import { Senses, TeamRadio, type MatchView, type SensedRobot } from './perception';
import type { ActuatorFrame, SensorFrame } from './protocol';

const MOTORS = 4;

function agentOf(
  tick: (f: SensorFrame) => ActuatorFrame | null | undefined,
  name = 'test',
): Agent {
  return { name, tick };
}

function slot(tick: (f: SensorFrame) => ActuatorFrame | null | undefined) {
  return new AgentSlot(new LocalTransport(agentOf(tick), MOTORS));
}

const robot = (over: Partial<SensedRobot> = {}): SensedRobot => ({
  id: 'c1',
  team: 'cyan',
  number: 1,
  x: 0,
  z: 0,
  heading: 0,
  ...over,
});

function view(over: Partial<MatchView> = {}): MatchView {
  return {
    clock: 0,
    playing: true,
    ball: { x: 400, z: 0 },
    robots: [robot()],
    kickoff: { pending: false, team: null },
    ...over,
  };
}

const frame = (): SensorFrame =>
  new Senses(1, MOTORS).read({
    view: view(),
    self: robot(),
    wheelSpeeds: [0, 0, 0, 0],
    held: false,
    messages: [],
    attackDirection: 1,
    dt: 0.02,
  });

describe('sanitise', () => {
  it('clamps motor powers into range', () => {
    expect(sanitise({ motors: [5, -5, 0.5, 0] }, 4)!.motors).toEqual([1, -1, 0.5, 0]);
  });

  it('replaces NaN and Infinity with zero rather than poisoning the physics', () => {
    const out = sanitise({ motors: [NaN, Infinity, -Infinity, 'x'] }, 4)!;
    for (const m of out.motors) expect(Number.isFinite(m)).toBe(true);
    expect(out.motors).toEqual([0, 0, 0, 0]);
  });

  it('pads a short array instead of failing', () => {
    expect(sanitise({ motors: [1] }, 4)!.motors).toEqual([1, 0, 0, 0]);
  });

  it('ignores extra motors a program invents', () => {
    expect(sanitise({ motors: [1, 1, 1, 1, 1, 1] }, 4)!.motors).toHaveLength(4);
  });

  it('rejects a non-object without throwing', () => {
    for (const junk of [null, undefined, 42, 'go', true]) {
      expect(sanitise(junk, 4)).toBeNull();
    }
  });

  it('treats a missing motors array as stop', () => {
    expect(sanitise({ kicker: true }, 4)!.motors).toEqual([0, 0, 0, 0]);
  });

  it('keeps the kicker only when it is genuinely true', () => {
    expect(sanitise({ motors: [], kicker: 1 as unknown as boolean }, 4)!.kicker).toBe(false);
    expect(sanitise({ motors: [], kicker: true }, 4)!.kicker).toBe(true);
  });

  it('carries a team message through untouched', () => {
    const out = sanitise({ motors: [], say: { role: 'goalie' } }, 4)!;
    expect(out.say).toEqual({ role: 'goalie' });
  });
});

describe('a slot holds the last command', () => {
  it('uses what the program returned', () => {
    const s = slot(() => ({ motors: [1, 0, 0, 0] }));
    s.poll(frame()); // first poll sends; nothing has come back yet
    expect(s.poll(frame()).motors).toEqual([1, 0, 0, 0]);
  });

  it('starts stopped, so a silent program does not run away', () => {
    const s = slot(() => null);
    expect(s.poll(frame()).motors).toEqual([0, 0, 0, 0]);
  });

  it('keeps driving on the last command when the program goes quiet', () => {
    let answer: ActuatorFrame | null = { motors: [0.8, 0, 0, 0] };
    const s = slot(() => answer);
    s.poll(frame());
    expect(s.poll(frame()).motors[0]).toBe(0.8);

    answer = null; // the program stops responding
    for (let i = 0; i < 10; i++) s.poll(frame());
    expect(s.current().motors[0]).toBe(0.8);
    expect(s.report().missed).toBeGreaterThan(5);
  });

  it('survives a program that throws, and says so', () => {
    const s = slot(() => {
      throw new Error('list index out of range');
    });
    for (let i = 0; i < 5; i++) s.poll(frame());
    const r = s.report();
    expect(r.errors).toBe(5);
    expect(r.lastError).toContain('list index out of range');
    expect(s.current().motors).toEqual([0, 0, 0, 0]);
  });

  it('recovers when a flaky program starts answering again', () => {
    let ok = false;
    const s = slot(() => (ok ? { motors: [0.5, 0.5, 0.5, 0.5] } : null));
    for (let i = 0; i < 4; i++) s.poll(frame());
    ok = true;
    s.poll(frame());
    expect(s.poll(frame()).motors[0]).toBe(0.5);
  });

  it('records the worst unbroken run of missed cycles, not just the total', () => {
    let ok = true;
    const s = slot(() => (ok ? { motors: [1, 1, 1, 1] } : null));
    const set = (v: boolean, n: number) => {
      ok = v;
      for (let i = 0; i < n; i++) s.poll(frame());
    };
    set(false, 3);
    set(true, 5);
    set(false, 7);
    set(true, 5);
    // Seven, not six: a slot takes before it sends, so the first cycle after a
    // program starts answering again still has nothing to take. That one-tick
    // gap between reading a sensor and acting on it is in every real control
    // loop, and it is why the totals here run one ahead of the naive count.
    expect(s.report().worstRun).toBe(7);
    expect(s.report().missed).toBe(11);
  });

  it('stops the robot again on reset', () => {
    const s = slot(() => ({ motors: [1, 1, 1, 1] }));
    s.poll(frame());
    s.poll(frame());
    expect(s.current().motors[0]).toBe(1);
    s.reset();
    expect(s.current().motors).toEqual([0, 0, 0, 0]);
  });

  it('calls the program back on reset so it can drop stale state', () => {
    let resets = 0;
    const s = new AgentSlot(
      new LocalTransport({ name: 'r', tick: () => null, reset: () => resets++ }, MOTORS),
    );
    s.reset();
    expect(resets).toBe(1);
  });
});

describe('one bad program does not reach the other', () => {
  it('leaves an opponent unaffected by a crash', () => {
    const bad = slot(() => {
      throw new Error('boom');
    });
    const good = slot(() => ({ motors: [0.6, 0, 0, 0] }));
    for (let i = 0; i < 20; i++) {
      bad.poll(frame());
      good.poll(frame());
    }
    expect(good.current().motors[0]).toBe(0.6);
    expect(good.report().errors).toBe(0);
    expect(bad.report().errors).toBe(20);
  });
});

describe('perception hands over only what a sensor knows', () => {
  it('has no field for the ball position, only what the ring saw', () => {
    const f = frame();
    expect(Object.keys(f).sort()).toEqual(
      [
        'attackDirection',
        'ball',
        'ballGate',
        'camera',
        'clock',
        'compass',
        'encoders',
        'kickoff',
        'lines',
        'messages',
        'playing',
        'range',
        'robot',
        'team',
      ].sort(),
    );
    // `ball` is a bearing and a strength, not coordinates.
    expect(f.ball).not.toBeNull();
    expect(Object.keys(f.ball!).sort()).toEqual(['bearing', 'strength']);
  });

  it('never hands over anything about the opponent', () => {
    const f = new Senses(1, MOTORS).read({
      view: view({ robots: [robot(), robot({ id: 'y1', team: 'yellow', x: 900, z: 250 })] }),
      self: robot(),
      wheelSpeeds: [0, 0, 0, 0],
      held: false,
      messages: [],
      attackDirection: 1,
      dt: 0.02,
    });
    const json = JSON.stringify(f);
    // The opponent is invisible: no id, no position, no list of robots. The
    // only way to know one is there is to notice it blocking something.
    expect(json).not.toContain('y1');
    expect(json).not.toContain('robots');
    expect(json).not.toContain('900');
    expect(json).not.toContain('250');
    // 'yellow' does appear — but as the name of a goal on the far wall, which
    // a camera can obviously see, not as anything about the opposing team.
    expect(Object.keys(f.camera.goals).sort()).toEqual(['cyan', 'yellow']);
  });

  it('is blocked by a team mate, not only by an opponent', () => {
    const mate = robot({ id: 'c2', number: 2, x: 200, z: 0 });
    const f = new Senses(1, MOTORS).read({
      view: view({ robots: [robot(), mate] }),
      self: robot(),
      wheelSpeeds: [0, 0, 0, 0],
      held: false,
      messages: [],
      attackDirection: 1,
      dt: 0.02,
    });
    expect(f.ball).toBeNull();
  });

  it('gives the two robots on a team different noise', () => {
    const shared = view({ robots: [robot(), robot({ id: 'c2', number: 2 })] });
    const one = new Senses(7, MOTORS).read({
      view: shared,
      self: robot({ x: 0, z: 0 }),
      wheelSpeeds: [0, 0, 0, 0],
      held: false,
      messages: [],
      attackDirection: 1,
      dt: 0.02,
    });
    const two = new Senses(8, MOTORS).read({
      view: shared,
      self: robot({ x: 0, z: 0 }),
      wheelSpeeds: [0, 0, 0, 0],
      held: false,
      messages: [],
      attackDirection: 1,
      dt: 0.02,
    });
    expect(one.compass.heading).not.toBe(two.compass.heading);
  });

  it('replays identically from the same seed', () => {
    const run = () => {
      const s = new Senses(4242, MOTORS);
      let out = '';
      for (let i = 0; i < 50; i++) {
        out += JSON.stringify(
          s.read({
            view: view({ clock: i * 0.02 }),
            self: robot(),
            wheelSpeeds: [100, 100, 100, 100],
            held: false,
            messages: [],
            attackDirection: 1,
            dt: 0.02,
          }),
        );
      }
      return out;
    };
    expect(run()).toBe(run());
  });
});

describe('team radio (4.2.5)', () => {
  it('delivers to the other robot but never back to the sender', () => {
    const r = new TeamRadio();
    r.send(1, { role: 'striker' }, 0);
    expect(r.deliver(2, 0)).toHaveLength(1);
    expect(r.deliver(1, 0)).toHaveLength(0);
  });

  it('drops a packet once it is stale rather than delivering it late', () => {
    const r = new TeamRadio();
    r.send(1, 'go', 0);
    expect(r.deliver(2, 0.3)).toHaveLength(1);
    expect(r.deliver(2, 0.9)).toHaveLength(0);
  });

  it('reports how old a message is', () => {
    const r = new TeamRadio();
    r.send(1, 'go', 1.0);
    expect(r.deliver(2, 1.2)[0]!.age).toBeCloseTo(0.2, 6);
  });

  it('bounds the mailbox against a program that shouts every tick', () => {
    const r = new TeamRadio();
    for (let i = 0; i < 500; i++) r.send(1, i, 0);
    expect(r.deliver(2, 0).length).toBeLessThanOrEqual(16);
  });
});
