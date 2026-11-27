import { handleRequest } from './app.js';
import { outboxMetricsQuery, refreshOutboxPressure, runJobs } from './jobs.js';
import arvanRelay from '../ops/cloudflare/arvan-relay.js';

const posterPath = /^\/api\/events\/\d+\/poster$/;
const queueEnv = env => ({
  ...env,
  INBOX_CAPACITY: 256,
  INBOX_CONCURRENCY: 1,
  OUTBOX_LANE_CONCURRENCY: 1,
  OUTBOX_BACKPRESSURE: true,
  QUEUE_LANES: true,
  RECORD_QUEUE_EVENT(reason) { console.warn(JSON.stringify({ event: 'queue_rejection', reason })); },
});

async function scheduledJobs(env) {
  const [inbox, outbox] = await env.DB.batch([
    env.DB.prepare("SELECT count(*) AS depth,COALESCE(unixepoch()-MIN(created_at),0) AS age FROM inbox WHERE status IN ('new','processing')"),
    env.DB.prepare(outboxMetricsQuery),
  ]);
  const incoming = inbox.results[0], outgoing = outbox.results[0];
  await refreshOutboxPressure(env, outgoing.depth);
  const alert = incoming.depth >= 128 || incoming.age >= 60 || outgoing.age >= 120;
  (alert ? console.warn : console.info)(JSON.stringify({ event: 'queue_metrics', alert, inbox: incoming, outbox: outgoing }));
  await runJobs(queueEnv(env), { maintenance: true, inboxLimit: 8 });
}

export default {
  async fetch(request, env, ctx) {
    if (env.HOSTING_MODE !== 'cloudflare') return arvanRelay.fetch(request, env);
    const url = new URL(request.url);
    // Version previews may probe health. Application data stays on the configured origin.
    if (env.PUBLIC_URL && url.origin !== new URL(env.PUBLIC_URL).origin && url.pathname !== '/health') {
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'GET' || !posterPath.test(url.pathname)) return handleRequest(request, queueEnv(env), ctx);
    url.search = '';
    const cacheKey = new Request(url);
    const existing = await caches.default.match(cacheKey);
    if (existing) return existing;
    const response = await handleRequest(request, queueEnv(env), ctx);
    if (response.ok && response.headers.get('Cache-Control')?.startsWith('public,')) {
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()).catch(() => console.warn('Poster cache write failed')));
    }
    return response;
  },
  scheduled(event, env, ctx) {
    if (env.HOSTING_MODE === 'cloudflare') ctx.waitUntil(scheduledJobs(env));
  },
};
