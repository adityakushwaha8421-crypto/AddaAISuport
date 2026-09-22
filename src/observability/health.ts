import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Metrics } from './metrics.js';

export interface HealthChecks {
  [name: string]: () => Promise<boolean> | boolean;
}

/** Extra routes (the gateway's internal API). Return true when the request was handled. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface HealthServerOptions {
  /** /readyz: may this instance take traffic right now (not draining, dependencies up)? */
  ready?: HealthChecks;
  routes?: RouteHandler;
}

/**
 * GET /healthz → 200/503 with per-component status; GET /metrics → Prometheus text.
 * Binds to localhost by default: put it behind your own proxy if it must be reachable.
 */
export function startHealthServer(port: number, checks: HealthChecks, metrics: Metrics, host = '127.0.0.1', opts: HealthServerOptions = {}): Promise<Server> {
  const evaluate = async (set: HealthChecks) => {
    const results: Record<string, boolean> = {};
    for (const [name, check] of Object.entries(set)) {
      try {
        results[name] = await check();
      } catch {
        results[name] = false;
      }
    }
    return results;
  };
  const server = createServer(async (req, res) => {
    if (opts.routes && (await opts.routes(req, res).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
      return true;
    }))) return;
    if (req.url === '/readyz') {
      const results = await evaluate({ ...checks, ...(opts.ready ?? {}) });
      const ok = Object.values(results).every(Boolean);
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: ok, components: results }));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(metrics.render());
      return;
    }
    if (req.url === '/healthz' || req.url === '/') {
      const results = await evaluate(checks);
      const ok = Object.values(results).every(Boolean);
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok, components: results }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is already in use — is another copy of the agent running? Stop it, or set HTTP_PORT to a free port.`)
          : err,
      );
    });
    server.listen(port, host, () => resolve(server));
  });
}
