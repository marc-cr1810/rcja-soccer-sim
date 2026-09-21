/**
 * Every HTTP route the league and match servers answer, registered for the
 * OpenAPI document. Paths are exactly what a client sends — `/api/front`, not
 * the router's stripped `/front` — and responses match what the handlers really
 * return (status codes included, `{ ok, reason }` envelope for failures).
 */

import { z } from 'zod';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  AbandonBodySchema,
  AdminAccountsResponseSchema,
  AdminAuditResponseSchema,
  AdminInviteCreatedResponseSchema,
  AdminInvitesResponseSchema,
  ArenaStateResponseSchema,
  CorrectScoreBodySchema,
  CreateInviteBodySchema,
  CreateKeyBodySchema,
  DeleteBodySchema,
  ErrorResponseSchema,
  FrontResponseSchema,
  KeyCreatedResponseSchema,
  KeyRevokeResponseSchema,
  KeysResponseSchema,
  KickoffBodySchema,
  LoginBodySchema,
  MatchResponseSchema,
  MeResponseSchema,
  OkResponseSchema,
  PlaceBodySchema,
  PlayRequestSchema,
  LockRequestSchema,
  LockResponseSchema,
  ReadyRequestSchema,
  PracticeFieldCreatedResponseSchema,
  PracticeFieldsResponseSchema,
  PracticeStateResponseSchema,
  RefereeSessionResponseSchema,
  RegisterBodySchema,
  RemoveRobotBodySchema,
  ResetPasswordBodySchema,
  ReturnRobotBodySchema,
  RosterBodySchema,
  BallBodySchema,
  ResolveBodySchema,
  SaveBodySchema,
  ScheduleResponseSchema,
  SeatActionBodySchema,
  SeatBodySchema,
  SetDisabledBodySchema,
  StandingsResponseSchema,
  SubmitBodySchema,
  SubmitResponseSchema,
  TeamResponseSchema,
  WorkspaceDeleteResponseSchema,
  WorkspaceOpenResponseSchema,
  WorkspaceSaveResponseSchema,
  WorkspaceSubmitResponseSchema,
} from './schemas';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';

const JSON = 'application/json' as const;

/** A 200 with an `application/json` body described by a zod schema. */
function json(schema: z.ZodType<unknown>, description: string) {
  return success(schema, description);
}

function success(schema: z.ZodType<unknown>, description: string) {
  return {
    description,
    content: { [JSON]: { schema } },
  };
}

function error(description: string) {
  return success(ErrorResponseSchema, description);
}

function route(definition: RouteConfig) {
  registry.registerPath(definition);
}

export const registry = new OpenAPIRegistry();

// ─── Auth ─────────────────────────────────────────────────────────────────────

route({
  method: 'post',
  path: '/auth/register',
  summary: 'Create an account from an invitation',
  description: 'Redeems a single-use invitation code and opens a session cookie.',
  request: {
    body: { content: { [JSON]: { schema: RegisterBodySchema } } },
  },
  responses: {
    '200': json(MeResponseSchema, 'Registered; session cookie set'),
    '400': error('Bad request — the code is invalid, spent, or the password is too short'),
    '401': error('Unauthorized'),
  },
});

route({
  method: 'post',
  path: '/auth/login',
  summary: 'Log in',
  description: 'Authenticates by name and password. Returns the account and sets a session cookie.',
  request: {
    body: { content: { [JSON]: { schema: LoginBodySchema } } },
  },
  responses: {
    '200': json(MeResponseSchema, 'Logged in; session cookie set'),
    '400': error('Bad request — missing name or password'),
    '401': error('That name and password do not match an account'),
  },
});

route({
  method: 'post',
  path: '/auth/logout',
  summary: 'Log out',
  description: 'Closes the session and clears the cookie.',
  responses: {
    '200': json(OkResponseSchema, 'Logged out'),
  },
});

// ─── Public API ───────────────────────────────────────────────────────────────

route({
  method: 'get',
  path: '/api/front',
  summary: 'Front page data',
  description: 'Tournament summary, live/next/upcoming fixtures, recent results, and the league table.',
  responses: {
    '200': json(FrontResponseSchema, 'Front page data'),
  },
});

route({
  method: 'get',
  path: '/api/schedule',
  summary: 'Full fixture schedule',
  description: 'Every fixture, with result cards folded in for played ones.',
  responses: {
    '200': json(ScheduleResponseSchema, 'Fixture list with results'),
  },
});

route({
  method: 'get',
  path: '/api/standings',
  summary: 'League table',
  description: 'The derived table — points, goals, missed control cycles.',
  responses: {
    '200': json(StandingsResponseSchema, 'League table'),
  },
});

route({
  method: 'get',
  path: '/api/match/{fixtureId}',
  summary: 'Match or fixture detail',
  description: 'Fixture meta plus the full match record (seeds, score, calls, events) once played.',
  request: {
    params: z.object({ fixtureId: z.string() }),
  },
  responses: {
    '200': json(MatchResponseSchema, 'Fixture detail and match record'),
  },
});

route({
  method: 'get',
  path: '/api/team/{slug}',
  summary: 'Team page',
  description: 'Team identity, their fixtures with results, and their table row.',
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    '200': json(TeamResponseSchema, 'Team page data'),
  },
});

route({
  method: 'get',
  path: '/api/me',
  summary: 'Who am I',
  description: 'The session account, or null; capability flags derived from the role.',
  responses: {
    '200': json(MeResponseSchema, 'The account and what it may do'),
  },
});

// ─── Push keys ────────────────────────────────────────────────────────────────

route({
  method: 'get',
  path: '/api/keys',
  summary: 'List push keys',
  description: "A team's own push keys, as seen by the public (never the raw key).",
  security: [{ team: [] }],
  responses: {
    '200': json(KeysResponseSchema, 'The team\'s push keys'),
    '401': error('Unauthorized — log in first'),
    '403': error('Forbidden — your account may not push'),
  },
});

route({
  method: 'post',
  path: '/api/keys',
  summary: 'Mint a push key',
  description: 'Creates a key usable for push; the raw key is returned only once, at creation.',
  security: [{ team: [] }],
  request: {
    body: { content: { [JSON]: { schema: CreateKeyBodySchema } } },
  },
  responses: {
    '200': json(KeyCreatedResponseSchema, 'The raw key and its public info — shown once'),
    '401': error('Unauthorized — log in first'),
    '403': error('Forbidden — your account may not push'),
  },
});

route({
  method: 'post',
  path: '/api/keys/{keyId}/revoke',
  summary: 'Revoke a push key',
  description: 'Deletes a key by id. `ok` is true when the key existed.',
  security: [{ team: [] }],
  request: {
    params: z.object({ keyId: z.string() }),
  },
  responses: {
    '200': json(KeyRevokeResponseSchema, 'Revoked'),
    '404': error('No such key'),
  },
});

// ─── Admin ────────────────────────────────────────────────────────────────────

route({
  method: 'get',
  path: '/api/admin/accounts',
  summary: 'List accounts',
  security: [{ admin: [] }],
  responses: {
    '200': json(AdminAccountsResponseSchema, 'All accounts'),
    '401': error('Unauthorized — log in first'),
    '403': error('Forbidden — your account may not administer'),
  },
});

route({
  method: 'get',
  path: '/api/admin/invites',
  summary: 'List invitations',
  security: [{ admin: [] }],
  responses: {
    '200': json(AdminInvitesResponseSchema, 'All issued invitations'),
    '401': error('Unauthorized — log in first'),
    '403': error('Forbidden — your account may not administer'),
  },
});

route({
  method: 'post',
  path: '/api/admin/invites',
  summary: 'Issue an invitation',
  security: [{ admin: [] }],
  request: {
    body: { content: { [JSON]: { schema: CreateInviteBodySchema } } },
  },
  responses: {
    '200': json(AdminInviteCreatedResponseSchema, 'Invitation issued'),
    '400': error('Bad request — invalid role or target'),
    '401': error('Unauthorized — log in first'),
    '403': error('Forbidden — your account may not administer'),
  },
});

route({
  method: 'get',
  path: '/api/admin/audit',
  summary: 'Audit log',
  description: 'Newest 200 audit rows — who did what, with which capability.',
  security: [{ admin: [] }],
  responses: {
    '200': json(AdminAuditResponseSchema, 'Audit rows'),
    '401': error('Unauthorized — log in first'),
    '403': error('Forbidden — your account may not administer'),
  },
});

route({
  method: 'post',
  path: '/api/admin/accounts/{accountId}/password',
  summary: 'Reset a password',
  security: [{ admin: [] }],
  request: {
    params: z.object({ accountId: z.string() }),
    body: { content: { [JSON]: { schema: ResetPasswordBodySchema } } },
  },
  responses: {
    '200': json(OkResponseSchema, 'Password reset'),
    '400': error('Bad request — a password is required'),
    '401': error('Unauthorized — log in first'),
    '403': error('Forbidden — your account may not administer'),
    '404': error('No such account'),
  },
});

route({
  method: 'post',
  path: '/api/admin/accounts/{accountId}/disabled',
  summary: 'Enable or disable an account',
  security: [{ admin: [] }],
  request: {
    params: z.object({ accountId: z.string() }),
    body: { content: { [JSON]: { schema: SetDisabledBodySchema } } },
  },
  responses: {
    '200': json(OkResponseSchema, 'Toggled'),
    '400': error('Bad request'),
    '401': error('Unauthorized — log in first'),
    '403': error('Forbidden — your account may not administer'),
    '404': error('No such account'),
  },
});

// ─── Submit ───────────────────────────────────────────────────────────────────

route({
  method: 'post',
  path: '/submit',
  summary: 'Push a robot',
  description: 'Sends one robot\'s folder as `{files: {path: base64}}`. Returns a fresh join token.',
  request: {
    body: { content: { [JSON]: { schema: SubmitBodySchema } } },
  },
  responses: {
    '200': json(SubmitResponseSchema, 'Push accepted; join token minted'),
    '400': error('Bad request — the folder failed validation'),
  },
});

// ─── Practice ─────────────────────────────────────────────────────────────────

route({
  method: 'get',
  path: '/practice',
  summary: 'List practice fields',
  description: 'What is running on this server. Returns JSON to scripts, HTML to browsers.',
  responses: {
    '200': json(PracticeFieldsResponseSchema, 'Open practice fields'),
  },
});

route({
  method: 'post',
  path: '/practice',
  summary: 'Open a practice field',
  responses: {
    '201': json(PracticeFieldCreatedResponseSchema, 'A new field was opened'),
    '503': error('Service unavailable — no more fields, or the arena is not answering'),
  },
});

route({
  method: 'get',
  path: '/practice-api/state',
  summary: 'Practice field state',
  description: 'The live practice state: running, clock, score, arrangement, and every seat.',
  responses: {
    '200': json(PracticeStateResponseSchema, 'Current practice state'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/start',
  summary: 'Start the practice clock',
  responses: {
    '200': json(PracticeStateResponseSchema, 'Started — state returned'),
    '400': error('Bad request'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/stop',
  summary: 'Stop the practice clock',
  responses: {
    '200': json(PracticeStateResponseSchema, 'Stopped — state returned'),
    '400': error('Bad request'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/restage',
  summary: 'Restage the arrangement',
  description: 'Returns the field to the current arrangement; does not reset the clock or score.',
  responses: {
    '200': json(PracticeStateResponseSchema, 'Restaged — state returned'),
    '400': error('Bad request'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/keep',
  summary: 'Keep the current arrangement',
  description: 'Records where the ball and robots have ended up as the new arrangement.',
  responses: {
    '200': json(PracticeStateResponseSchema, 'Kept — state returned'),
    '400': error('Bad request'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/place',
  summary: 'Place the ball or a robot',
  description: 'Moves one piece to a field position. Optional velocity/heading for a kick.',
  request: {
    body: { content: { [JSON]: { schema: PlaceBodySchema } } },
  },
  responses: {
    '200': json(PracticeStateResponseSchema, 'Placed — state returned'),
    '400': error('Bad request — "target" must be "ball" or a seat id, with numeric "x" and "z"'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/roster',
  summary: 'Put a robot on or off the field',
  request: {
    body: { content: { [JSON]: { schema: RosterBodySchema } } },
  },
  responses: {
    '200': json(PracticeStateResponseSchema, 'Rostered — state returned'),
    '400': error('Bad request — "seat" and boolean "onField" are required'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/ball',
  summary: 'Take the ball off the field, or put it back',
  request: {
    body: { content: { [JSON]: { schema: BallBodySchema } } },
  },
  responses: {
    '200': json(PracticeStateResponseSchema, 'Ball switched — state returned'),
    '400': error('Bad request — boolean "onField" is required'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/resolve',
  summary: 'Choose how a stopped field resumes',
  request: {
    body: { content: { [JSON]: { schema: ResolveBodySchema } } },
  },
  responses: {
    '200': json(PracticeStateResponseSchema, 'Resolve mode set — state returned'),
    '400': error('Bad request — "mode" must be "restage", "play-on" or "freeze"'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/seat',
  summary: 'Fill a seat',
  description: 'Sets what drives a seat: empty, built-in, laptop, or a team\'s submission.',
  request: {
    body: { content: { [JSON]: { schema: SeatBodySchema } } },
  },
  responses: {
    '200': json(PracticeStateResponseSchema, 'Seat filled — state returned'),
    '400': error('Bad request — invalid "seat" or "fill"'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/seat-restart',
  summary: "Restart a seat's program",
  request: {
    body: { content: { [JSON]: { schema: SeatActionBodySchema } } },
  },
  responses: {
    '200': json(PracticeStateResponseSchema, 'Restarted — state returned'),
    '400': error('Bad request — "seat" must be a seat id'),
    '404': error('This server is not a practice field'),
  },
});

route({
  method: 'post',
  path: '/practice-api/seat-stop',
  summary: "Stop a seat's program",
  request: {
    body: { content: { [JSON]: { schema: SeatActionBodySchema } } },
  },
  responses: {
    '200': json(PracticeStateResponseSchema, 'Stopped — state returned'),
    '400': error('Bad request — "seat" must be a seat id'),
    '404': error('This server is not a practice field'),
  },
});

// ─── Referee ──────────────────────────────────────────────────────────────────

route({
  method: 'get',
  path: '/referee-api/session',
  summary: 'Referee session status',
  description: 'Whether the presented token authorizes a referee. `ok` is true when it does.',
  security: [{ referee: [] }],
  responses: {
    '200': json(RefereeSessionResponseSchema, 'Authorized or not'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled on this server'),
  },
});

route({
  method: 'post',
  path: '/referee-api/kickoff',
  summary: 'Kick off / award a restart',
  description: 'Starts play for the given team, or blows the whistle on a pending restart.',
  security: [{ referee: [] }],
  request: {
    body: { content: { [JSON]: { schema: KickoffBodySchema } } },
  },
  responses: {
    '200': json(OkResponseSchema, 'Kicked off'),
    '400': error('Bad request — "team" must be "violet" or "lime"'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled, or no action "kickoff"'),
    '409': error('No refereed match in progress'),
  },
});

route({
  method: 'post',
  path: '/referee-api/award-kickoff',
  summary: 'Award the kick-off to the other team',
  security: [{ referee: [] }],
  responses: {
    '200': json(OkResponseSchema, 'Awarded'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled'),
    '409': error('No refereed match in progress'),
  },
});

route({
  method: 'post',
  path: '/referee-api/pause',
  summary: 'Pause play',
  security: [{ referee: [] }],
  responses: {
    '200': json(OkResponseSchema, 'Paused'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled'),
    '409': error('No refereed match in progress'),
  },
});

route({
  method: 'post',
  path: '/referee-api/resume',
  summary: 'Resume play',
  security: [{ referee: [] }],
  responses: {
    '200': json(OkResponseSchema, 'Resumed'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled'),
    '409': error('No refereed match in progress'),
  },
});

route({
  method: 'post',
  path: '/referee-api/skip-kickoff-countdown',
  summary: 'Skip the kick-off countdown',
  security: [{ referee: [] }],
  responses: {
    '200': json(OkResponseSchema, 'Countdown skipped'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled'),
    '409': error('No refereed match in progress'),
  },
});

route({
  method: 'post',
  path: '/referee-api/end-half',
  summary: 'End the current half',
  security: [{ referee: [] }],
  responses: {
    '200': json(OkResponseSchema, 'Half ended'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled'),
    '409': error('No refereed match in progress'),
  },
});

route({
  method: 'post',
  path: '/referee-api/end-match',
  summary: 'End the match',
  security: [{ referee: [] }],
  responses: {
    '200': json(OkResponseSchema, 'Match ended'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled'),
    '409': error('No refereed match in progress'),
  },
});

route({
  method: 'post',
  path: '/referee-api/abandon',
  summary: 'Abandon the match',
  security: [{ referee: [] }],
  request: {
    body: { content: { [JSON]: { schema: AbandonBodySchema } } },
  },
  responses: {
    '200': json(OkResponseSchema, 'Abandoned'),
    '400': error('Bad request — "reason" is required'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled'),
    '409': error('No refereed match in progress'),
  },
});

route({
  method: 'post',
  path: '/referee-api/remove-robot',
  summary: 'Remove a robot from the field',
  security: [{ referee: [] }],
  request: {
    body: { content: { [JSON]: { schema: RemoveRobotBodySchema } } },
  },
  responses: {
    '200': json(OkResponseSchema, 'Robot removed'),
    '400': error('Bad request — "robotId", "rule" and "reason" are required strings'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled'),
    '409': error('No refereed match in progress'),
  },
});

route({
  method: 'post',
  path: '/referee-api/return-robot',
  summary: 'Return a removed robot',
  security: [{ referee: [] }],
  request: {
    body: { content: { [JSON]: { schema: ReturnRobotBodySchema } } },
  },
  responses: {
    '200': json(OkResponseSchema, 'Robot returned'),
    '400': error('Bad request — "robotId" is required'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled'),
    '409': error('No refereed match in progress, or the robot is not ready to return yet'),
  },
});

route({
  method: 'post',
  path: '/referee-api/correct-score',
  summary: 'Correct the score',
  security: [{ referee: [] }],
  request: {
    body: { content: { [JSON]: { schema: CorrectScoreBodySchema } } },
  },
  responses: {
    '200': json(OkResponseSchema, 'Score corrected'),
    '400': error('Bad request — invalid "team" or missing "to"/"reason"'),
    '401': error('Invalid or missing referee token'),
    '404': error('Referee mode is not enabled'),
    '409': error('No refereed match in progress'),
  },
});

// ─── Workspace ────────────────────────────────────────────────────────────────

const robotParam = z.object({ robot: z.union([z.literal(1), z.literal(2)]).optional() });

route({
  method: 'post',
  path: '/workspace-api/open',
  summary: 'Open the workspace',
  description: 'Who the token belongs to, and the current files of the chosen robot.',
  security: [{ team: [] }],
  request: {
    body: { content: { [JSON]: { schema: robotParam } } },
  },
  responses: {
    '200': json(WorkspaceOpenResponseSchema, 'Team, robot, and files'),
    '400': error('Bad request'),
    '401': error('Invalid or missing team token'),
    '404': error('This server is not hosting team workspaces'),
  },
});

route({
  method: 'post',
  path: '/workspace-api/save',
  summary: 'Save a file',
  security: [{ team: [] }],
  request: {
    body: { content: { [JSON]: { schema: SaveBodySchema } } },
  },
  responses: {
    '200': json(WorkspaceSaveResponseSchema, 'Saved'),
    '400': error('Bad request — "name" and "content" must be strings'),
    '401': error('Invalid or missing team token'),
    '404': error('This server is not hosting team workspaces'),
  },
});

route({
  method: 'post',
  path: '/workspace-api/delete',
  summary: 'Delete a file',
  security: [{ team: [] }],
  request: {
    body: { content: { [JSON]: { schema: DeleteBodySchema } } },
  },
  responses: {
    '200': json(WorkspaceDeleteResponseSchema, 'Deleted — current file list returned'),
    '400': error('Bad request — "name" must be a string'),
    '401': error('Invalid or missing team token'),
    '404': error('This server is not hosting team workspaces'),
  },
});

route({
  method: 'post',
  path: '/workspace-api/submit',
  summary: 'Submit the workspace',
  description: 'Validates and stores the whole folder as the team\'s submission for this robot.',
  security: [{ team: [] }],
  request: {
    body: { content: { [JSON]: { schema: robotParam } } },
  },
  responses: {
    '200': json(WorkspaceSubmitResponseSchema, 'Submitted'),
    '400': error('Bad request — validation failed, or nothing in the workspace'),
    '401': error('Invalid or missing team token'),
    '404': error('This server is not hosting team workspaces'),
  },
});

// ─── Arena (hub ↔ child) ──────────────────────────────────────────────────────

route({
  method: 'get',
  path: '/arena-api/state',
  summary: 'Arena state',
  description: 'The state of a fixture arena, polled by the hub: playing, score, clock, fidelity, result.',
  responses: {
    '200': json(ArenaStateResponseSchema, 'Arena state'),
  },
});

route({
  method: 'post',
  path: '/arena-api/lock',
  summary: 'Lock the lineup',
  description:
    "A referee saying this is the code that plays: every seat is copied out of the submissions tree into the arena and started from the copy, and any seat running an older push than its team has since made is restarted on the newest. Callable again before kick-off, and once more at half-time — which is the whole of the unlock. Not reachable from a browser: the hub calls this on loopback and refuses to proxy `/arena-api/`.",
  request: {
    body: { content: { [JSON]: { schema: LockRequestSchema } } },
  },
  responses: {
    '200': json(LockResponseSchema, 'Locked — the lineup and the arena\'s own timestamp'),
    '400': error('Bad request — the lock request failed to parse'),
    '409': error('This match has already started and is not at half-time'),
  },
});

route({
  method: 'post',
  path: '/arena-api/ready',
  summary: 'A team is ready for the second half',
  description:
    'Forwarded by the hub, which is the only thing that knows whose session this was. The second half\'s kick-off is refused until both sides have said this or half-time has run out.',
  request: {
    body: { content: { [JSON]: { schema: ReadyRequestSchema } } },
  },
  responses: {
    '200': json(OkResponseSchema, 'Taken'),
    '400': error('"side" must be "violet" or "lime"'),
    '409': error('This match is not at half-time'),
  },
});

route({
  method: 'post',
  path: '/arena-api/play',
  summary: 'Start a fixture leg in the arena',
  description: 'The hub\'s call into a child arena — what to play, with whom, under which seed. Answers 202 at once; the hub polls `state` for the result.',
  request: {
    body: { content: { [JSON]: { schema: PlayRequestSchema } } },
  },
  responses: {
    '202': json(OkResponseSchema, 'Accepted — the leg is being set up'),
    '400': error('Bad request — the play request failed to parse'),
    '409': error('This arena is already playing'),
  },
});