import http from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './sqlite.js';
import { handleRequest } from './app.js';
import { maintenance, processInbox, processOutbox } from './jobs.js';
import { prepareEventPoster } from './poster-jpeg.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const field of ['BOT_TOKEN', 'OWNER_IDS', 'PUBLIC_URL', 'WEBHOOK_SECRET']) {
  if (!process.env[field]) throw new Error(`Missing required setting ${field}`);
}
if (process.env.WEBHOOK_SECRET.length < 32) throw new Error('WEBHOOK_SECRET must have at least 32 random characters');
const base = new URL(process.env.PUBLIC_URL);
if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('PUBLIC_URL must use HTTPS in production');
const databasePath = resolve(process.env.DB_PATH || resolve(root, 'data/robotics-society.sqlite'));
const databaseDirectory = dirname(databasePath);
if (!existsSync(databasePath) && existsSync(databaseDirectory) && readdirSync(databaseDirectory).some(name => /\.sqlite(?:3)?$/i.test(name))) {
  throw new Error('An existing SQLite database was found. Set DB_PATH to that file before starting; no new database was created.');
}
const db = createDatabase(databasePath);
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY)');
for (const filename of readdirSync(resolve(root, 'migrations')).filter(x => x.endsWith('.sql')).sort()) {
  if (!await db.prepare('SELECT name FROM schema_migrations WHERE name=?').bind(filename).first()) {
    db.native.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(resolve(root, 'migrations', filename), 'utf8'));
      db.native.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(filename);
      db.native.exec('COMMIT');
    } catch (error) { db.native.exec('ROLLBACK'); throw error; }
  }
}
const assetDirectory = resolve(root, 'public');
const mime = { '.html': 'text/html;charset=utf-8', '.js': 'application/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml;charset=utf-8', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
function minuteLimiter(maximum) {
  let minute = -1;
  const counts = new Map();
  return { async limit({ key }) {
    const currentMinute = Math.floor(Date.now() / 60000);
    if (minute !== currentMinute) { counts.clear(); minute = currentMinute; }
    const count = counts.get(key) || 0;
    if (count >= maximum || (!count && counts.size >= 10000)) return { success: false };
    counts.set(key, count + 1);
    return { success: true };
  } };
}
let stopping = false;
let counters = {};
const env = {
  ...process.env,
  DB: db,
  DEFER_TELEGRAM_JOBS: true,
  PREPARE_EVENT_POSTER: prepareEventPoster,
  INBOX_CAPACITY: 256,
  OUTBOX_BACKPRESSURE: true,
  JOBS_STOPPING: () => stopping,
  RECORD_QUEUE_EVENT: name => { counters[name] = (counters[name] || 0) + 1; },
  CHECKIN_RATE_LIMITER: minuteLimiter(120),
  TELEGRAM_GLOBAL_RATE: minuteLimiter(600),
  TELEGRAM_INGRESS_RATE: minuteLimiter(40),
  TELEGRAM_ABUSE_SAMPLE: minuteLimiter(3),
  ASSETS: { async fetch(request) {
  // The shared app route allowlists the public assets before calling this binding.
  const file = resolve(assetDirectory, new URL(request.url).pathname.slice(1));
  const type = mime[extname(file)];
  if (!file.startsWith(assetDirectory + sep) || !type || !existsSync(file)) return new Response('Not found', { status: 404 });
  return new Response(readFileSync(file), { headers: { 'Content-Type': type } });
} } };
const server = http.createServer({ headersTimeout: 10000, requestTimeout: 20000 }, async (incoming, outgoing) => {
  try {
    const init = { method: incoming.method, headers: incoming.headers };
    if (!['GET', 'HEAD'].includes(incoming.method)) { init.body = Readable.toWeb(incoming); init.duplex = 'half'; }
    // Trust only configured public origin, never attacker-controlled Host headers.
    const request = new Request(new URL(incoming.url, base.origin), init);
    const response = await handleRequest(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body || incoming.method === 'HEAD') outgoing.end();
    else Readable.fromWeb(response.body).pipe(outgoing);
  } catch { outgoing.writeHead(500); outgoing.end('Internal error'); }
});
const running = new Map();
function runLane(name, task) {
  if (stopping || running.has(name)) return;
  running.set(name, Promise.resolve().then(task).catch(() => {
    console.error(JSON.stringify({ event: 'job_lane_failed', lane: name }));
  }).finally(() => running.delete(name)));
}
const workInterval = setInterval(() => {
  runLane('inbox', () => processInbox(env, 8));
  runLane('interactive', () => processOutbox(env, 4, 'interactive'));
  runLane('media', () => processOutbox(env, 1, 'media'));
  runLane('poster', () => processOutbox(env, 1, 'poster'));
  runLane('bulk', () => processOutbox(env, 1, 'bulk'));
}, 500);
const maintenanceInterval = setInterval(() => runLane('maintenance', async () => {
  const inbox = await db.prepare("SELECT count(*) AS depth, COALESCE(unixepoch()-MIN(created_at),0) AS age FROM inbox WHERE status IN ('new','processing')").first();
  const outbox = await db.prepare("SELECT count(*) AS depth, COALESCE(unixepoch()-MIN(created_at),0) AS age FROM outbox WHERE status IN ('pending','processing')").first();
  const alert = inbox.depth >= 128 || inbox.age >= 60 || outbox.age >= 120 ||
    Object.values(counters).some(count => count >= 10) || Boolean(counters.reservation_limit);
  const metrics = { event: 'queue_metrics', alert, inbox, outbox, ...counters };
  counters = {};
  (alert ? console.warn : console.info)(JSON.stringify(metrics));
  await maintenance(env);
}), 60000);
server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => console.log('Robotics Society bot is running on configured host and port'));
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(workInterval);
  clearInterval(maintenanceInterval);
  const closing = new Promise(resolveClose => server.close(resolveClose));
  await Promise.allSettled([closing, ...running.values()]);
  db.close(); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
