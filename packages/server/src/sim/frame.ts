/**
 * The field, turned to face the way this robot is playing.
 *
 * A robot builds its own coordinates. Nothing tells it where it is, so it works
 * that out from the walls and the goals — and the frame it lands in is the one
 * the compass hands it, whose zero faces the yellow goal and does not move.
 * Which end this team is attacking DOES move: rule 1.4/5.4 swaps it at
 * half-time. So a rule written in the compass's frame is only half a rule. Its
 * other half is a sign, written out by hand at every site that reads an `x` or
 * a `z`, and that sign has to be right every single time or the two ends of the
 * field stop being the same game.
 *
 * They were not the same game. This file exists because of one site out of
 * forty-eight in the agent that shipped with it, where a lateral dodge took its
 * side from `meZ > 0 ? -1 : 1` with no attack direction on it. Attacking the
 * yellow goal it dodged infield; attacking the cyan goal it dodged into the
 * wall. Champion against Champion that was 82 goals into one net and 33 into
 * the other, and every test in the suite passed.
 *
 * The fix is not a better sign. It is not needing one:
 *
 *     x -> x * direction,   z -> z * direction,   heading -> heading - upAngle
 *
 * Origin at the centre spot, `+x` towards the goal being attacked. Same
 * millimetres, same constants — `HALF_LENGTH` is still the goal line, and the
 * goal this robot is shooting at is always the one at `+HALF_LENGTH`. What is
 * gone is the ability to tell the two ends apart from inside a rule, and with
 * it the ability to get them different. `if (bz > 60)` picks the same physical
 * side of the field in both halves because there is no longer a direction to
 * multiply by, and so none to forget.
 *
 * This is the same idea as `GoalFrame` in the Python library
 * (`python/rcja_soccer/frame.py`), and deliberately the same coordinate
 * convention, so that a team reading one and writing the other is reading about
 * their own robot. The two differ in how they learn the direction and only in
 * that: Python derives it from the two goal sightings at a kick-off, which is
 * what a robot with no referee link has to do. In here `attackDirection` is on
 * the frame already (rule 1.4/5.4, and the referee does say), so it is taken
 * from there and believed.
 *
 * A note on which transform this is. `lateral` is `up` turned a quarter turn to
 * the left, which makes it a ROTATION and not a mirror, and that is load-
 * bearing rather than pedantic: the open drivetrain is chiral — four tangential
 * wheels all driving the same way round — so a frame that flipped handedness
 * would swap a robot's own left for its right and every steering correction
 * with it. `tests/symmetry.test.ts` opens with the same argument.
 */

import { wrapAngle } from './drive';
import type { Blob, SensorFrame, Sighting } from '../match/protocol';

/** The two goal sightings, named by what they are to this robot rather than by paint. */
export interface FramedGoals {
  attacking: Sighting | null;
  defending: Sighting | null;
}

/** The two goals as raw colour blobs, named the same way. */
export interface FramedBlobs {
  attacking: Blob[];
  defending: Blob[];
}

export class GoalFrame {
  /**
   * +1 when the attacking goal is the yellow one, and the frame is the field
   * frame unchanged; -1 when it is the cyan one, and the frame is the field
   * turned over.
   */
  private direction: 1 | -1 = 1;

  /** Take the direction from the frame. Cheap, so it can be called every tick. */
  update(frame: SensorFrame): void {
    this.direction = frame.attackDirection;
  }

  reset(): void {
    this.direction = 1;
  }

  /** Field heading that points up the field, towards the goal being attacked. */
  upAngle(): number {
    return this.direction > 0 ? 0 : Math.PI;
  }

  /** The camera's name for the goal this robot is attacking. */
  get attackingColour(): 'cyan' | 'yellow' {
    return this.direction > 0 ? 'yellow' : 'cyan';
  }

  /** The camera's name for the goal this robot is defending. */
  get defendingColour(): 'cyan' | 'yellow' {
    return this.direction > 0 ? 'cyan' : 'yellow';
  }

  /**
   * A field point in attack-relative coordinates.
   *
   * The rotation is by 0 or pi about the centre spot, so it comes out as a
   * sign on both axes. Writing it as a matrix would be honest about the
   * general case and would hide that this particular one is exact: no
   * trigonometry runs, so a point and its 180-degree rotation land on
   * bit-identical coordinates rather than on coordinates that agree to
   * fifteen places. The symmetry test asserts equality, and can.
   */
  toFrame(x: number, z: number): [number, number] {
    return [x * this.direction, z * this.direction];
  }

  /** Back to field coordinates, for anything that still speaks them. */
  fromFrame(forward: number, lateral: number): [number, number] {
    return [forward * this.direction, lateral * this.direction];
  }

  /**
   * A velocity in attack-relative coordinates.
   *
   * Same rotation, no translation — a velocity has no origin to move. Kept
   * separate from `toFrame` so that a caller has to have decided which it
   * holds; the two happen to agree here, and would not under a frame whose
   * origin was anywhere but the centre spot.
   */
  toFrameVelocity(vx: number, vz: number): [number, number] {
    return [vx * this.direction, vz * this.direction];
  }

  /**
   * A compass heading, relative to the goal being attacked.
   *
   * Facing that goal reads 0 in BOTH halves, which puts the ±pi branch cut
   * behind the robot rather than under it. Nothing in the agent needs that —
   * every angle it compares goes through `wrapAngle`, which does not care
   * where the cut falls — but a program that filters, averages or integrates a
   * heading of its own does, and this is the reading to do it to.
   *
   * The robot-frame bearing a motor mixer wants is unaffected either way:
   * `travel` and `heading` shift by the same amount, so their difference does
   * not move. That is what lets the agent work in frame coordinates
   * throughout and still hand `mixOmni` exactly what it handed it before.
   */
  heading(heading: number): number {
    return wrapAngle(heading - this.upAngle());
  }

  /** An angle in the field frame, from one in this one. */
  fieldHeading(heading: number): number {
    return wrapAngle(heading + this.upAngle());
  }

  /**
   * The camera's two goal sightings, named by what they are to this robot.
   *
   * The camera reports goals by paint, because paint is what a colour blob
   * detector can tell you, and the paint does not move at half-time while
   * which goal this team is shooting at does. Asking for them this way is the
   * other half of not tracking the swap: with `toFrame` for the geometry and
   * this for the camera, nothing the agent reads is still keyed to an end of
   * the field.
   */
  goals(frame: SensorFrame): FramedGoals {
    const goals = frame.camera?.goals;
    if (!goals) return { attacking: null, defending: null };
    return {
      attacking: goals[this.attackingColour] ?? null,
      defending: goals[this.defendingColour] ?? null,
    };
  }

  /** The same two goals as raw colour blobs, named the same way. */
  blobs(frame: SensorFrame): FramedBlobs {
    const blobs = frame.camera?.goalBlobs;
    if (!blobs) return { attacking: [], defending: [] };
    return {
      attacking: blobs[this.attackingColour] ?? [],
      defending: blobs[this.defendingColour] ?? [],
    };
  }
}
