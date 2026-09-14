import { describe, expect, it } from 'vitest';
import { parseManifest, slugifyTeam } from './manifest';

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

describe('parseManifest', () => {
  it('accepts a well-formed manifest naming a file that was pushed', () => {
    const result = parseManifest(
      json({ team: 'ACT', robot: 1, entry: 'striker.py' }),
      new Set(['manifest.json', 'striker.py']),
    );
    expect(result).toEqual({ ok: true, value: { team: 'ACT', robot: 1, entry: 'striker.py' } });
  });

  it('rejects a missing manifest', () => {
    const result = parseManifest(undefined, new Set());
    expect(result.ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    const result = parseManifest(Buffer.from('{not json'), new Set());
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a team name outside the safe charset', () => {
    const result = parseManifest(
      json({ team: 'ACT/01; rm -rf', robot: 1, entry: 'a.py' }),
      new Set(['a.py']),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a robot number other than 1 or 2', () => {
    const result = parseManifest(json({ team: 'ACT', robot: 3, entry: 'a.py' }), new Set(['a.py']));
    expect(result.ok).toBe(false);
  });

  it('rejects an entry that was not among the pushed files', () => {
    const result = parseManifest(
      json({ team: 'ACT', robot: 1, entry: 'missing.py' }),
      new Set(['manifest.json']),
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('missing.py') });
  });

  it('rejects an entry with a subdirectory', () => {
    const result = parseManifest(
      json({ team: 'ACT', robot: 1, entry: 'sub/dir.py' }),
      new Set(['sub/dir.py']),
    );
    expect(result.ok).toBe(false);
  });
});

describe('slugifyTeam', () => {
  it('lowercases and collapses unsafe characters', () => {
    expect(slugifyTeam('ACT (Rebels)!')).toBe('act-rebels');
  });

  it('never returns empty', () => {
    expect(slugifyTeam('###')).toBe('team');
  });
});
