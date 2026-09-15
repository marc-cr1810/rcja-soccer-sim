/**
 * A fixture arena, from the inside.
 *
 * The hub plays no football. It owns accounts, the draw, the schedule and the
 * front page, and when a fixture is due it starts one of these — a child
 * process running the same `MatchServer` a team runs on a laptop — tells it
 * what to play, and asks how it is going. This file is the surface it tells
 * and asks through.
 *
 * **The child resolves and spawns its own lineup.** That is what "the hub
 * plays no football" has to mean in practice: if the hub still reached into
 * `submissions/`, spawned four sandboxed CPython processes and held their
 * transports, the child would be a viewer rather than a world and every
 * runaway robot would still be in the hub's process tree. `resolveLineup` and
 * `spawnLineup` moved here out of the draw runner for exactly that reason.
 *
 * **Starting is a request and finishing is a poll.** A match takes ten minutes
 * of wall-clock; an HTTP request held open across it is a socket that has to
 * survive a hall's network, a proxy's idea of a timeout and a laptop's sleep.
 * So `play` answers immediately and the hub asks `state` at a lazy interval —
 * which it wants anyway, because the score on the front page comes from the
 * same answer.
 *
 * **Nothing here is authenticated.** A fixture arena binds loopback and is
 * reached only through the hub, which has already decided who is asking. The
 * referee surface the child also serves is the ordinary one from Phase 2, held
 * to a token the supervisor minted and only the hub knows.
 */

import type { MatchResult } from './match';
import type { LeagueId } from './leagues';
import type { SeedInput } from './rand';
import { referenceTeam } from './reference';
import { resolveLineup, spawnLineup, type SpawnedLineup } from './lineup';
import { hashSubmission } from './submission';
import type { MatchServer } from './server';

export interface FixtureArenaOptions {
  pythonLibDir: string | null;
  /** Per-seat grants, one number for practice and finals alike. */
  seatCpuPercent?: number;
  seatMemoryMb?: number;
  log?: (line: string) => void;
}

/** What the hub asks for: one leg of one fixture. */
export interface PlayRequest {
  teams: { violet: string; lime: string };
  seed: SeedInput;
  halfSeconds?: number;
  league?: LeagueId;
  refereed?: boolean;
  /** For the arena's own log lines — "round-1:f2 leg 1 of 2". */
  label?: string;
}

/** What played, once it has. */
export interface PlayedMatch {
  result: MatchResult;
  /** sha256 per seat id, for whichever seats a real submission filled. */
  submissions: Record<string, string>;
}

export interface ArenaState {
  playing: boolean;
  label: string | null;
  /** The scoreboard, small enough to poll at a lazy interval. */
  score: { violet: number; lime: number } | null;
  clock: number;
  half: 1 | 2;
  running: boolean;
  /** Simulated seconds per wall second, or `null` until a window has closed. */
  fidelity: number | null;
  /** The finished match, held until the hub collects it. */
  finished: PlayedMatch | null;
  /** Why the last request could not be played, if it could not. */
  error: string | null;
}

export class FixtureArena {
  private playing: PlayRequest | null = null;
  private finished: PlayedMatch | null = null;
  private error: string | null = null;
  private lineup: SpawnedLineup | null = null;
  private readonly log: (line: string) => void;

  constructor(
    private readonly server: MatchServer,
    private readonly opts: FixtureArenaOptions,
  ) {
    this.log = opts.log ?? (() => {});
  }

  /**
   * The control surface, mounted ahead of everything else the server routes.
   *
   * Returns a `Response` if it handled the request, or `null` to pass through.
   * This is the shape `MatchServer`'s own routing already uses since moving to
   * `Bun.serve()`.
   */
  handle = async (req: Request, url: string): Promise<Response | null> => {
    if (!url.startsWith('/arena-api/')) return null;
    const action = url.slice('/arena-api/'.length);

    if (action === 'state' && req.method === 'GET') {
      return this.json(200, { ok: true, state: this.state() });
    }

    if (action === 'play' && req.method === 'POST') {
      if (this.playing) {
        return this.json(409, { ok: false, reason: 'this arena is already playing' });
      }
      let request: PlayRequest;
      try {
        request = (await req.json()) as unknown as PlayRequest;
      } catch (err) {
        return this.json(400, { ok: false, reason: (err as Error).message });
      }
      // Cleared here rather than when the last result was collected: a new
      // match starting is the only moment at which the previous one stops
      // being the answer to "what happened".
      this.finished = null;
      this.error = null;
      this.playing = request;
      void this.run(request);
      return this.json(202, { ok: true });
    }

    return this.json(404, { ok: false, reason: 'no such arena action' });
  };

  state(): ArenaState {
    const match = this.server.currentMatch;
    const frame = this.playing && match ? match.snapshot() : null;
    return {
      playing: this.playing !== null,
      label: this.playing?.label ?? null,
      score: frame?.score ?? null,
      clock: frame?.clock ?? 0,
      half: frame?.half ?? 1,
      running: frame?.running ?? false,
      fidelity: this.server.realtimeFidelity,
      finished: this.finished,
      error: this.error,
    };
  }

  /** Stop whatever is running. The hub kills the whole process after this. */
  stop(): void {
    this.lineup?.stop();
    this.lineup = null;
  }

  /**
   * Play one leg, then hold the result until it is collected.
   *
   * The result is not written anywhere here. A fixture's result is written by
   * the hub, whole, once every leg has been played — the same all-or-nothing
   * write `tournament-store.ts` has always made, and what makes an interrupted
   * fixture leave nothing behind and simply replay.
   */
  private async run(request: PlayRequest): Promise<void> {
    const submissions: Record<string, string> = {};
    try {
      if (this.opts.pythonLibDir) {
        const resolved = await resolveLineup(this.server.submissionsDirectory, request.teams);
        if (Object.keys(resolved).length > 0) {
          this.lineup = await spawnLineup(
            this.server,
            resolved,
            {
              pythonLibDir: this.opts.pythonLibDir,
              cpuQuotaPercent: this.opts.seatCpuPercent,
              memoryLimitMb: this.opts.seatMemoryMb,
            },
            this.log,
          );
          for (const [id, entry] of Object.entries(resolved)) {
            if (entry) submissions[id] = await hashSubmission(entry.dir);
          }
        }
      }

      const result = await this.server.play({
        agents: { ...referenceTeam('violet'), ...referenceTeam('lime') } as never,
        transports: this.lineup?.transports,
        teams: request.teams,
        league: request.league,
        halfSeconds: request.halfSeconds,
        seed: request.seed,
        refereed: request.refereed ?? false,
      });

      this.finished = { result, submissions };
      this.log(`played ${request.label ?? 'a match'}: ${result.score.violet}-${result.score.lime}`);
    } catch (err) {
      // The hub is polling and has to be told, because a match that silently
      // never finishes is a fixture that never gets replayed either.
      this.error = (err as Error).message;
      this.log(`could not play ${request.label ?? 'a match'}: ${this.error}`);
    } finally {
      this.lineup?.stop();
      this.lineup = null;
      this.server.agents.closeAll();
      this.playing = null;
    }
  }

  private json(status: number, body: unknown): Response {
    return Response.json(body, { status });
  }
}
