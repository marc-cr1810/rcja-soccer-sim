/**
 * Build the OpenAPI document from the schemas and route table.
 *
 * The document is static once built — schemas and routes are both compile-time
 * constants — so `buildOpenApi()` memoizes. `openApiJson()` is what the docs
 * handler serves.
 */

import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from './routes';
import * as schemas from './schemas';

export interface OpenApiOptions {
  /** The port the docs are served on, used to describe the server. */
  port?: number;
}

let cached: ReturnType<OpenApiGeneratorV31['generateDocument']> | null = null;

export function buildOpenApi(options: OpenApiOptions = {}): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  if (cached) return cached;

  // The schema module is the component source: every schema is registered as
  // an OpenAPI component by its refId. The registry contributes the paths.
  const generator = new OpenApiGeneratorV31([
    ...Object.values(schemas),
    ...registry.definitions,
  ]);

  cached = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'RCJA Soccer Simulator API',
      version: '1.0.0',
      description: [
        'The HTTP surface of the league and match servers.',
        '',
        'Responses are envelope-shaped: `{ ok: true, ... }` on success and',
        '`{ ok: false, reason }` on failure, with the `reason` safe to show a',
        'person. Auth is either a session cookie (`rcja_session`) or an',
        '`Authorization: Bearer <token>` header — a push key starting `rcja_`,',
        'a workspace token, or the referee token.',
      ].join('\n'),
    },
    servers: [{ url: `http://localhost:${options.port ?? 3550}` }],
    security: [],
    tags: [
      { name: 'Auth', description: 'Accounts and sessions' },
      { name: 'Public', description: 'Reading the tournament: front page, schedule, standings, matches, teams' },
      { name: 'Keys', description: "A team's own push keys" },
      { name: 'Admin', description: 'Account administration — create accounts and invites, reset passwords' },
      { name: 'Submit', description: 'Pushing a robot' },
      { name: 'Practice', description: 'The practice field and its controls' },
      { name: 'Referee', description: 'Refereeing a running match' },
      { name: 'Workspace', description: 'The team workspace editor' },
      { name: 'Arena', description: 'Hub ↔ child arena protocol' },
    ],
  });

  // The generator returns only its own components; the security schemes live
  // under `components` in 3.1, so they are merged in after.
  cached.components = {
    ...cached.components,
    securitySchemes: {
      team: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A team push key (`rcja_…`) or session. Confers the account\'s "team" capabilities: submit, push keys, workspace.',
      },
      admin: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A push key (`rcja_…`) of an account whose role is `admin`. Confers `account.manage`.',
      },
      referee: {
        type: 'http',
        scheme: 'bearer',
        description: 'The hand-issued referee token configured when the server was started.',
      },
    },
  };

  return cached;
}

export function openApiJson(options: OpenApiOptions = {}): string {
  return JSON.stringify(buildOpenApi(options));
}