import { Match, type MatchAgents } from '../src/match';
import { championTeam } from '../src/champion';

async function main() {
  console.log('Testing reverse opening kick-off: Team attacking -x kicks off first in both halves...');
  let attPlusXGoals = 0;
  let attMinusXGoals = 0;

  for (let seed = 1; seed <= 10; seed++) {
    const agents: MatchAgents = {
      ...championTeam('violet'),
      ...championTeam('lime'),
    } as unknown as MatchAgents;

    // We subclass or manually step Match to control kickoff
    const m = new Match({
      agents,
      halfSeconds: 45,
      seed,
      idealSensors: true,
    });

    // Run half 1 with LIME kicking off (Lime attacks -x in H1)
    (m as any).world.half = 1;
    (m as any).world.kickOff('lime'); // Lime attacks -x!
    (m as any).resetAgents();
    (m as any).world.running = true;
    const until1 = (m as any).world.clock + 45;
    while ((m as any).world.clock < until1) (m as any).step(1 / 50);
    (m as any).world.running = false;

    // Run half 2 with VIOLET kicking off (Violet attacks -x in H2)
    (m as any).world.half = 2;
    (m as any).world.kickOff('violet'); // Violet attacks -x!
    (m as any).resetAgents();
    (m as any).world.running = true;
    const until2 = (m as any).world.clock + 45;
    while ((m as any).world.clock < until2) (m as any).step(1 / 50);
    (m as any).world.running = false;

    const res = (m as any).result();
    const vH1 = res.goals.filter((g: any) => g.team === 'violet' && g.half === 1).length;
    const lH1 = res.goals.filter((g: any) => g.team === 'lime' && g.half === 1).length;
    const vH2 = res.goals.filter((g: any) => g.team === 'violet' && g.half === 2).length;
    const lH2 = res.goals.filter((g: any) => g.team === 'lime' && g.half === 2).length;

    // In H1: Violet is +x, Lime is -x
    // In H2: Lime is +x, Violet is -x
    attPlusXGoals += vH1 + lH2;
    attMinusXGoals += lH1 + vH2;

    console.log(`Seed ${seed}: H1 (-x Lime kick): +x ${vH1} - ${lH1} -x | H2 (-x Violet kick): +x ${lH2} - ${vH2} -x`);
  }

  console.log('--- RESULTS ---');
  console.log(`Goals by team attacking +x: ${attPlusXGoals}`);
  console.log(`Goals by team attacking -x (which kicked off): ${attMinusXGoals}`);
}

main().catch(console.error);
