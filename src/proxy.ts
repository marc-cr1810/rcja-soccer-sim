/**
 * Forwarding a request to a world running somewhere else on this machine.
 *
 * `fields.ts` has done this since Phase 4, so that a venue opens one hole in
 * one firewall and every practice field is reached through it. Phase 6's
 * league server needs exactly the same thing for exactly the same reason: the
 * front door binds the venue's port, the world it is showing binds loopback,
 * and a spectator's viewer socket and a student's `/agent` connection both
 * arrive at the front door and are passed through.
 *
 * Pulled out here rather than copied because Phase 7 turns the one world into
 * several child processes, and the moment there are two copies of a WebSocket
 * upgrade forwarder is the moment one of them is subtly wrong.
 */

import { Agent, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * An agent with no connection pool.
 *
 * Node's global agent keeps connections alive between requests, which is
 * exactly wrong for an upstream that may be killed at any moment: a pooled
 * socket to a process that has stopped is a handle nothing will ever close,
 * and a process holding one never exits. It cost a whole test run hanging
 * after every test in it had passed.
 */
export function upstreamAgent(): Agent {
  return new Agent({ keepAlive: false });
}

export interface ProxyTarget {
  port: number;
  /** Defaults to loopback: everything this forwards to is on this machine. */
  host?: string;
}

/**
 * Forward one HTTP request. `path` is what to ask the upstream for.
 *
 * `onClose` fires once, whether the exchange finished or failed, which is what
 * a caller counting open connections needs.
 */
export function proxyRequest(
  target: ProxyTarget,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { agent: Agent; unreachable: string; onClose?: () => void },
): void {
  let closed = false;
  const done = (): void => {
    if (closed) return;
    closed = true;
    opts.onClose?.();
  };

  const upstream = request(
    {
      host: target.host ?? '127.0.0.1',
      port: target.port,
      path,
      method: req.method,
      headers: req.headers,
      agent: opts.agent,
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(opts.unreachable);
    done();
  });
  res.on('close', done);
  req.pipe(upstream);
}

/**
 * Forward a WebSocket upgrade, socket to socket.
 *
 * Both doors a world has go through here: the viewer stream a spectator
 * watches, and `/agent`, which is how a program on a laptop reaches a world at
 * all. The handshake is re-written by hand because there is nothing to parse —
 * the upstream answers the client directly from the first byte onwards.
 */
export function proxyUpgrade(
  target: ProxyTarget,
  path: string,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: { onClose?: () => void } = {},
): void {
  let closed = false;
  const done = (): void => {
    if (closed) return;
    closed = true;
    opts.onClose?.();
    upstream.destroy();
    socket.destroy();
  };

  const upstream = connect(target.port, target.host ?? '127.0.0.1', () => {
    const headers = [`GET ${path} HTTP/1.1`];
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const one of value) headers.push(`${name}: ${one}`);
      else if (value !== undefined) headers.push(`${name}: ${value}`);
    }
    upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on('error', done);
  socket.on('error', done);
  socket.on('close', done);
}
