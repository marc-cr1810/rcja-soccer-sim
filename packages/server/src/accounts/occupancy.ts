/**
 * One robot, one place.
 *
 * > Each of a team's robots may be in exactly one seat, anywhere on this
 * > server, at any moment.
 *
 * Nothing technical forces this. Four arenas can read the same submission
 * folder quite happily — it is read-only and they would all work. It is a rule
 * because the sport has one: a team has two robots, and two robots cannot be
 * on two fields. The simulation's job is to be the same sport, which is the
 * argument that rejected Pyodide in Phase 5 and that keeps one seat grant for
 * practice and finals alike.
 *
 * Three things fall out of it, and they are why it is worth enforcing:
 *
 * - **"What is my robot doing right now" gets one answer.** One robot, one
 *   seat, one place to look. A team debugging a robot that exists in three
 *   places at once cannot be helped by anybody.
 * - **The fixture conflict disappears without a second rule.** During their
 *   match both robots are seated by the hub, so a team has nothing left to
 *   rehearse with.
 * - **`practice.perTeam`'s ceiling of 2 stops being arbitrary.** A team
 *   reaches two fields only by splitting robot 1 onto one and robot 2 onto
 *   another. Three is not discouraged, it is unreachable.
 *
 * **This is a different ledger from `tenancy.ts`, deliberately.** Ownership is
 * about fields and occupancy is about robots, and keeping them apart is what
 * keeps invitations alive: a guest spends no *field* allowance, so accepting
 * an invitation never costs a team their own right to open one — but they do
 * spend their own *robot* occupancy, because their robots really are in seats.
 *
 * **It lives in the hub and nowhere else.** A child arena can only ever see
 * its own world, and this rule is server-wide; leaving the check to the
 * children would mean every field looking correct on its own while a robot
 * played in two places. Getting that wrong is silent, which is why it is worth
 * the whole file.
 *
 * **Nothing here is persisted.** Arenas die with the hub, so occupancy dies
 * with it too, and the two can never disagree about what is running.
 */

/** A team's robot, as one string: the team's slug and which of its two. */
export type RobotKey = string;

/** Which of a team's two robots. A seat id says which; a fill never does. */
export type RobotNumber = 1 | 2;

export function robotKey(slug: string, number: RobotNumber): RobotKey {
  return `${slug}:${number}`;
}

/** The robot number a seat holds. `violet-2` is somebody's robot 2. */
export function numberOfSeat(seatId: string): RobotNumber {
  return seatId.endsWith('-2') ? 2 : 1;
}

/** Where one robot is, right now. */
export interface Placement {
  slug: string;
  number: RobotNumber;
  arenaId: string;
  seatId: string;
  since: string;
}

/**
 * A refusal that can be read out loud.
 *
 * The test END-STATE.md sets for this rule is a legible sentence — *robot 1 is
 * on your own field; take it off to join NSW Lightning's* — so a refusal
 * carries the placement rather than a boolean, and the caller phrases it with
 * whatever it knows about the two fields involved.
 */
export type ClaimResult = { ok: true } | { ok: false; held: Placement };

export class Occupancy {
  /** Robot → where it is. The invariant, held as a map that cannot break it. */
  private readonly byRobot = new Map<RobotKey, Placement>();
  /** Seat → the robot in it, so releasing a seat needs no search. */
  private readonly bySeat = new Map<string, RobotKey>();

  /** Where this robot is, or `null` if it is not in a seat anywhere. */
  where(slug: string, number: RobotNumber): Placement | null {
    return this.byRobot.get(robotKey(slug, number)) ?? null;
  }

  /** Both of a team's robots, in order, for a dashboard that shows both rows. */
  forTeam(slug: string): { number: RobotNumber; at: Placement | null }[] {
    return [1 as const, 2 as const].map((number) => ({ number, at: this.where(slug, number) }));
  }

  /** Everything seated, for the `arenas` listing and the admin console. */
  all(): Placement[] {
    return [...this.byRobot.values()];
  }

  /** The robot in this seat, if one is. */
  inSeat(arenaId: string, seatId: string): Placement | null {
    const key = this.bySeat.get(seatKey(arenaId, seatId));
    return key ? (this.byRobot.get(key) ?? null) : null;
  }

  /**
   * Put a robot in a seat.
   *
   * Re-claiming the seat a robot is already in succeeds and changes nothing:
   * a team pressing Restart, or setting the same seat twice, is not a rule
   * violation and should not read like one.
   */
  claim(slug: string, number: RobotNumber, arenaId: string, seatId: string): ClaimResult {
    const key = robotKey(slug, number);
    const held = this.byRobot.get(key);
    if (held) {
      if (held.arenaId === arenaId && held.seatId === seatId) return { ok: true };
      return { ok: false, held };
    }
    // Whatever was in this seat is leaving it: a seat holds one robot, and the
    // caller has already decided this one may have it.
    this.release(arenaId, seatId);
    const placement: Placement = {
      slug,
      number,
      arenaId,
      seatId,
      since: new Date().toISOString(),
    };
    this.byRobot.set(key, placement);
    this.bySeat.set(seatKey(arenaId, seatId), key);
    return { ok: true };
  }

  /** Empty one seat. Returns what was in it, for a caller that has to say so. */
  release(arenaId: string, seatId: string): Placement | null {
    const at = seatKey(arenaId, seatId);
    const key = this.bySeat.get(at);
    if (!key) return null;
    const placement = this.byRobot.get(key) ?? null;
    this.bySeat.delete(at);
    this.byRobot.delete(key);
    return placement;
  }

  /**
   * Empty every seat in one arena.
   *
   * Called when an arena closes for any reason — swept as idle, stopped from
   * the admin console, pre-empted by a fixture, or simply gone. An arena that
   * has died still holding robots would deadlock the teams whose robots those
   * are, so this is wired to the supervisor's own notion of an arena ending
   * rather than to any of the ways of asking it to end.
   */
  releaseArena(arenaId: string): Placement[] {
    const freed: Placement[] = [];
    for (const placement of [...this.byRobot.values()]) {
      if (placement.arenaId !== arenaId) continue;
      this.byRobot.delete(robotKey(placement.slug, placement.number));
      this.bySeat.delete(seatKey(placement.arenaId, placement.seatId));
      freed.push(placement);
    }
    return freed;
  }

  /**
   * Take both of a team's robots back, wherever they are.
   *
   * A fixture pre-empts practice: without an explicit winner the invariant
   * deadlocks at the worst moment of the day, when a team whose robot is still
   * held by an abandoned field cannot be seated in their own match.
   */
  releaseTeam(slug: string): Placement[] {
    const freed: Placement[] = [];
    for (const number of [1, 2] as const) {
      const placement = this.byRobot.get(robotKey(slug, number));
      if (!placement) continue;
      this.byRobot.delete(robotKey(slug, number));
      this.bySeat.delete(seatKey(placement.arenaId, placement.seatId));
      freed.push(placement);
    }
    return freed;
  }
}

function seatKey(arenaId: string, seatId: string): string {
  return `${arenaId}/${seatId}`;
}
