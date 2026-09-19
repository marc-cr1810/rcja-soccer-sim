/**
 * Request-body validation against the same zod schemas that generate the docs.
 *
 * One reader and one validator, used by every handler that takes a JSON body.
 * The zod schemas in `schemas.ts` are the single source of truth for what a
 * request may contain; a handler passes the reason string it would have used
 * for a bad field, and `validateBody` turns a schema failure into exactly that
 * `{ ok: false, reason }` response at 400 — so the error contract this codebase
 * keeps (a reason safe to show a person) is unchanged by validation moving from
 * hand-written type checks to schemas.
 */

import type { z } from 'zod';

export type BodyResult = { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string; status: number };

/**
 * Read the request body and parse it as JSON.
 *
 * Returns `{ ok: false }` with 413 when the body exceeds `limit` bytes and 400
 * with `body is not valid JSON` when it does not parse to an object — the two
 * failures the handlers already produce themselves.
 */
export async function readJsonBody(req: Request, limit?: number): Promise<BodyResult> {
  const text = await req.text().catch(() => '');
  if (limit !== undefined && text.length > limit) {
    return { ok: false, reason: 'request body too large', status: 413 };
  }
  if (!text.trim()) return { ok: true, payload: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, payload: parsed as Record<string, unknown> };
    }
  } catch {
    // fall through to the same refusal below
  }
  return { ok: false, reason: 'body is not valid JSON', status: 400 };
}

export function badBody(reason: string, status = 400): Response {
  return Response.json({ ok: false, reason }, { status });
}

export type Validated<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * A message for a schema failure.
 *
 * Either one message for every failure — the usual case — or a function from
 * the first failing path (e.g. `"seat"`, `"fill.team"`) to the message for it,
 * for endpoints whose hand-written checks had a different message per field.
 */
export type FailureReason = string | ((path: string) => string);

/**
 * Validate a parsed body against a zod schema.
 *
 * `reason` is the message the handler already used for a bad field, so the
 * response a bad request gets is unchanged — only *what counts as a bad field*
 * comes from the schema now.
 */
export function validateBody<T>(
  payload: Record<string, unknown>,
  schema: z.ZodType<T>,
  reason: FailureReason,
): Validated<T> {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const message = typeof reason === 'string' ? reason : reason(first ? first.path.join('.') : '');
  return { ok: false, response: badBody(message) };
}