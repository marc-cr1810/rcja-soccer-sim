import { Match, type MatchAgents } from '../src/match';
import { championTeam } from '../src/champion';

async function main() {
  const agents: MatchAgents = {
    ...championTeam('violet'),
    ...championTeam('lime'),
  } as unknown as MatchAgents;

  let buffer: string[] = [];
  let goalsSeen = 0;

  const m = new Match({
    agents,
    halfSeconds: 45,
    seed: 1,
    idealSensors: true,
    observe: (match) => {
      const w = (match as any).world;
      const b = w.ball;
      const r1 = w.robots.find((r: any) => r.id === 'violet-1');
      const r2 = w.robots.find((r: any) => r.id === 'lime-1');
      const g1 = w.robots.find((r: any) => r.id === 'violet-2');
      const g2 = w.robots.find((r: any) => r.id === 'lime-2');

      const line = `t=${w.clock.toFixed(2)} | Ball=(${b.x.toFixed(0)},${b.z.toFixed(0)}) v=(${b.vx.toFixed(0)},${b.vz.toFixed(0)}) | V1=(${r1.x.toFixed(0)},${r1.z.toFixed(0)}) | L1=(${r2.x.toFixed(0)},${r2.z.toFixed(0)}) | G_V=(${g1.x.toFixed(0)},${g1.z.toFixed(0)}) | G_L=(${g2.x.toFixed(0)},${g2.z.toFixed(0)})`;
      buffer.push(line);
      if (buffer.length > 30) buffer.shift();

      if (match.goals.length > goalsSeen) {
        goalsSeen = match.goals.length;
        const g = match.goals[match.goals.length - 1];
        console.log(`\n=== GOAL at t=${g.at.toFixed(2)}s Team=${g.team} Half=${g.half} ===`);
        console.log(buffer.slice(-15).join('\n'));
      }
    },
  });

  m.run();
}

main().catch(console.error);
