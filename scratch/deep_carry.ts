/** What happens when the swapped keeper carries deep into the attacking box. */
import { Match } from '../packages/server/src/match/match';
// eslint-disable-next-line import/no-relative-packages
import { championTeam as workChampion } from '../packages/server/src/champion/index';
// eslint-disable-next-line import/no-relative-packages
import { championTeam as pinChampion } from './.wt-champion-ab6ce00/packages/server/src/champion/index';
import { distance } from '../packages/server/src/sim/physics';

const GOAL_LINE = 915;
const BOX_LINE = GOAL_LINE - 0.55 * 915; // deep marker used by swap_probe (~412)
const SEEDS = process.argv[2] ? process.argv[2].split('-').map(Number) : [1, 40];

interface Row {
  match: number;
  deepX: number;
  end: 'shot' | 'lost' | 'quiet' | 'goal' | 'conceded';
  fired: boolean;
  keeperAtDeep: number;
  limeKeeperXAtDeep: number;
  heldAtDeep: boolean;
  maxIntents: string;
  spellSec: number;
}
const rows: Row[] = [];

for (let seed = SEEDS[0]; seed <= SEEDS[1]; seed++) {
  const w = workChampion('violet');
  const p = pinChampion('lime');
  const agents = {
    'violet-1': w['violet-1']!,
    'violet-2': w['violet-2']!,
    'lime-1': p['lime-1']!,
    'lime-2': p['lime-2']!,
  };
  const KEEPER = 'violet-2';
  const HOME = -465;

  let spell: { start: number; maxX: number; fired: boolean; shotTick: number | null; intents: Record<string, number> } | null = null;
  let launched = 0;
  let seen = 0;
  let finalized = false;

  const m = new Match({
    agents,
    halfSeconds: 120,
    seed,
    observe: () => {
      const world = m.world;
      if (world.events.length !== seen) {
        const fresh = world.events.slice(seen);
        seen = world.events.length;
        for (const e of fresh) {
          if (spell && e.kind === 'goal' && e.team === 'violet' && pendingKick) {
            rows.push(finalize('goal'));
          }
          if (spell && e.kind === 'goal' && e.team === 'lime' && pendingKick) {
            rows.push(finalize('conceded'));
          }
        }
      }
    },
  });
  // placeholder to keep TS quiet about unused vars
  void launched;
}
