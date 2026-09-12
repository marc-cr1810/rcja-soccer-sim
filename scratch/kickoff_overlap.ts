/**
 * Do any robots start a kick-off inside each other?
 *
 * resetRobots places the goalie at HALF_LENGTH - PENALTY_DEPTH/2 and the
 * non-kicking striker at HALF_LENGTH - PENALTY_DEPTH - 45. Two robots of
 * ROBOT_RADIUS each need 2*ROBOT_RADIUS between their centres; if the gap is
 * less, the separation pass shoves them apart on the first step - so the
 * restart is not the position the referee set, and it is only the NON-KICKING
 * team that gets shoved.
 */
import { World } from '../src/world';
import { getLeague } from '../src/leagues';
const ROBOT_RADIUS = 110;


for (const half of [1, 2] as const) {
  for (const kicking of ['cyan', 'yellow'] as const) {
    const w = new World({
      league: getLeague('open'),
      halfLengthSeconds: 600,
      inclined: false,
      commsEnabled: true,
    });
    w.half = half;
    w.kickOff(kicking);
    const placed = w.robots.map((r) => ({ id: r.id, x: r.x, z: r.z }));

    // Closest pair as placed.
    let worst = { a: '', b: '', gap: Infinity };
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const gap = Math.hypot(placed[i]!.x - placed[j]!.x, placed[i]!.z - placed[j]!.z);
        if (gap < worst.gap) worst = { a: placed[i]!.id, b: placed[j]!.id, gap };
      }
    }

    w.running = true;
    w.step(0.01);

    const moved = w.robots
      .map((r) => {
        const was = placed.find((p) => p.id === r.id)!;
        return { id: r.id, from: was.x, to: r.x, d: r.x - was.x };
      })
      .filter((m) => Math.abs(m.d) > 1e-9);

    console.log(
      `half ${half}, ${kicking} kicks off: closest pair ${worst.a}/${worst.b} at ${worst.gap.toFixed(1)}mm ` +
        `(need ${2 * ROBOT_RADIUS})${worst.gap < 2 * ROBOT_RADIUS ? '  <-- OVERLAPPING' : ''}`,
    );
    for (const m of moved) {
      console.log(`    ${m.id.padEnd(9)} shoved ${m.from.toFixed(1)} -> ${m.to.toFixed(1)}  (${m.d >= 0 ? '+' : ''}${m.d.toFixed(1)}mm)`);
    }
    if (moved.length === 0) console.log('    nothing shoved');
  }
}
