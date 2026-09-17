import { Match, type MatchAgents } from '../src/match';
import { referenceTeam } from '../src/reference';

async function main() {
  console.log('Testing Reference vs Reference across 10 seeds (45s halves)...');
  let attPlusXGoals = 0;
  let attMinusXGoals = 0;

  for (let seed = 1; seed <= 10; seed++) {
    const agents: MatchAgents = {
      ...referenceTeam('violet'),
      ...referenceTeam('lime'),
    } as unknown as MatchAgents;

    const m = new Match({
      agents,
      halfSeconds: 45,
      seed,
      idealSensors: true,
    });

    const res = m.run();
    const vH1 = res.goals.filter((g) => g.team === 'violet' && g.half === 1).length;
    const lH1 = res.goals.filter((g) => g.team === 'lime' && g.half === 1).length;
    const vH2 = res.goals.filter((g) => g.team === 'violet' && g.half === 2).length;
    const lH2 = res.goals.filter((g) => g.team === 'lime' && g.half === 2).length;

    attPlusXGoals += vH1 + lH2;
    attMinusXGoals += lH1 + vH2;
  }

  console.log('--- REFERENCE RESULTS ---');
  console.log(`Goals by team attacking +x: ${attPlusXGoals}`);
  console.log(`Goals by team attacking -x: ${attMinusXGoals}`);
}

main().catch(console.error);
