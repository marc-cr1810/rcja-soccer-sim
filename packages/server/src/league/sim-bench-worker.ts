/**
 * Worker thread for headless simulation benchmarking.
 *
 * Runs a complete headless Match with reference agents on all seats
 * to measure pure simulation engine and AI throughput on a single CPU core.
 */

import { Match } from '../match/match';
import { agentsFor } from '../infra/reference';
import type { LeagueId } from '@rcja/shared/leagues';

declare var self: Worker;

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (!msg || msg.type !== 'run') return;

  const { seconds = 10, league = 'open', seed = 1, idealSensors = true } = msg;

  const match = new Match({
    agents: agentsFor(undefined),
    teams: { violet: 'Violet', lime: 'Lime' },
    halfSeconds: seconds,
    seed,
    idealSensors,
    league: league as LeagueId,
    autoResolve: true,
  });

  const t0 = performance.now();
  const result = match.run();
  const elapsedMs = performance.now() - t0;

  self.postMessage({
    ok: true,
    ticks: result.clock * 100,
    clock: result.clock,
    elapsedMs,
  });
};
