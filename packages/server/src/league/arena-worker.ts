/**
 * Headless arena worker running in a Bun.Worker thread.
 *
 * Runs MatchServer and FixtureArena, DemoArena, or PracticeSession in a dedicated
 * worker thread, cutting per-arena memory footprint from ~103 MB down to ~15 MB.
 */

import { MatchServer } from '../infra/server';
import { FixtureArena, DemoArena } from './arena';
import { PracticeSession } from './practice';
import { resolve } from 'node:path';

declare var self: Worker;

let server: MatchServer | null = null;
let fixture: FixtureArena | null = null;
let demoArena: DemoArena | null = null;
let practice: PracticeSession | null = null;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'start') {
    const {
      id,
      kind,
      port,
      refereeToken,
      scratch,
      submissionsDir,
      workspacesDir,
      fieldStatePath,
      seatCpuPercent,
      seatMemoryMb,
      demo,
      pythonLibDir,
    } = msg;

    server = new MatchServer({
      port,
      host: '127.0.0.1',
      refereeToken,
      realtime: true,
      pythonLibDir: pythonLibDir ? resolve(pythonLibDir) : undefined,
      scratchDir: scratch ? resolve(scratch) : undefined,
      submissionsDir: submissionsDir ? resolve(submissionsDir) : undefined,
      control: (req, url) => {
        if (fixture) return fixture.handle(req, url);
        if (demoArena) return demoArena.handle(req, url);
        return null;
      },
    });

    if (kind === 'fixture') {
      fixture = new FixtureArena(server, {
        pythonLibDir: pythonLibDir ? resolve(pythonLibDir) : null,
        runRoot: scratch ? resolve(scratch) : null,
        seatCpuPercent,
        seatMemoryMb,
        log: (line) => self.postMessage({ type: 'log', id, line }),
      });
    } else if (kind === 'demo') {
      if (!demo) throw new Error('Demo settings required for demo arena');
      demoArena = new DemoArena(server, {
        teams: { violet: demo.home, lime: demo.away },
        bots: demo.bots,
        homeBots: demo.homeBots,
        awayBots: demo.awayBots,
        halfSeconds: demo.halfSeconds,
        league: demo.league,
        gapSeconds: demo.gapSeconds,
        randomSides: demo.randomSides,
        log: (line) => self.postMessage({ type: 'log', id, line }),
      });
    } else if (kind === 'practice') {
      practice = new PracticeSession(server, {
        submissionsDir: server.submissionsDirectory,
        workspacesDir: workspacesDir ? resolve(workspacesDir) : null,
        fieldStatePath: fieldStatePath ? resolve(fieldStatePath) : null,
        runRoot: scratch ? resolve(scratch) : null,
        pythonLibDir: null,
        seatCpuPercent,
        seatMemoryMb,
        log: (line) => self.postMessage({ type: 'log', id, line }),
      });
    }

    await server.listen();
    if (kind === 'demo' && demoArena) {
      demoArena.start(port);
    } else if (kind === 'practice' && practice) {
      server.practise(practice).catch(() => {});
    }

    self.postMessage({ type: 'ready', id, port });
    return;
  }

  if (msg.type === 'stop') {
    try {
      fixture?.stop();
      demoArena?.stop();
      practice?.close();
      await server?.close();
    } catch {}
    self.postMessage({ type: 'stopped' });
    process.exit(0);
  }
};
