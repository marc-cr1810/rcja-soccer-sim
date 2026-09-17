import { Match, type MatchAgents } from '../src/match';
import { championTeam } from '../src/champion';

async function main() {
  console.log('Testing Champion vs Champion across 10 seeds (45s halves)...');
  let h1CyanAttacking = 0; // In H1, Violet defends Cyan (-x) and attacks Yellow (+x)
  let h1YellowAttacking = 0; // In H1, Lime defends Yellow (+x) and attacks Cyan (-x)
  let h2CyanAttacking = 0; // In H2, Lime defends Cyan (-x) and attacks Yellow (+x)
  let h2YellowAttacking = 0; // In H2, Violet defends Yellow (+x) and attacks Cyan (-x)

  let totalViolet = 0;
  let totalLime = 0;

  for (let seed = 1; seed <= 20; seed++) {
    const agents: MatchAgents = {
      ...championTeam('violet'),
      ...championTeam('lime'),
    } as unknown as MatchAgents;

    const m = new Match({
      agents,
      halfSeconds: 45,
      seed,
    });
    // Let's see if we can see what kicking off does

    const res = m.run();
    totalViolet += res.score.violet;
    totalLime += res.score.lime;

    for (const g of res.goals) {
      const attDir = g.half === 1 ? (g.team === 'violet' ? '+x' : '-x') : (g.team === 'lime' ? '+x' : '-x');
      console.log(`  [Goal] t=${g.at.toFixed(1)}s H${g.half} Team=${g.team} Attacking=${attDir} Scorer=${g.robotId}`);
    }

    const vH1 = res.goals.filter((g) => g.team === 'violet' && g.half === 1).length;
    const lH1 = res.goals.filter((g) => g.team === 'lime' && g.half === 1).length;
    const vH2 = res.goals.filter((g) => g.team === 'violet' && g.half === 2).length;
    const lH2 = res.goals.filter((g) => g.team === 'lime' && g.half === 2).length;

    h1CyanAttacking += vH1;
    h1YellowAttacking += lH1;
    h2CyanAttacking += lH2;
    h2YellowAttacking += vH2;

    console.log(
      `Seed ${seed}: Violet ${res.score.violet} - ${res.score.lime} Lime | H1: V ${vH1} - ${lH1} L | H2: V ${vH2} - ${lH2} L`
    );
  }

  console.log('--- RESULTS ---');
  console.log(`Total Violet: ${totalViolet}, Total Lime: ${totalLime}`);
  console.log(`H1 (Violet +x vs Lime -x): Violet ${h1CyanAttacking} - ${h1YellowAttacking} Lime`);
  console.log(`H2 (Lime +x vs Violet -x): Lime ${h2CyanAttacking} - ${h2YellowAttacking} Violet`);
  console.log(`Team attacking +x (yellow goal): ${h1CyanAttacking + h2CyanAttacking}`);
  console.log(`Team attacking -x (cyan goal):   ${h1YellowAttacking + h2YellowAttacking}`);
}

main().catch(console.error);
