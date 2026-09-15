/**
 * Who everybody is.
 *
 * Accounts are the first genuinely mutable state this codebase has had.
 * Everything before them is files written once — a draw, a fixture result, a
 * submission, a workspace folder — and the absence of a state file is
 * load-bearing in three separate phases: a tournament resumes because the next
 * fixture is the first without a result, not because something remembered
 * where it was.
 *
 * So the rule here is a line, not a preference:
 *
 * > **The database holds who. The disk holds what happened.**
 *
 * `league.db` holds accounts, sessions, API keys, invites, per-account grants
 * and the audit log. It holds nothing about a match. Delete it and a venue has
 * lost its logins — not a season, not a table, not a team's code, and an
 * organiser can still open a robot in a text editor at eleven at night.
 *
 * SQLite costs no dependency: `bun:sqlite` is built into Bun, with no
 * experimental warning to quieten and nothing to install.
 */

import { Database } from 'bun:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { fail, ok, slugifyTeam, type Result } from './manifest';
import type { Actor, Capability, Grant, Role, Scope } from './capabilities';
import { isRole } from './capabilities';

/** A team account is an organisation; a referee or admin account is a person. */
export type AccountKind = 'team' | 'person';

export interface Account {
  id: string;
  kind: AccountKind;
  role: Role;
  /** Lowercased, dash-separated. A team's slug is also its folder on disk. */
  slug: string;
  displayName: string;
  email: string | null;
  createdAt: string;
  disabledAt: string | null;
}

export interface Invite {
  code: string;
  role: Role;
  /** The team an accepted invite becomes, for a team invite. */
  team: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface ApiKeyInfo {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface AuditRow {
  at: string;
  actorId: string | null;
  actorName: string | null;
  capability: string;
  target: string | null;
  detail: string | null;
}

/** How long a login lasts without being used again. A competition is a day. */
const SESSION_DAYS = 30;
/** How long an organiser's invite code stays good for. */
const INVITE_DAYS = 14;

/**
 * scrypt's work factor.
 *
 * Node's default (16384) with a 16-byte salt and a 64-byte key. Deliberately
 * not tuned upwards: this runs on whatever machine a venue brought, and a
 * login that takes a second on a school laptop is a support call.
 */
const SCRYPT_COST = 16384;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  role          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  email         TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  hash       TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  hash       TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  capability TEXT NOT NULL,
  scope      TEXT NOT NULL,
  target     TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  team       TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  at         TEXT NOT NULL,
  actor_id   TEXT,
  capability TEXT NOT NULL,
  target     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE INDEX IF NOT EXISTS grants_account ON grants(account_id);
CREATE INDEX IF NOT EXISTS keys_account ON api_keys(account_id);
`;

interface AccountRow {
  id: string;
  kind: string;
  role: string;
  slug: string;
  display_name: string;
  email: string | null;
  password_hash: string;
  created_at: string;
  disabled_at: string | null;
}

function id(): string {
  return randomBytes(8).toString('hex');
}

function now(): string {
  return new Date().toISOString();
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Opaque, URL-safe, and never stored: only its digest goes in the table. */
function secret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Uses Bun.password with Argon2id, with backward compatibility for legacy scrypt hashes.
 */
function hashPassword(password: string): string {
  return Bun.password.hashSync(password, { algorithm: 'argon2id' });
}

function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith('scrypt$')) {
    const [algorithm, saltHex, keyHex] = stored.split('$');
    if (algorithm !== 'scrypt' || !saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, 'hex');
    let actual: Buffer;
    try {
      actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: SCRYPT_COST });
    } catch {
      return false;
    }
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  return Bun.password.verifySync(password, stored);
}

/**
 * Long enough that a venue's wifi cannot be guessed at, short enough that a
 * fifteen-year-old will actually pick one. Length only: rules about digits and
 * punctuation buy nothing and produce `Password1!` twenty times over.
 */
export const MIN_PASSWORD = 10;

export interface AccountsOptions {
  /** Path to `league.db`. `:memory:` in tests. */
  file: string;
}

export class Accounts {
  private readonly db: Database;

  constructor(opts: AccountsOptions) {
    if (opts.file !== ':memory:') mkdirSync(dirname(opts.file), { recursive: true });
    this.db = new Database(opts.file);
    // WAL so a read of the front page cannot be blocked by a write of a
    // session, which is the only contention this ever has.
    if (opts.file !== ':memory:') this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Whether anybody exists yet, which is how `league` knows to nag for an admin. */
  get empty(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
    return row.n === 0;
  }

  // ---------------------------------------------------------------- accounts

  /**
   * Make an account.
   *
   * The slug comes from the display name through the same `slugifyTeam` a
   * submission's folder name comes from, which is what makes a team account's
   * `own` scope and its directory on disk the same string rather than two
   * strings that have to be kept equal.
   */
  createAccount(input: {
    role: Role;
    displayName: string;
    password: string;
    email?: string | null;
  }): Result<Account> {
    if (input.role === 'guest') return fail('a guest is the absence of an account, not an account');
    if (input.password.length < MIN_PASSWORD) {
      return fail(`a password needs at least ${MIN_PASSWORD} characters`);
    }
    const displayName = input.displayName.trim();
    if (!displayName) return fail('an account needs a name');
    const slug = slugifyTeam(displayName);
    if (this.bySlug(slug)) return fail(`"${displayName}" is taken`);

    const account: Account = {
      id: id(),
      kind: input.role === 'team' ? 'team' : 'person',
      role: input.role,
      slug,
      displayName,
      email: input.email?.trim() || null,
      createdAt: now(),
      disabledAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO accounts (id, kind, role, slug, display_name, email, password_hash, created_at, disabled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        account.id,
        account.kind,
        account.role,
        account.slug,
        account.displayName,
        account.email,
        hashPassword(input.password),
        account.createdAt,
      );
    return ok(account);
  }

  bySlug(slug: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE slug = ?').get(slug) as
      | AccountRow
      | undefined;
    return row ? toAccount(row) : null;
  }

  byId(accountId: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as
      | AccountRow
      | undefined;
    return row ? toAccount(row) : null;
  }

  list(): Account[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY role, display_name')
      .all() as unknown as AccountRow[];
    return rows.map(toAccount);
  }

  /**
   * Check a password.
   *
   * A disabled account fails here rather than at the next door, so there is
   * exactly one place that decides an account may be used at all.
   */
  authenticate(slug: string, password: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE slug = ?').get(slugifyTeam(slug)) as
      | AccountRow
      | undefined;
    if (!row) {
      // Spend the time anyway: answering "no such account" faster than "wrong
      // password" is how a list of who has registered leaks out.
      hashPassword(password);
      return null;
    }
    if (!verifyPassword(password, row.password_hash)) return null;
    if (row.disabled_at) return null;
    return toAccount(row);
  }

  /** The eleven-at-night hatch: somebody cannot log in and their match is next. */
  setPassword(slug: string, password: string): Result<Account> {
    if (password.length < MIN_PASSWORD) {
      return fail(`a password needs at least ${MIN_PASSWORD} characters`);
    }
    const account = this.bySlug(slugifyTeam(slug));
    if (!account) return fail(`no account called "${slug}"`);
    this.db
      .prepare('UPDATE accounts SET password_hash = ? WHERE id = ?')
      .run(hashPassword(password), account.id);
    // Every session that password opened stops here too, which is the point of
    // changing it.
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE account_id = ?').run(now(), account.id);
    return ok(account);
  }

  setDisabled(accountId: string, disabled: boolean): void {
    this.db
      .prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?')
      .run(disabled ? now() : null, accountId);
    if (disabled) {
      this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE account_id = ?').run(now(), accountId);
    }
  }

  // ----------------------------------------------------------------- invites

  /**
   * An invite code, single-use.
   *
   * A team invite carries the team's name, so registering cannot rename it:
   * the organiser decides who "ACT Robotics" is, and the team decides their
   * own password. That is the same rule the whole league runs on — identity
   * comes from what issued the credential, never from what the client typed.
   */
  createInvite(input: { role: Role; team?: string | null; createdBy?: string | null }): Result<Invite> {
    if (input.role === 'guest') return fail('a guest needs no invitation');
    const team = input.team?.trim() || null;
    if (input.role === 'team' && !team) return fail('a team invite needs --team "Their Name"');
    if (input.role !== 'team' && team) return fail('only a team invite names a team');
    if (team && this.bySlug(slugifyTeam(team))) return fail(`"${team}" already has an account`);

    const invite: Invite = {
      code: secret(12),
      role: input.role,
      team,
      createdBy: input.createdBy ?? null,
      createdAt: now(),
      expiresAt: inDays(INVITE_DAYS),
      usedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO invites (code, role, team, created_by, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(invite.code, invite.role, invite.team, invite.createdBy, invite.createdAt, invite.expiresAt);
    return ok(invite);
  }

  listInvites(): Invite[] {
    const rows = this.db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as {
      code: string;
      role: string;
      team: string | null;
      created_by: string | null;
      created_at: string;
      expires_at: string;
      used_at: string | null;
    }[];
    return rows.map((row) => ({
      code: row.code,
      role: isRole(row.role) ? row.role : 'guest',
      team: row.team,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
    }));
  }

  /**
   * Turn an invite into an account.
   *
   * Marked used in the same transaction the account is created in, so two
   * browsers racing the same code produce one account and one honest refusal
   * rather than two accounts or none.
   */
  redeem(code: string, input: { displayName?: string; password: string; email?: string | null }): Result<Account> {
    const row = this.db.prepare('SELECT * FROM invites WHERE code = ?').get(code.trim()) as
      | { code: string; role: string; team: string | null; used_at: string | null; expires_at: string }
      | undefined;
    if (!row) return fail('that invitation code is not one this server issued');
    if (row.used_at) return fail('that invitation has already been used');
    if (row.expires_at < now()) return fail('that invitation has expired — ask the organiser for another');
    if (!isRole(row.role) || row.role === 'guest') return fail('that invitation is malformed');

    // A team invite names the team; anyone else names themselves.
    const displayName = row.role === 'team' ? (row.team ?? '') : (input.displayName ?? '').trim();
    if (!displayName) return fail('a name is required');

    this.db.run('BEGIN IMMEDIATE');
    try {
      const stillUnused = this.db
        .prepare('SELECT used_at FROM invites WHERE code = ?')
        .get(row.code) as { used_at: string | null } | undefined;
      if (!stillUnused || stillUnused.used_at) {
        this.db.run('ROLLBACK');
        return fail('that invitation has already been used');
      }
      const created = this.createAccount({
        role: row.role,
        displayName,
        password: input.password,
        email: input.email ?? null,
      });
      if (!created.ok) {
        this.db.run('ROLLBACK');
        return created;
      }
      this.db.prepare('UPDATE invites SET used_at = ? WHERE code = ?').run(now(), row.code);
      this.db.run('COMMIT');
      return created;
    } catch (error) {
      this.db.run('ROLLBACK');
      return fail((error as Error).message);
    }
  }

  // ---------------------------------------------------------------- sessions

  /** Returns the cookie value. Only its digest is stored, so a stolen `league.db` is not a stolen login. */
  openSession(accountId: string): { token: string; expiresAt: string } {
    const token = secret(32);
    const expiresAt = inDays(SESSION_DAYS);
    this.db
      .prepare(
        'INSERT INTO sessions (hash, account_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(digest(token), accountId, now(), expiresAt);
    return { token, expiresAt };
  }

  accountForSession(token: string): Account | null {
    const row = this.db
      .prepare(
        `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id
          WHERE s.hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.disabled_at IS NULL`,
      )
      .get(digest(token), now()) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  closeSession(token: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE hash = ?').run(now(), digest(token));
  }

  // ---------------------------------------------------------------- api keys

  /**
   * A push credential, minted by the team rather than typed by an organiser.
   *
   * Handed back once, at creation, exactly as the referee token is printed
   * once: the table holds a digest, so a key that is lost is replaced and
   * never recovered.
   */
  createKey(accountId: string, label: string): { key: string; info: ApiKeyInfo } {
    const key = `rcja_${secret(24)}`;
    const info: ApiKeyInfo = {
      id: id(),
      label: label.trim() || 'push key',
      createdAt: now(),
      revokedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO api_keys (id, account_id, hash, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
      )
      .run(info.id, accountId, digest(key), info.label, info.createdAt);
    return { key, info };
  }

  listKeys(accountId: string): ApiKeyInfo[] {
    const rows = this.db
      .prepare('SELECT id, label, created_at, revoked_at FROM api_keys WHERE account_id = ? ORDER BY created_at DESC')
      .all(accountId) as { id: string; label: string; created_at: string; revoked_at: string | null }[];
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  revokeKey(accountId: string, keyId: string): boolean {
    const result = this.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL')
      .run(now(), keyId, accountId);
    return Number(result.changes) > 0;
  }

  accountForKey(key: string): Account | null {
    const row = this.db
      .prepare(
        `SELECT a.* FROM api_keys k JOIN accounts a ON a.id = k.account_id
          WHERE k.hash = ? AND k.revoked_at IS NULL AND a.disabled_at IS NULL`,
      )
      .get(digest(key)) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  // ------------------------------------------------------------------ grants

  grant(accountId: string, capability: Capability, scope: Scope, target: string | null = null): void {
    this.db
      .prepare('INSERT INTO grants (account_id, capability, scope, target) VALUES (?, ?, ?, ?)')
      .run(accountId, capability, scope, target);
  }

  grantsFor(accountId: string): Grant[] {
    const rows = this.db
      .prepare('SELECT capability, scope, target FROM grants WHERE account_id = ?')
      .all(accountId) as { capability: string; scope: string; target: string | null }[];
    return rows.map((row) => ({
      capability: row.capability as Capability,
      scope: row.scope as Scope,
      target: row.target,
    }));
  }

  /** An `Account` as the capability check wants it: a role, a slug and its extra rows. */
  actorFor(account: Account): Actor {
    return {
      id: account.id,
      role: account.role,
      slug: account.slug,
      grants: this.grantsFor(account.id),
    };
  }

  // ------------------------------------------------------------------- audit

  record(actorId: string | null, capability: string, target: string | null, detail?: string): void {
    this.db
      .prepare('INSERT INTO audit (at, actor_id, capability, target, detail) VALUES (?, ?, ?, ?, ?)')
      .run(now(), actorId, capability, target, detail ?? null);
  }

  audit(limit = 200): AuditRow[] {
    const rows = this.db
      .prepare(
        `SELECT au.at, au.actor_id, au.capability, au.target, au.detail, a.display_name
           FROM audit au LEFT JOIN accounts a ON a.id = au.actor_id
          ORDER BY au.at DESC LIMIT ?`,
      )
      .all(limit) as {
      at: string;
      actor_id: string | null;
      capability: string;
      target: string | null;
      detail: string | null;
      display_name: string | null;
    }[];
    return rows.map((row) => ({
      at: row.at,
      actorId: row.actor_id,
      actorName: row.display_name,
      capability: row.capability,
      target: row.target,
      detail: row.detail,
    }));
  }
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    kind: row.kind === 'team' ? 'team' : 'person',
    role: isRole(row.role) ? row.role : 'guest',
    slug: row.slug,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}
