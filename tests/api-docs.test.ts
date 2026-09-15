/**
 * API docs endpoint — serves the OpenAPI spec and Scalar UI.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LeagueServer } from '../src/league';
import { buildOpenApi } from '../src/api/openapi';

const servers: LeagueServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start(): Promise<{ port: number }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcja-league-'));
  const submissionsDir = await mkdtemp(join(tmpdir(), 'rcja-sub-'));
  const workspacesDir = await mkdtemp(join(tmpdir(), 'rcja-ws-'));
  dirs.push(dataDir, submissionsDir, workspacesDir);

  const server = new LeagueServer({
    port: 0,
    dataDir,
    tournamentsDir: join(dataDir, 'tournaments'),
    world: {
      realtime: false,
      submissionsDir,
      workspacesDir,
      pythonLibDir: join(import.meta.dirname, '../python'),
    },
  });
  servers.push(server);
  return { port: await server.listen() };
}

describe('API docs', () => {
  it('serves the HTML page at /api/docs', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/docs`);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('api-reference');
    expect(body).toContain('scalar.js');
  });

  it('serves the OpenAPI JSON at /api/docs/openapi.json', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/docs/openapi.json`);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('application/json');
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toBeDefined();
    expect(doc.paths).toBeDefined();
    expect(typeof doc.paths).toBe('object');
    const paths = doc.paths as Record<string, unknown>;
    expect(paths['/api/front']).toBeDefined();
    expect(paths['/submit']).toBeDefined();
    expect(paths['/practice-api/state']).toBeDefined();
    expect(paths['/referee-api/session']).toBeDefined();
    expect(paths['/arena-api/state']).toBeDefined();
  });

  it('serves the Scalar standalone JS at /api/docs/scalar.js', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/docs/scalar.js`);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('javascript');
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100_000);
  });

  it('returns 404 for unknown docs sub-paths', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/docs/nope`);
    expect(res.status).toBe(404);
  });
});

describe('OpenAPI spec content', () => {
  const doc = buildOpenApi();
  const paths = doc.paths as Record<string, Record<string, unknown>>;

  it('has every league API path', () => {
    const expected = [
      '/auth/register',
      '/auth/login',
      '/auth/logout',
      '/api/front',
      '/api/schedule',
      '/api/standings',
      '/api/match/{fixtureId}',
      '/api/team/{slug}',
      '/api/me',
      '/api/keys',
      '/api/keys/{keyId}/revoke',
      '/api/admin/accounts',
      '/api/admin/invites',
      '/api/admin/audit',
      '/api/admin/accounts/{accountId}/password',
      '/api/admin/accounts/{accountId}/disabled',
    ];
    for (const p of expected) {
      expect(paths[p]).toBeDefined();
    }
  });

  it('has every match server path', () => {
    const expected = [
      '/submit',
      '/practice',
      '/practice-api/state',
      '/practice-api/start',
      '/practice-api/stop',
      '/practice-api/place',
      '/practice-api/roster',
      '/practice-api/resolve',
      '/practice-api/seat',
      '/practice-api/seat-restart',
      '/practice-api/seat-stop',
      '/referee-api/session',
      '/referee-api/kickoff',
      '/referee-api/abandon',
      '/referee-api/remove-robot',
      '/referee-api/return-robot',
      '/referee-api/correct-score',
      '/workspace-api/open',
      '/workspace-api/save',
      '/workspace-api/delete',
      '/workspace-api/submit',
      '/arena-api/state',
      '/arena-api/play',
    ];
    for (const p of expected) {
      expect(paths[p]).toBeDefined();
    }
  });

  it('defines security schemes', () => {
    const components = doc.components as Record<string, unknown>;
    const schemes = components?.securitySchemes as Record<string, unknown> | undefined;
    expect(schemes).toBeDefined();
    expect(schemes!.team).toBeDefined();
    expect(schemes!.admin).toBeDefined();
    expect(schemes!.referee).toBeDefined();
  });

  it('registers component schemas', () => {
    const components = doc.components as Record<string, unknown>;
    const schemas = components?.schemas as Record<string, unknown> | undefined;
    expect(schemas).toBeDefined();
    // Shared value types
    expect(schemas!.Score).toBeDefined();
    expect(schemas!.TeamId).toBeDefined();
    expect(schemas!.MatchEvent).toBeDefined();
    expect(schemas!.Standing).toBeDefined();
    // Account
    expect(schemas!.PublicAccount).toBeDefined();
    // Error envelope
    expect(schemas!.Error).toBeDefined();
    // Arena
    expect(schemas!.ArenaState).toBeDefined();
    expect(schemas!.ArenaInfo).toBeDefined();
    // Practice
    expect(schemas!.PracticeState).toBeDefined();
    // Workspace
    expect(schemas!.WorkspaceFile).toBeDefined();
  });

  it('has status codes on every public API path', () => {
    const front = paths['/api/front'] as Record<string, unknown>;
    expect(front.get).toBeDefined();
    const get = front.get as Record<string, unknown>;
    const responses = get.responses as Record<string, unknown>;
    expect(responses['200']).toBeDefined();
  });

  it('has error responses on auth endpoints', () => {
    const login = paths['/auth/login'] as Record<string, unknown>;
    const post = login.post as Record<string, unknown>;
    const responses = post.responses as Record<string, unknown>;
    expect(responses['400']).toBeDefined();
    expect(responses['401']).toBeDefined();
  });
});
