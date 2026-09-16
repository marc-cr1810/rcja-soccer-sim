/**
 * Whose field it is.
 *
 * Phase 4 left practice fields open to whoever had the link, on purpose,
 * because the league had no accounts. Phase 6 built the accounts and Phase 7
 * built the room for several fields to exist at once. This is the ledger that
 * makes a field stop being anonymous: who owns one, who has been invited onto
 * it, how many a team may hold, and who is waiting when there are none left.
 *
 * **Two ledgers, kept apart.** This one is about *fields*; `occupancy.ts` is
 * about *robots*. Keeping them separate is what keeps invitations alive — a
 * guest spends no field allowance, so accepting an invitation never costs a
 * team their own right to open one, while their robots genuinely do occupy
 * seats and are counted there.
 *
 * **Not persisted, for the same reason arenas are not.** A field is an arena
 * and an arena dies with the hub, so who owned it dies with it too. A table
 * that outlived the thing it describes could only ever be wrong.
 *
 * **An invitation lands on a dashboard, not in a link.** A link that confers
 * access is a link that gets pasted into a group chat, and the whole point of
 * this phase is that a field has a guest list rather than a URL. Note that
 * `Invite` in `accounts.ts` is a different thing entirely — that is Phase 6's
 * *account* invitation, redeemed once to create a login, and it lives in the
 * database. This one is a `FieldInvitation` and never goes near it.
 *
 * **The queue holds a place, tells the team, and waits to be claimed.** It
 * does not hand the field over. Opening a field for a team that has gone home
 * starts an idle clock on an empty field and stalls everyone behind them for
 * the whole quiet period, which is the opposite of what a queue is for.
 */

export interface FieldInvitation {
  arenaId: string;
  /** The team that owns the field, so a dashboard can say whose it is. */
  from: string;
  /** The team invited onto it. */
  to: string;
  at: string;
}

/** A team's place in the queue, as their dashboard shows it. */
export interface QueuePlace {
  /** 1 is next. */
  position: number;
  /** How many teams are ahead of them. */
  ahead: number;
  /** Set while a field is being held for them, with when the hold lapses. */
  offer: { until: string } | null;
}

export interface TenancyOptions {
  /** Fields one team may own at once. 1 by default; 2 is the ceiling. */
  perTeam?: number;
  /** How long a field is held for the team at the front of the queue. */
  claimSeconds?: number;
  /** For tests, and for nothing else. */
  now?: () => number;
}

const DEFAULT_PER_TEAM = 1;
const DEFAULT_CLAIM_SECONDS = 90;

interface Field {
  arenaId: string;
  owner: string;
  /** Teams that have accepted an invitation. */
  guests: Set<string>;
  /** Teams invited and not yet answered. */
  invited: Set<string>;
}

interface Offer {
  slug: string;
  until: number;
}

export class Tenancy {
  private readonly fields = new Map<string, Field>();
  /** Teams waiting for a field, front first. */
  private queue: string[] = [];
  /** The one field being held, if one is. At most one at a time, by design. */
  private offer: Offer | null = null;
  private readonly now: () => number;

  constructor(private opts: TenancyOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Change the policy without restarting — the admin console's lever. */
  configure(opts: Partial<TenancyOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  private get perTeam(): number {
    return Math.min(2, Math.max(1, this.opts.perTeam ?? DEFAULT_PER_TEAM));
  }

  private get claimMs(): number {
    return (this.opts.claimSeconds ?? DEFAULT_CLAIM_SECONDS) * 1000;
  }

  // ------------------------------------------------------------------- fields

  /** Record that this arena belongs to this team. */
  own(arenaId: string, owner: string): void {
    this.fields.set(arenaId, { arenaId, owner, guests: new Set(), invited: new Set() });
  }

  /** Forget a field, because its arena has gone. Frees the owner's allowance. */
  forget(arenaId: string): void {
    this.fields.delete(arenaId);
  }

  ownerOf(arenaId: string): string | null {
    return this.fields.get(arenaId)?.owner ?? null;
  }

  guestsOf(arenaId: string): string[] {
    return [...(this.fields.get(arenaId)?.guests ?? [])];
  }

  invitedTo(arenaId: string): string[] {
    return [...(this.fields.get(arenaId)?.invited ?? [])];
  }

  fieldsOwnedBy(slug: string): string[] {
    return [...this.fields.values()].filter((f) => f.owner === slug).map((f) => f.arenaId);
  }

  /** Every field this team may be on: theirs, and the ones they are a guest of. */
  fieldsOpenTo(slug: string): string[] {
    return [...this.fields.values()]
      .filter((f) => f.owner === slug || f.guests.has(slug))
      .map((f) => f.arenaId);
  }

  /**
   * May this team be on this field at all — see the console, read its state?
   *
   * Watching the *match* is open to anybody, as it has been since Phase 4;
   * this is about the console that drags robots around and fills seats.
   */
  mayBeOnField(slug: string | null, arenaId: string): boolean {
    const field = this.fields.get(arenaId);
    if (!field || slug === null) return false;
    return field.owner === slug || field.guests.has(slug);
  }

  /** May this team run the field — drag, start, stop, re-stage, invite, close? */
  mayRunField(slug: string | null, arenaId: string): boolean {
    return slug !== null && this.fields.get(arenaId)?.owner === slug;
  }

  /**
   * Why this team may not open another field, or `null` if they may.
   *
   * Their *own* fields only: a guest spends no field allowance.
   */
  perTeamRefusal(slug: string): string | null {
    const held = this.fieldsOwnedBy(slug).length;
    if (held < this.perTeam) return null;
    return held === 1
      ? 'you already have a practice field open — close it before opening another'
      : `you already have ${held} practice fields open, which is all this server allows one team`;
  }

  // -------------------------------------------------------------- invitations

  /** Invite a team onto a field. Idempotent — inviting twice is not an error. */
  invite(arenaId: string, to: string): { ok: true } | { ok: false; reason: string } {
    const field = this.fields.get(arenaId);
    if (!field) return { ok: false, reason: 'that field is not open any more' };
    if (field.owner === to) return { ok: false, reason: 'that field is already yours' };
    if (field.guests.has(to)) return { ok: true };
    field.invited.add(to);
    return { ok: true };
  }

  /** Every invitation waiting for this team, for their dashboard. */
  invitationsFor(slug: string): FieldInvitation[] {
    return [...this.fields.values()]
      .filter((f) => f.invited.has(slug))
      .map((f) => ({ arenaId: f.arenaId, from: f.owner, to: slug, at: new Date(this.now()).toISOString() }));
  }

  accept(arenaId: string, slug: string): { ok: true } | { ok: false; reason: string } {
    const field = this.fields.get(arenaId);
    if (!field) return { ok: false, reason: 'that field is not open any more' };
    if (!field.invited.has(slug) && !field.guests.has(slug)) {
      return { ok: false, reason: 'you have not been invited onto that field' };
    }
    field.invited.delete(slug);
    field.guests.add(slug);
    return { ok: true };
  }

  decline(arenaId: string, slug: string): void {
    const field = this.fields.get(arenaId);
    if (!field) return;
    field.invited.delete(slug);
  }

  /** Take a guest off a field — they left, or their fixture called them away. */
  removeGuest(arenaId: string, slug: string): void {
    const field = this.fields.get(arenaId);
    if (!field) return;
    field.guests.delete(slug);
    field.invited.delete(slug);
  }

  // -------------------------------------------------------------------- queue

  /**
   * Slots that are spoken for but not yet running.
   *
   * A held field is a field nobody else may take, or the hold means nothing.
   */
  reserved(): number {
    this.settle();
    return this.offer ? 1 : 0;
  }

  /** Whether a standing hold belongs to this team. */
  offeredTo(slug: string): boolean {
    this.settle();
    return this.offer?.slug === slug;
  }

  /** Put a team in the queue, or tell them where they already are. */
  enqueue(slug: string): QueuePlace {
    this.settle();
    if (!this.queue.includes(slug)) this.queue.push(slug);
    return this.placeOf(slug)!;
  }

  /** Where this team is in the queue, or `null` if they are not in it. */
  placeOf(slug: string): QueuePlace | null {
    this.settle();
    const index = this.queue.indexOf(slug);
    if (index === -1) return null;
    return {
      position: index + 1,
      ahead: index,
      offer: this.offer?.slug === slug ? { until: new Date(this.offer.until).toISOString() } : null,
    };
  }

  /** The teams waiting, front first — for an admin who wants to see the line. */
  waiting(): string[] {
    this.settle();
    return [...this.queue];
  }

  leaveQueue(slug: string): void {
    this.settle();
    this.queue = this.queue.filter((one) => one !== slug);
    if (this.offer?.slug === slug) this.offer = null;
  }

  /**
   * A practice slot has come free.
   *
   * Offers it to the team at the front and holds it for them. If nobody is
   * waiting the slot is simply free, which is the common case and needs no
   * bookkeeping at all.
   */
  slotFreed(): { offeredTo: string; until: string } | null {
    this.settle();
    if (this.offer) return null;
    const next = this.queue[0];
    if (next === undefined) return null;
    this.offer = { slug: next, until: this.now() + this.claimMs };
    return { offeredTo: next, until: new Date(this.offer.until).toISOString() };
  }

  /**
   * This team is taking the field they were offered.
   *
   * Called after the arena has actually been created, so a failure to start
   * one does not consume anybody's turn.
   */
  claimed(slug: string): void {
    this.settle();
    if (this.offer?.slug === slug) this.offer = null;
    this.queue = this.queue.filter((one) => one !== slug);
  }

  /**
   * Expire a lapsed hold, and pass it on.
   *
   * A team that did not claim in their window drops out of the queue rather
   * than going to the back of it: they have gone home, and cycling them
   * forever means every team behind them waits a claim window each time round.
   * They can queue again, and will, the moment somebody presses the button.
   *
   * Lazy rather than on a timer, so the ledger has no clock of its own to keep
   * in step with anything — every read settles first, and the dashboard that
   * is polling is the thing that makes it happen.
   */
  private settle(): void {
    if (!this.offer) return;
    if (this.now() < this.offer.until) return;
    const lapsed = this.offer.slug;
    this.offer = null;
    this.queue = this.queue.filter((one) => one !== lapsed);
    const next = this.queue[0];
    if (next !== undefined) this.offer = { slug: next, until: this.now() + this.claimMs };
  }
}
