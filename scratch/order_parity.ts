/** Does the slot-order flip in match.ts actually reach control()? */
import { Match, PHYSICS_HZ, CONTROL_HZ } from '../src/match';
import { statue } from '../src/bots';

const m: any = new Match({
  agents: { 'cyan-1': statue, 'cyan-2': statue, 'yellow-1': statue, 'yellow-2': statue } as never,
  halfSeconds: 1,
  idealSensors: true,
});

const proto: any = Object.getPrototypeOf(m);
const realControl = proto.control;
const seen: { flipped: boolean; first: string }[] = [];
proto.control = function (dt: number) {
  seen.push({ flipped: this.slotOrderFlipped, first: this.orderedSlots()[0].id });
  return realControl.call(this, dt);
};

m.world.running = true;
for (let i = 0; i < 20; i++) m.step(1 / PHYSICS_HZ);

console.log(`PHYSICS_HZ=${PHYSICS_HZ} CONTROL_HZ=${CONTROL_HZ} perControl=${PHYSICS_HZ / CONTROL_HZ}`);
console.log(`control() ran ${seen.length} times in 20 physics steps`);
console.log('slotOrderFlipped at each control tick:', seen.map((s) => (s.flipped ? 'T' : 'F')).join(''));
console.log('first slot polled each control tick:  ', seen.map((s) => s.first).join(' '));
const firsts = new Set(seen.map((s) => s.first));
console.log(firsts.size === 1 ? `\n>>> ALWAYS ${[...firsts][0]} FIRST — the flip never reaches control()` : '\n>>> order alternates');
