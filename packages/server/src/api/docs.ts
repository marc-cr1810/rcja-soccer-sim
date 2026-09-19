/**
 * The interactive API docs — `/api/docs`.
 *
 * Two static files (`openapi.json` and the Scalar standalone bundle) and one
 * HTML page that loads them. The Scalar bundle lives in `node_modules` and
 * is shipped to the browser as a single 3.7 MB self-contained JS file. No
 * build step is needed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openApiJson } from './openapi';

/**
 * Serve everything under `/api/docs/*`:
 *   - `GET /api/docs`           → HTML page (Scalar UI)
 *   - `GET /api/docs/openapi.json` → OpenAPI 3.1 JSON
 *   - `GET /api/docs/scalar.js` → Scalar standalone bundle
 *
 * Returns `null` if the path does not match, to let the caller fall through.
 */
export function handleDocs(path: string, port?: number): Response | null {
  const sub = path === '/docs' || path === '/docs/' ? 'index' : path.slice('/docs/'.length);

  if (sub === 'index') {
    return new Response(docsPage(), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  if (sub === 'openapi.json') {
    return new Response(openApiJson({ port }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  if (sub === 'scalar.js') {
    try {
      const bundle = readFileSync(scalarBundlePath(), 'utf8');
      return new Response(bundle, {
        headers: { 'content-type': 'application/javascript; charset=utf-8' },
      });
    } catch {
      return new Response('scalar bundle not built yet — run: npm install @scalar/api-reference', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  }

  return null;
}

function docsPage(): string {
  const config = JSON.stringify({
    spec: { url: '/api/docs/openapi.json' },
    layout: 'modern',
    theme: 'purple',
    hideModels: true,
    defaultHttpClient: { targetKey: 'javascript', clientKey: 'fetch' },
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RCJA Soccer Simulator — API Reference</title>
  <style>
    body { margin: 0; }
  </style>
</head>
<body>
  <script
    id="api-reference"
    data-configuration='${config}'
  ></script>
  <script src="/api/docs/scalar.js"></script>
</body>
</html>`;
}

/** Resolve the Scalar standalone bundle from the installed package. */
function scalarBundlePath(): string {
  // Works whether run from the workspace root or a compiled binary.
  try {
    return resolve(dirname(require.resolve('@scalar/api-reference')), 'browser/standalone.js');
  } catch {
    const base = import.meta.dirname
      ? join(import.meta.dirname, '../../../../')
      : process.cwd();
    return join(base, 'node_modules/@scalar/api-reference/dist/browser/standalone.js');
  }
}
