/**
 * The ladder's job is to find what sensible play never touches, so these check
 * that it runs deliberately bad robots without falling over — and pin the
 * balance numbers it measures, because those are the ones that decide whether
 * this is a game worth entering.
 */

import { describe, expect, it } from 'vitest';
import { formatLadder, runLadder, type Entry } from './ladder';
import { botRoster, naiveChaser, spinner, statue, waller } from './bots';
import { ReferenceAgent } from './reference';
import { Match, type MatchAgents } from './match';

function reference(skill = 1): Entry {
  return {
    name: `reference${skill === 1 ? '' : `-${skill}`}`,
    origin: 'reference',
    make: (team) => [
      new ReferenceAgent({ team, number: 1, role: 'striker', skill }),
      new ReferenceAgent({ team, number: 2, role: 'goalie', skill }),
    ],
  };
}

const bot = (name: string, make: Entry['make']): Entry => ({ name, origin: 'generated', make });

describe('the ladder runs', () => {
  it('plays every ordered pairing', () => {
    const entries = [reference(), bot('statue', () => [statue, statue])];
    const s = runLadder(entries, { halfSeconds: 20, seed: 1 });
    // Two entries, both ways round.
    expect(s.matches).toBe(2);
    for (const row of s.table) expect(row.played).toBe(2);
  });

  it('awards three points for a win and one each for a draw', () => {
    const s = runLadder([reference(), bot('statue', () => [statue, statue])], {
      halfSeconds: 20,
      seed: 1,
    });
    const total = s.table.reduce((a, r) => a + r.points, 0);
    // Every match hands out either 3 or 2 points in total.
    expect(total).toBeGreaterThanOrEqual(s.matches * 2);
    expect(total).toBeLessThanOrEqual(s.matches * 3);
  });

  it('keeps every entry honest about where it came from', () => {
    const s = runLadder([reference(), bot('waller', () => [waller, waller])], {
      halfSeconds: 20,
      seed: 1,
    });
    const origins = Object.fromEntries(s.table.map((r) => [r.name, r.origin]));
    expect(origins['reference']).toBe('reference');
    expect(origins['waller']).toBe('generated');
  });

  it('survives the whole roster of bad robots', () => {
    const entries = botRoster().map((b) => bot(b.name, b.make));
    const s = runLadder(entries, { halfSeconds: 20, seed: 2 });
    expect(s.matches).toBe(entries.length * (entries.length - 1));
    for (const row of s.table) expect(row.errors).toBe(0);
  });

  it('gives fresh programs to every match', () => {
    // Entries are factories precisely so state cannot leak between matches.
    // Two runs of the same ladder must agree exactly.
    const entries = [reference(), bot('chaser', () => [naiveChaser, naiveChaser])];
    const a = runLadder(entries, { halfSeconds: 30, seed: 9 });
    const b = runLadder(entries, { halfSeconds: 30, seed: 9 });
    expect(b.table.map((r) => r.points)).toEqual(a.table.map((r) => r.points));
    expect(b.table.map((r) => r.for)).toEqual(a.table.map((r) => r.for));
  });

  it('prints a table', () => {
    const s = runLadder([reference(), bot('spinner', () => [spinner, spinner])], {
      halfSeconds: 20,
      seed: 1,
    });
    const text = formatLadder(s);
    expect(text).toContain('PTS');
    expect(text).toContain('reference');
    expect(text).toMatch(/goals per match/);
  });
});

describe('the bots push on the rules they were written for', () => {
  /** Play one entry against another and report what the referee called. */
  function calls(home: Entry, away: Entry, seed = 3): Record<string, number> {
    const [c1, c2] = home.make('violet');
    const [y1, y2] = away.make('lime');
    const agents = {
      'violet-1': c1!,
      'violet-2': c2!,
      'lime-1': y1!,
      'lime-2': y2!,
    } satisfies MatchAgents;
    return new Match({ agents, halfSeconds: 120, seed }).run().calls;
  }

  it('drives robots off the field, so 5.7.1.6 gets exercised', () => {
    const c = calls(bot('waller', () => [waller, waller]), reference());
    expect(c['possible-damaged'] ?? 0).toBeGreaterThan(0);
  });

  it('produces scrums that stop progressing, so 5.6 gets exercised', () => {
    const roster = botRoster();
    const shove = roster.find((b) => b.name === 'shover')!;
    const c = calls(bot('shover', shove.make), bot('shover', shove.make));
    expect(c['lack-of-progress'] ?? 0).toBeGreaterThan(0);
  });

  it('scores at both ends with a naive chaser, which the referee must allow', () => {
    // A robot that drives straight at the ball scores own goals. That is the
    // reason the reference agent approaches from the side, and the referee has
    // to credit them to the right team rather than refusing them.
    const s = runLadder(
      [bot('chaser', () => [naiveChaser, naiveChaser]), bot('statue', () => [statue, statue])],
      { halfSeconds: 120, seed: 4 },
    );
    const stat = s.table.find((r) => r.name === 'statue')!;
    expect(stat.for).toBeGreaterThan(0);
  });
});

describe('balance, as currently measured', () => {
  /*
   * Not pass/fail criteria for the software - these are the numbers that decide
   * whether the game is worth entering, pinned so a change to sensor noise, a
   * referee threshold or the ball's friction cannot move them unnoticed.
   *
   * They were deliberately wide when first written, because the game was not
   * playable: around 17 goals and 180 restarts per ten-minute match. Replacing
   * the ball's exponential damping with constant rolling resistance brought
   * that to about 5 goals and 89 restarts, which is a believable RCJA Open
   * scoreline, so they are tightened here to match.
   */
  it('measures goals and restarts per match', () => {
    const s = runLadder([reference(), reference(0.6)], { halfSeconds: 120, seed: 5 });
    expect(s.goalsPerMatch).toBeGreaterThan(0);
    expect(s.goalsPerMatch).toBeLessThan(12);
    expect(s.callsPerMatch['ball-out-of-play'] ?? 0).toBeLessThan(70);
  });

  it('no longer spends the match taking kick-offs', () => {
    /*
     * The regression that matters most so far. Agents dribbled at kick-off,
     * which 5.4.7 forbids, so the referee awarded the kick-off to the other
     * side - who did the same. A four-minute match contained 203 kick-offs and
     * 194 illegal ones, and no football.
     *
     * Fixed on both sides: the protocol now tells a robot a kick-off is live,
     * and the referee plays on after two failed re-takes.
     */
    const s = runLadder([reference(), reference()], { halfSeconds: 120, seed: 6 });
    expect(s.callsPerMatch['kickoff'] ?? 0).toBeLessThan(30);
    expect(s.callsPerMatch['illegal-kickoff'] ?? 0).toBeLessThan(10);
  });
});
