import { Match, type MatchAgents } from '../src/match';
import { championTeam } from '../src/champion';

async function main() {
  const agents: MatchAgents = {
    ...championTeam('violet'),
    ...championTeam('lime'),
  } as unknown as MatchAgents;

  const m = new Match({
    agents,
    halfSeconds: 45,
    seed: 1,
    idealSensors: true,
    observe: (match) => {
      const w = (match as any).world;
      if (w.clock < 10.0) {
        const b = w.ball;
        const v1 = w.robots.find((r: any) => r.id === 'violet-1');
        const l1 = w.robots.find((r: any) => r.id === 'lime-1');
        console.log(
          `t=${w.clock.toFixed(2)} | Ball=(${b.x.toFixed(0)},${b.z.toFixed(0)}) | ` +
          `V1=(${v1.x.toFixed(0)},${v1.z.toFixed(0)}) h=${(v1.heading*180/Math.PI).toFixed(0)}° | ` +
          `L1=(${l1.x.toFixed(0)},${l1.z.toFixed(0)}) h=${(l1.heading*180/Math.PI).toFixed(0)}°`
        );
      }
    },
  });

  m.run();
}

main().catch(console.error);
