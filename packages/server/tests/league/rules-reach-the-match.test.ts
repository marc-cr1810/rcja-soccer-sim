/**
 * A venue rule is only a rule if it reaches the ball.
 *
 * `rules.heldBallSeconds` starts in a file an organiser edits and ends up
 * deciding when the referee takes the ball off a robot sitting on it. Between
 * those two points it passes through `loadSettings`, the hub's `playLeg`
 * request, the arena child and `Match`, and a break anywhere along that chain
 * looks exactly like the setting not working - a venue turns the number, the
 * console shows the new value, and nothing on the field changes.
 *
 * The first version of this setting was wired as far as `MatchOptions` and no
 * further, which is precisely that failure.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '../../src/infra/settings';
import { Match } from '../../src/match/match';
import { referenceTeam } from '../../src/infra/reference';
import { World } from '../../src/sim/world';

function venueWith(json: string): ReturnType<typeof loadSettings> {
  const dir = mkdtempSync(join(tmpdir(), 'rcja-rules-'));
  writeFileSync(join(dir, 'league.json'), json);
  return loadSettings(dir);
}

/** What the World was actually built with, which is the only thing that counts. */
function windowOf(m: Match): number | undefined {
  return (m.world as World & { config: { heldBallSeconds?: number } }).config.heldBallSeconds;
}

function matchWith(heldBallSeconds: number | undefined): Match {
  return new Match({
    agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as never,
    halfSeconds: 20,
    seed: 1,
    heldBallSeconds,
  });
}

describe('rules.heldBallSeconds reaches the match', () => {
  it('carries the number a venue wrote all the way to the World', () => {
    const { settings, sources } = venueWith('{ "rules": { "heldBallSeconds": 3 } }');
    expect(sources['rules.heldBallSeconds']).toBe('file');
    expect(windowOf(matchWith(settings.rules.heldBallSeconds))).toBe(3);
  });

  it('carries a venue turning it off, which is a different answer from absent', () => {
    const { settings } = venueWith('{ "rules": { "heldBallSeconds": 0 } }');
    expect(windowOf(matchWith(settings.rules.heldBallSeconds))).toBe(0);

    // Absent is the simulator's default, and must NOT arrive as 0 - that would
    // hand every venue that never opened the file unlimited possession.
    const quiet = venueWith('{ "arenas": { "max": 2 } }');
    expect(windowOf(matchWith(quiet.settings.rules.heldBallSeconds))).toBe(8);
  });

  it('leaves a bare Match on the simulator default, which is what a laptop wants', () => {
    expect(windowOf(matchWith(undefined))).toBeUndefined();
  });
});
