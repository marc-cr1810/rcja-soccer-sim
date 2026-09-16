/**
 * Zod schemas for every API surface, with TypeScript types derived from them.
 *
 * These serve two purposes: OpenAPI documentation (via @asteasolutions/zod-to-openapi)
 * and runtime request/response validation (Stage 2). The schemas are the single
 * source of truth — types are derived, never declared separately.
 *
 * Every top-level schema is registered as an OpenAPI component by passing a name
 * to `.openapi('Name', { ... })`. The generator in `openapi.ts` picks these up
 * directly (see `buildOpenApi`), so no separate registry registration is needed.
 */

import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// ─── Scalar enums ─────────────────────────────────────────────────────────────

export const TeamIdSchema = z
  .enum(['violet', 'lime'])
  .openapi('TeamId', { description: 'Team side' });
export type TeamId = z.infer<typeof TeamIdSchema>;

export const RoleSchema = z.enum(['guest', 'team', 'referee', 'admin']).openapi('Role');
export type Role = z.infer<typeof RoleSchema>;

export const AccountKindSchema = z
  .enum(['team', 'person'])
  .openapi('AccountKind');
export type AccountKind = z.infer<typeof AccountKindSchema>;

// ─── Shared value objects ──────────────────────────────────────────────────────

export const ScoreSchema = z
  .object({
    violet: z.number().int(),
    lime: z.number().int(),
  })
  .openapi('Score', { description: 'Score keyed by team side' });
export type Score = z.infer<typeof ScoreSchema>;

export const SeedSchema = z
  .union([
    z.number(),
    z.object({
      hi: z.number().int(),
      lo: z.number().int(),
    }),
  ])
  .openapi('Seed', { description: 'Match seed: a plain number, or the full 64-bit {hi,lo} form' });
export type Seed = z.infer<typeof SeedSchema>;

export const GoalSchema = z
  .object({
    team: TeamIdSchema,
    at: z.number().openapi({ description: 'Match clock when scored, in seconds' }),
  })
  .openapi('Goal');
export type Goal = z.infer<typeof GoalSchema>;

export const EventKindSchema = z
  .enum([
    'goal',
    'ball-out-of-play',
    'lack-of-progress',
    'possible-multiple-defence',
    'possible-damaged',
    'kickoff',
    'kickoff-live',
    'illegal-kickoff',
    'paused',
    'resumed',
    'score-corrected',
  ])
  .openapi('EventKind');
export type EventKind = z.infer<typeof EventKindSchema>;

export const MatchEventSchema = z
  .object({
    kind: EventKindSchema,
    rule: z.string().openapi({ description: 'Rule number this event hangs off' }),
    message: z.string(),
    robotId: z.string().optional(),
    team: TeamIdSchema.optional(),
    at: z.number().openapi({ description: 'Match clock, in seconds' }),
  })
  .openapi('MatchEvent');
export type MatchEvent = z.infer<typeof MatchEventSchema>;

export const RefereeActionSchema = z
  .object({
    action: z.string(),
    at: z.number().openapi({ description: 'Match clock, in seconds' }),
    detail: z.string().optional(),
  })
  .openapi('RefereeAction');
export type RefereeAction = z.infer<typeof RefereeActionSchema>;

export const ScoreCorrectionSchema = z
  .object({
    team: TeamIdSchema,
    from: z.number().int(),
    to: z.number().int(),
    reason: z.string(),
    at: z.number(),
  })
  .openapi('ScoreCorrection');
export type ScoreCorrection = z.infer<typeof ScoreCorrectionSchema>;

// ─── Account / auth ────────────────────────────────────────────────────────────

export const PublicAccountSchema = z
  .object({
    id: z.string().openapi({ description: 'Hex account id' }),
    slug: z.string().openapi({ description: 'Lowercased, dash-separated team name' }),
    displayName: z.string(),
    role: RoleSchema,
    kind: AccountKindSchema,
    createdAt: z.string().openapi({ description: 'ISO timestamp' }),
    disabledAt: z.string().nullable(),
  })
  .openapi('PublicAccount', { description: 'An account as the public may see it — never the hash or email' });
export type PublicAccount = z.infer<typeof PublicAccountSchema>;

export const RegisterBodySchema = z
  .object({
    code: z.string().openapi({ description: 'Invitation code' }),
    password: z.string().min(10),
    name: z.string().optional(),
    email: z.string().email().optional(),
  })
  .openapi('RegisterBody', { description: 'Body for POST /auth/register' });
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const LoginBodySchema = z
  .object({
    name: z.string().openapi({ description: 'Account name' }),
    password: z.string(),
  })
  .openapi('LoginBody', { description: 'Body for POST /auth/login' });
export type LoginBody = z.infer<typeof LoginBodySchema>;

// ─── Tournament ────────────────────────────────────────────────────────────────

export const TournamentSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    entrants: z.array(z.string()),
    fixturesTotal: z.number().int(),
  })
  .openapi('TournamentSummary', { description: 'Overview of the current tournament' });
export type TournamentSummary = z.infer<typeof TournamentSummarySchema>;

export const FixtureVerdictSchema = z
  .object({
    homeLegsWon: z.number().int(),
    awayLegsWon: z.number().int(),
    drawnLegs: z.number().int(),
    homeGoals: z.number().int(),
    awayGoals: z.number().int(),
    outcome: z
      .enum(['won', 'drawn', 'lost'])
      .openapi({ description: "From the home side's point of view" }),
  })
  .openapi('FixtureVerdict', { description: 'Who won a fixture, and by what — legs won decides, not aggregate goals' });
export type FixtureVerdict = z.infer<typeof FixtureVerdictSchema>;

export const StandingSchema = z
  .object({
    name: z.string(),
    origin: z.enum(['student', 'reference', 'generated']),
    played: z.number().int(),
    won: z.number().int(),
    drawn: z.number().int(),
    lost: z.number().int(),
    for: z.number().int().openapi({ description: 'Goals scored' }),
    against: z.number().int().openapi({ description: 'Goals conceded' }),
    points: z.number().int(),
    missed: z.number().int().openapi({ description: 'Control cycles programs failed to answer' }),
    errors: z.number().int(),
  })
  .openapi('Standing', { description: 'One row of the league table, derived from results' });
export type Standing = z.infer<typeof StandingSchema>;

// ─── Fixtures / schedule ───────────────────────────────────────────────────────

export const ResultCardSchema = z
  .object({
    fixtureId: z.string(),
    home: z.string(),
    away: z.string(),
    homeScore: z.number().int(),
    awayScore: z.number().int(),
    verdict: FixtureVerdictSchema,
    completedAt: z.string().openapi({ description: 'ISO timestamp' }),
  })
  .openapi('ResultCard', { description: 'The result of a completed fixture' });
export type ResultCard = z.infer<typeof ResultCardSchema>;

export const ScheduleFixtureSchema = z
  .object({
    id: z.string(),
    home: z.string(),
    away: z.string(),
    state: z.enum(['played', 'playing', 'upcoming']),
    fixtureId: z.string().optional().openapi({ description: 'Present when state=played' }),
    homeScore: z.number().int().optional().openapi({ description: 'Present when state=played' }),
    awayScore: z.number().int().optional().openapi({ description: 'Present when state=played' }),
    verdict: FixtureVerdictSchema.optional().openapi({ description: 'Present when state=played' }),
    completedAt: z.string().optional().openapi({ description: 'Present when state=played' }),
  })
  .openapi('ScheduleFixture', { description: 'A fixture as it appears in the schedule — includes the result card when played' });
export type ScheduleFixture = z.infer<typeof ScheduleFixtureSchema>;

// ─── Match record ──────────────────────────────────────────────────────────────

export const LegRecordSchema = z
  .object({
    seed: SeedSchema,
    score: ScoreSchema,
    clock: z.number().openapi({ description: 'Seconds of match time played' }),
    goals: z.array(GoalSchema),
    calls: z.record(z.string(), z.number().int()).openapi({ description: 'Referee calls by kind' }),
    events: z.array(MatchEventSchema),
    refereeActions: z.array(RefereeActionSchema),
  })
  .openapi('LegRecord', { description: 'One leg of a fixture — the detailed match record' });
export type LegRecord = z.infer<typeof LegRecordSchema>;

export const MatchRecordSchema = z
  .object({
    completedAt: z.string(),
    submissions: z
      .record(z.string(), z.string())
      .openapi({ description: 'Seat id to sha256 hex of the code played' }),
    verdict: FixtureVerdictSchema,
    legs: z.array(LegRecordSchema),
  })
  .openapi('MatchRecord', { description: 'Full match record — only present when state=played' });
export type MatchRecord = z.infer<typeof MatchRecordSchema>;

// ─── Practice ──────────────────────────────────────────────────────────────────

export const PlacedRobotSchema = z
  .object({
    id: z.string().openapi({ description: 'Seat id: violet-1, violet-2, lime-1, or lime-2' }),
    x: z.number(),
    z: z.number(),
    heading: z.number().openapi({ description: 'Radians; 0 points towards +x' }),
    isGoalie: z.boolean(),
  })
  .openapi('PlacedRobot');
export type PlacedRobot = z.infer<typeof PlacedRobotSchema>;

export const ArrangementSchema = z
  .object({
    robots: z.array(PlacedRobotSchema),
    ball: z.object({
      x: z.number(),
      z: z.number(),
      vx: z.number().optional(),
      vz: z.number().optional(),
    }),
  })
  .openapi('Arrangement', { description: 'A situation on the field — who is where and where the ball is' });
export type Arrangement = z.infer<typeof ArrangementSchema>;

export const SeatFillSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('empty') }),
    z.object({ kind: z.literal('built-in') }),
    z.object({
      kind: z.literal('laptop'),
      team: z
        .string()
        .trim()
        .min(1)
        .optional()
        .openapi({ description: 'Whose robot is joining. Required on a league server; absent on a laptop, where nobody is asking.' }),
      token: z
        .string()
        .optional()
        .openapi({ description: 'Minted by the hub for this one seat and injected on the way through. A browser never sends this.' }),
    }),
    z.object({ kind: z.literal('submission'), team: z.string().trim().min(1) }),
  ])
  .openapi('SeatFill', { description: 'What is driving a seat, or that nothing is' });
export type SeatFill = z.infer<typeof SeatFillSchema>;

export const SeatStateSchema = z
  .object({
    fill: SeatFillSchema,
    onField: z.boolean().openapi({ description: 'Whether this robot is part of the situation at all' }),
    removed: z.boolean().openapi({ description: 'Off the field under rule 5.7 (program not answering)' }),
    filled: z.boolean().openapi({ description: 'Whether a program is in the seat' }),
    connected: z.boolean().openapi({ description: 'Whether that program is answering' }),
    detail: z.string().optional().openapi({ description: 'Why the seat is not what was asked for, when it is not' }),
  })
  .openapi('SeatState');
export type SeatState = z.infer<typeof SeatStateSchema>;

export const PracticeStateSchema = z
  .object({
    running: z.boolean(),
    resolve: z.enum(['restage', 'play-on', 'freeze']),
    clock: z.number(),
    score: ScoreSchema,
    arrangement: ArrangementSchema,
    seats: z.record(z.string(), SeatStateSchema).openapi({ description: 'Seat id → seat state' }),
  })
  .openapi('PracticeState', { description: 'The live state of a practice field' });
export type PracticeState = z.infer<typeof PracticeStateSchema>;

// ─── Workspace ─────────────────────────────────────────────────────────────────

export const WorkspaceFileSchema = z
  .object({
    name: z.string(),
    content: z.string(),
  })
  .openapi('WorkspaceFile', { description: "A file in a team's workspace" });
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

// ─── Arenas ────────────────────────────────────────────────────────────────────

export const ArenaUsageSchema = z
  .object({
    cores: z.number().int(),
    memoryMb: z.number().int(),
    processes: z.number().int(),
  })
  .openapi('ArenaUsage', { description: 'Resource usage of a child arena process' });
export type ArenaUsage = z.infer<typeof ArenaUsageSchema>;

export const ArenaInfoSchema = z
  .object({
    id: z.string().openapi({ description: 'Base64url arena id' }),
    kind: z.enum(['fixture', 'practice']),
    owner: z.string().nullable(),
    url: z.string().openapi({ description: 'Relative URL to open the arena' }),
    createdAt: z.string(),
    usage: ArenaUsageSchema.nullable(),
    fidelity: z.number().nullable().openapi({ description: 'Simulated seconds per wall second while playing' }),
  })
  .openapi('ArenaInfo', { description: 'Summary of a running arena' });
export type ArenaInfo = z.infer<typeof ArenaInfoSchema>;

// ─── Arena state (hub ↔ child) ────────────────────────────────────────────────

export const PlayedMatchSchema = z
  .object({
    result: z
      .object({
        score: ScoreSchema,
        clock: z.number(),
        goals: z.array(GoalSchema),
        calls: z.record(z.string(), z.number().int()),
        events: z.array(MatchEventSchema),
        refereeActions: z.array(RefereeActionSchema),
        scoreCorrections: z.array(ScoreCorrectionSchema),
        abandoned: z.boolean(),
        abandonReason: z.string().optional(),
      })
      .openapi({ description: 'Full match result' }),
    submissions: z
      .record(z.string(), z.string())
      .openapi({ description: 'Seat id to sha256 hex of the code played' }),
  })
  .openapi('PlayedMatch', { description: 'What played, once it has — held until the hub collects it' });
export type PlayedMatch = z.infer<typeof PlayedMatchSchema>;

export const ArenaStateSchema = z
  .object({
    playing: z.boolean(),
    label: z.string().nullable(),
    score: ScoreSchema.nullable(),
    clock: z.number(),
    half: z.union([z.literal(1), z.literal(2)]),
    running: z.boolean(),
    fidelity: z.number().nullable(),
    finished: PlayedMatchSchema.nullable(),
    error: z.string().nullable(),
  })
  .openapi('ArenaState', { description: 'The state of a fixture arena, polled by the hub' });
export type ArenaState = z.infer<typeof ArenaStateSchema>;

// ─── Viewer ────────────────────────────────────────────────────────────────────

export const ViewBallSchema = z
  .object({
    x: z.number(),
    z: z.number(),
    y: z.number().optional().openapi({ description: 'Height above the carpet, for a chip kick' }),
    radius: z.number(),
  })
  .openapi('ViewBall');
export type ViewBall = z.infer<typeof ViewBallSchema>;

export const ViewRobotSchema = z
  .object({
    id: z.string(),
    team: TeamIdSchema,
    x: z.number(),
    z: z.number(),
    heading: z.number(),
    radius: z.number(),
    removed: z.boolean(),
    isGoalie: z.boolean(),
    penaltyRemaining: z.number().openapi({ description: 'Seconds left of the 5.7.2 stand-down' }),
    removalRule: z.string().optional(),
    removalReason: z.string().optional(),
  })
  .openapi('ViewRobot');
export type ViewRobot = z.infer<typeof ViewRobotSchema>;

export const ViewKickoffSchema = z
  .object({
    team: z.enum(['violet', 'lime']).nullable().openapi({ description: 'Team taking the restart; null between restarts' }),
    countdown: z.number().openapi({ description: 'Seconds left before the whistle makes the kick-off live' }),
  })
  .openapi('ViewKickoff');
export type ViewKickoff = z.infer<typeof ViewKickoffSchema>;

export const ViewEventSchema = z
  .object({
    kind: z.string(),
    rule: z.string(),
    message: z.string(),
    at: z.number(),
    team: TeamIdSchema.optional(),
  })
  .openapi('ViewEvent');
export type ViewEvent = z.infer<typeof ViewEventSchema>;

export const ViewFrameSchema = z
  .object({
    clock: z.number(),
    half: z.union([z.literal(1), z.literal(2)]),
    running: z.boolean(),
    kickoff: ViewKickoffSchema,
    score: ScoreSchema,
    ball: ViewBallSchema,
    robots: z.array(ViewRobotSchema),
    commsEnabled: z.boolean(),
    commsActivity: z.object({ violet: z.number(), lime: z.number() }),
    events: z.array(ViewEventSchema).openapi({ description: 'The most recent calls, newest last (max 4)' }),
    teams: z.object({ violet: z.string(), lime: z.string() }),
  })
  .openapi('ViewFrame', { description: 'A frame a viewer draws, sent at ~30fps' });
export type ViewFrame = z.infer<typeof ViewFrameSchema>;

// ─── League ────────────────────────────────────────────────────────────────────

export const LeagueSchema = z
  .object({
    id: z.enum(['lightweight', 'open']),
    name: z.string(),
    blurb: z.string(),
    ball: z.enum(['ir-74', 'passive-42']),
    maxWeightKg: z.number(),
    maxDiameterMm: z.number(),
    maxHeightMm: z.number(),
    ballCaptureMm: z.number(),
    minWallHeightMm: z.number(),
    dribblerAllowed: z.boolean(),
    kickerAllowed: z.boolean(),
    chipKickerAllowed: z.boolean(),
    lineSensorsAllowed: z.boolean(),
    fullyOutIsDamaged: z.boolean(),
    removalNeedsRefereeApproval: z.boolean(),
    gyroCompassAllowed: z.boolean(),
    omniWheelsAllowed: z.boolean(),
    commsAllowed: z.boolean(),
    internationalPathway: z.string().nullable(),
    maxVoltageDc: z.number(),
    accent: z.string(),
  })
  .openapi('League', { description: 'A robotic soccer league (rule 1.2): Lightweight or Open' });
export type League = z.infer<typeof LeagueSchema>;

// ─── Admin ─────────────────────────────────────────────────────────────────────

export const ApiKeyInfoSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .openapi('ApiKeyInfo', { description: 'A push key as the public may see it — the raw key is never shown again' });
export type ApiKeyInfo = z.infer<typeof ApiKeyInfoSchema>;

export const InviteSchema = z
  .object({
    code: z.string().openapi({ description: 'The redeemable invitation code' }),
    role: RoleSchema,
    team: z.string().nullable().openapi({ description: 'Set only for team invites' }),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
    expiresAt: z.string().openapi({ description: 'ISO timestamp, 14 days out' }),
    usedAt: z.string().nullable(),
  })
  .openapi('Invite', { description: 'A single-use invitation code' });
export type Invite = z.infer<typeof InviteSchema>;

export const AuditRowSchema = z
  .object({
    at: z.string(),
    actorId: z.string().nullable(),
    actorName: z.string().nullable(),
    capability: z.string(),
    target: z.string().nullable(),
    detail: z.string().nullable(),
  })
  .openapi('AuditRow', { description: 'One row of the audit log' });
export type AuditRow = z.infer<typeof AuditRowSchema>;

// ─── Request bodies ────────────────────────────────────────────────────────────

export const CreateKeyBodySchema = z
  .object({ label: z.string().optional().openapi({ description: 'Defaults to "push key"' }) })
  .openapi('CreateKeyBody', { description: 'Body for POST /api/keys' });
export type CreateKeyBody = z.infer<typeof CreateKeyBodySchema>;

export const CreateInviteBodySchema = z
  .object({
    role: RoleSchema,
    team: z.string().optional().openapi({ description: 'Required when role=team' }),
  })
  .openapi('CreateInviteBody', { description: 'Body for POST /api/admin/invites' });
export type CreateInviteBody = z.infer<typeof CreateInviteBodySchema>;

export const ResetPasswordBodySchema = z
  .object({ password: z.string().min(10) })
  .openapi('ResetPasswordBody', { description: 'Body for POST /api/admin/accounts/{id}/password' });
export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>;

export const SetDisabledBodySchema = z
  .object({ disabled: z.boolean().optional() })
  .openapi('SetDisabledBody', { description: 'Body for POST /api/admin/accounts/{id}/disabled' });
export type SetDisabledBody = z.infer<typeof SetDisabledBodySchema>;

export const SubmitBodySchema = z
  .object({
    files: z
      .record(z.string(), z.string())
      .openapi({ description: 'Flat filename → base64-encoded content' }),
  })
  .openapi('SubmitBody', { description: "One robot's folder, pushed as {files: {path: base64}}" });
export type SubmitBody = z.infer<typeof SubmitBodySchema>;

export const PlaceBodySchema = z
  .object({
    target: z.union([z.literal('ball'), z.enum(['violet-1', 'violet-2', 'lime-1', 'lime-2'])]).openapi({
      description: '"ball" or a seat id',
    }),
    x: z.number(),
    z: z.number(),
    heading: z.number().optional(),
    vx: z.number().optional(),
    vz: z.number().optional(),
  })
  .openapi('PlaceBody', { description: 'Body for POST /practice-api/place' });
export type PlaceBody = z.infer<typeof PlaceBodySchema>;

export const RosterBodySchema = z
  .object({
    seat: z.enum(['violet-1', 'violet-2', 'lime-1', 'lime-2']),
    onField: z.boolean(),
  })
  .openapi('RosterBody', { description: 'Body for POST /practice-api/roster' });
export type RosterBody = z.infer<typeof RosterBodySchema>;

export const ResolveBodySchema = z
  .object({ mode: z.enum(['restage', 'play-on', 'freeze']) })
  .openapi('ResolveBody', { description: 'Body for POST /practice-api/resolve' });
export type ResolveBody = z.infer<typeof ResolveBodySchema>;

export const InviteTeamBodySchema = z
  .object({
    team: z
      .string()
      .trim()
      .min(1)
      .openapi({ description: 'The team to invite onto this practice field, by name or slug' }),
  })
  .openapi('InviteTeamBody', { description: 'Body for POST /api/fields/{id}/invite' });
export type InviteTeamBody = z.infer<typeof InviteTeamBodySchema>;

export const SeatBodySchema = z
  .object({
    seat: z.enum(['violet-1', 'violet-2', 'lime-1', 'lime-2']),
    fill: SeatFillSchema,
  })
  .openapi('SeatBody', { description: 'Body for POST /practice-api/seat' });
export type SeatBody = z.infer<typeof SeatBodySchema>;

export const SeatActionBodySchema = z
  .object({ seat: z.enum(['violet-1', 'violet-2', 'lime-1', 'lime-2']) })
  .openapi('SeatActionBody', { description: 'Body for POST /practice-api/seat-restart or seat-stop' });
export type SeatActionBody = z.infer<typeof SeatActionBodySchema>;

export const KickoffBodySchema = z
  .object({ team: TeamIdSchema })
  .openapi('KickoffBody', { description: 'Body for POST /referee-api/kickoff' });
export type KickoffBody = z.infer<typeof KickoffBodySchema>;

export const AbandonBodySchema = z
  .object({ reason: z.string().trim().min(1).openapi({ description: 'Why the match is being abandoned' }) })
  .openapi('AbandonBody', { description: 'Body for POST /referee-api/abandon' });
export type AbandonBody = z.infer<typeof AbandonBodySchema>;

export const RemoveRobotBodySchema = z
  .object({
    robotId: z.string().openapi({ description: 'Seat id of the robot to remove' }),
    rule: z.string().openapi({ description: 'Rule number, e.g. "5.7.1"' }),
    reason: z.string(),
  })
  .openapi('RemoveRobotBody', { description: 'Body for POST /referee-api/remove-robot' });
export type RemoveRobotBody = z.infer<typeof RemoveRobotBodySchema>;

export const ReturnRobotBodySchema = z
  .object({ robotId: z.string().openapi({ description: 'Seat id of the robot to return' }) })
  .openapi('ReturnRobotBody', { description: 'Body for POST /referee-api/return-robot' });
export type ReturnRobotBody = z.infer<typeof ReturnRobotBodySchema>;

export const CorrectScoreBodySchema = z
  .object({
    team: TeamIdSchema,
    to: z.number().int().nonnegative(),
    reason: z.string().trim().min(1),
  })
  .openapi('CorrectScoreBody', { description: 'Body for POST /referee-api/correct-score' });
export type CorrectScoreBody = z.infer<typeof CorrectScoreBodySchema>;

export const SaveBodySchema = z
  .object({
    name: z.string(),
    content: z.string(),
  })
  .openapi('SaveBody', { description: 'Body for POST /workspace-api/save' });
export type SaveBody = z.infer<typeof SaveBodySchema>;

export const DeleteBodySchema = z
  .object({ name: z.string() })
  .openapi('DeleteBody', { description: 'Body for POST /workspace-api/delete' });
export type DeleteBody = z.infer<typeof DeleteBodySchema>;

export const PlayRequestSchema = z
  .object({
    teams: z.object({ violet: z.string(), lime: z.string() }),
    seed: SeedSchema,
    halfSeconds: z.number().optional(),
    league: z.enum(['lightweight', 'open']).optional(),
    refereed: z.boolean().optional(),
    label: z.string().optional().openapi({ description: 'For the arena log — e.g. "round-1:f2 leg 1 of 2"' }),
  })
  .openapi('PlayRequest', { description: 'What the hub asks for: one leg of one fixture' });
export type PlayRequest = z.infer<typeof PlayRequestSchema>;

// ─── Error envelope ────────────────────────────────────────────────────────────

export const ErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    reason: z.string(),
  })
  .openapi('Error', { description: 'Error response envelope — every failure returns this shape' });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ─── Compound responses ────────────────────────────────────────────────────────

export const LiveFixtureSchema = z
  .object({
    fixtureId: z.string(),
    home: z.string(),
    away: z.string(),
    score: ScoreSchema,
    clock: z.number(),
    half: z.union([z.literal(1), z.literal(2)]),
    running: z.boolean(),
  })
  .openapi('LiveFixture', { description: 'What the front page shows in its "now playing" band' });
export type LiveFixture = z.infer<typeof LiveFixtureSchema>;

export const FrontUpcomingSchema = z
  .object({ id: z.string(), home: z.string(), away: z.string() })
  .openapi('FrontUpcoming', { description: 'A fixture about to play' });
export type FrontUpcoming = z.infer<typeof FrontUpcomingSchema>;

export const FrontNextSchema = z
  .object({
    id: z.string(),
    home: z.string(),
    away: z.string(),
    seeds: z.array(SeedSchema),
  })
  .openapi('FrontNext', { description: 'The next fixture to play (when nothing is live)' });
export type FrontNext = z.infer<typeof FrontNextSchema>;

export const FrontResponseSchema = z
  .object({
    ok: z.literal(true),
    tournament: TournamentSummarySchema.nullable(),
    live: LiveFixtureSchema.nullable(),
    next: FrontNextSchema.nullable().openapi({ description: 'Only non-null when nothing is live' }),
    upcoming: z.array(FrontUpcomingSchema).openapi({ description: 'First 6 unplayed, non-live fixtures' }),
    recent: z.array(ResultCardSchema).openapi({ description: 'Newest 6 completed fixtures' }),
    table: z.array(StandingSchema),
  })
  .openapi('FrontResponse', { description: 'GET /api/front — front page data' });
export type FrontResponse = z.infer<typeof FrontResponseSchema>;

export const ScheduleResponseSchema = z
  .object({
    ok: z.literal(true),
    tournament: TournamentSummarySchema.nullable(),
    fixtures: z.array(ScheduleFixtureSchema),
  })
  .openapi('ScheduleResponse', { description: 'GET /api/schedule — fixture list with results for played fixtures' });
export type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>;

export const StandingsResponseSchema = z
  .object({
    ok: z.literal(true),
    tournament: TournamentSummarySchema.nullable(),
    table: z.array(StandingSchema),
  })
  .openapi('StandingsResponse', { description: 'GET /api/standings — derived league table' });
export type StandingsResponse = z.infer<typeof StandingsResponseSchema>;

export const MatchResponseSchema = z
  .object({
    ok: z.literal(true),
    tournament: TournamentSummarySchema,
    fixture: z.object({
      id: z.string(),
      home: z.string(),
      away: z.string(),
      seeds: z.array(SeedSchema),
    }),
    state: z.enum(['played', 'playing', 'upcoming']),
    live: LiveFixtureSchema.nullable(),
    record: MatchRecordSchema.nullable(),
  })
  .openapi('MatchResponse', { description: 'GET /api/match/{fixtureId} — fixture detail with full match record' });
export type MatchResponse = z.infer<typeof MatchResponseSchema>;

export const TeamResponseSchema = z
  .object({
    ok: z.literal(true),
    team: z
      .union([PublicAccountSchema, z.object({ slug: z.string(), displayName: z.string() })])
      .nullable()
      .openapi({ description: 'PublicAccount if an account exists, {slug,displayName} if only a draw entrant, null otherwise' }),
    tournament: TournamentSummarySchema.nullable(),
    fixtures: z.array(ScheduleFixtureSchema),
    table: StandingSchema.nullable(),
  })
  .openapi('TeamResponse', { description: 'GET /api/team/{slug} — team page data' });
export type TeamResponse = z.infer<typeof TeamResponseSchema>;

export const MeResponseSchema = z
  .object({
    ok: z.literal(true),
    account: PublicAccountSchema.nullable(),
    can: z
      .object({
        workspace: z.boolean(),
        referee: z.boolean(),
        admin: z.boolean(),
      })
      .openapi({ description: 'Capability flags for the current user' }),
  })
  .openapi('MeResponse', { description: 'GET /api/me — who am I and what can I do?' });
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const KeysResponseSchema = z
  .object({ ok: z.literal(true), keys: z.array(ApiKeyInfoSchema) })
  .openapi('KeysResponse', { description: 'GET /api/keys — list push keys' });
export type KeysResponse = z.infer<typeof KeysResponseSchema>;

export const KeyCreatedResponseSchema = z
  .object({
    ok: z.literal(true),
    key: z.string().openapi({ description: 'The raw push key — returned only at creation time' }),
    info: ApiKeyInfoSchema,
  })
  .openapi('KeyCreatedResponse', { description: 'POST /api/keys — newly minted push key' });
export type KeyCreatedResponse = z.infer<typeof KeyCreatedResponseSchema>;

export const KeyRevokeResponseSchema = z
  .object({
    ok: z.boolean().openapi({ description: 'true when the key existed and was revoked, false when no such key' }),
  })
  .openapi('KeyRevokeResponse', { description: 'POST /api/keys/{keyId}/revoke' });
export type KeyRevokeResponse = z.infer<typeof KeyRevokeResponseSchema>;

export const AdminAccountsResponseSchema = z
  .object({ ok: z.literal(true), accounts: z.array(PublicAccountSchema) })
  .openapi('AdminAccountsResponse', { description: 'GET /api/admin/accounts' });
export type AdminAccountsResponse = z.infer<typeof AdminAccountsResponseSchema>;

export const AdminInvitesResponseSchema = z
  .object({ ok: z.literal(true), invites: z.array(InviteSchema) })
  .openapi('AdminInvitesResponse', { description: 'GET /api/admin/invites' });
export type AdminInvitesResponse = z.infer<typeof AdminInvitesResponseSchema>;

export const AdminInviteCreatedResponseSchema = z
  .object({ ok: z.literal(true), invite: InviteSchema })
  .openapi('AdminInviteCreatedResponse', { description: 'POST /api/admin/invites' });
export type AdminInviteCreatedResponse = z.infer<typeof AdminInviteCreatedResponseSchema>;

export const AdminAuditResponseSchema = z
  .object({ ok: z.literal(true), audit: z.array(AuditRowSchema) })
  .openapi('AdminAuditResponse', { description: 'GET /api/admin/audit — newest 200 entries' });
export type AdminAuditResponse = z.infer<typeof AdminAuditResponseSchema>;

export const OkResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi('Ok', { description: 'Generic success response with no additional data' });
export type OkResponse = z.infer<typeof OkResponseSchema>;

export const SubmitResponseSchema = z
  .object({
    ok: z.literal(true),
    team: z.string(),
    robot: z.union([z.literal(1), z.literal(2)]),
    token: z.string().openapi({ description: 'Fresh base64url join token, minted per push' }),
  })
  .openapi('SubmitResponse', { description: 'POST /submit — successful robot push' });
export type SubmitResponse = z.infer<typeof SubmitResponseSchema>;

export const PracticeFieldsResponseSchema = z
  .object({ ok: z.literal(true), fields: z.array(ArenaInfoSchema) })
  .openapi('PracticeFieldsResponse', { description: 'GET /practice — list open practice fields' });
export type PracticeFieldsResponse = z.infer<typeof PracticeFieldsResponseSchema>;

export const PracticeFieldCreatedResponseSchema = z
  .object({ ok: z.literal(true), field: ArenaInfoSchema })
  .openapi('PracticeFieldCreatedResponse', { description: 'POST /practice — a new field was opened' });
export type PracticeFieldCreatedResponse = z.infer<typeof PracticeFieldCreatedResponseSchema>;

export const PracticeStateResponseSchema = z
  .object({ ok: z.literal(true), state: PracticeStateSchema })
  .openapi('PracticeStateResponse', { description: 'GET or POST /practice-api/* — current practice field state' });
export type PracticeStateResponse = z.infer<typeof PracticeStateResponseSchema>;

export const WorkspaceOpenResponseSchema = z
  .object({
    ok: z.literal(true),
    team: z.string(),
    robot: z.union([z.literal(1), z.literal(2)]),
    files: z.array(WorkspaceFileSchema),
  })
  .openapi('WorkspaceOpenResponse', { description: 'POST /workspace-api/open — who am I and what is in my folder' });
export type WorkspaceOpenResponse = z.infer<typeof WorkspaceOpenResponseSchema>;

export const WorkspaceSaveResponseSchema = z
  .object({ ok: z.literal(true), name: z.string() })
  .openapi('WorkspaceSaveResponse', { description: 'POST /workspace-api/save' });
export type WorkspaceSaveResponse = z.infer<typeof WorkspaceSaveResponseSchema>;

export const WorkspaceDeleteResponseSchema = z
  .object({ ok: z.literal(true), files: z.array(WorkspaceFileSchema) })
  .openapi('WorkspaceDeleteResponse', { description: 'POST /workspace-api/delete — returns the now-current file list' });
export type WorkspaceDeleteResponse = z.infer<typeof WorkspaceDeleteResponseSchema>;

export const WorkspaceSubmitResponseSchema = z
  .object({
    ok: z.literal(true),
    team: z.string(),
    robot: z.union([z.literal(1), z.literal(2)]),
  })
  .openapi('WorkspaceSubmitResponse', { description: 'POST /workspace-api/submit — note: no token is returned (unlike POST /submit)' });
export type WorkspaceSubmitResponse = z.infer<typeof WorkspaceSubmitResponseSchema>;

export const ArenaStateResponseSchema = z
  .object({ ok: z.literal(true), state: ArenaStateSchema })
  .openapi('ArenaStateResponse', { description: 'GET /arena-api/state' });
export type ArenaStateResponse = z.infer<typeof ArenaStateResponseSchema>;

export const RefereeSessionResponseSchema = z
  .object({ ok: z.boolean() })
  .openapi('RefereeSessionResponse', { description: 'GET /referee-api/session — ok=true when the bearer is authorized as referee' });
export type RefereeSessionResponse = z.infer<typeof RefereeSessionResponseSchema>;