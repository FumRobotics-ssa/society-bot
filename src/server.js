import http from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './sqlite.js';
import { handleRequest } from './app.js';
import { runJobs } from './jobs.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const field of ['BOT_TOKEN', 'OWNER_IDS', 'PUBLIC_URL', 'WEBHOOK_SECRET']) {
  if (!process.env[field]) throw new Error(`Missing required setting ${field}`);
}
if (process.env.WEBHOOK_SECRET.length < 32) throw new Error('WEBHOOK_SECRET must have at least 32 random characters');
const base = new URL(process.env.PUBLIC_URL);
if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('PUBLIC_URL must use HTTPS in production');
const db = createDatabase(process.env.DB_PATH || resolve(root, 'data/siahe.sqlite'));
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
const mime = { '.html': 'text/html;charset=utf-8', '.js': 'application/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8' };
const env = { ...process.env, DB: db, ASSETS: { async fetch(request) {
  const name = new URL(request.url).pathname.slice(1);
  if (!['admin.html', 'admin.js', 'style.css', 'ticket.css'].includes(name)) return new Response('Not found', { status: 404 });
  const file = resolve(root, 'public', name);
  if (!existsSync(file)) return new Response('Not found', { status: 404 });
  const ext = '.' + name.split('.').at(-1);
  return new Response(readFileSync(file), { headers: { 'Content-Type': mime[ext] } });
} } };
const tasks = new Set();
const ctx = { waitUntil(promise) { tasks.add(promise); promise.catch(() => console.error('Background task failed')).finally(() => tasks.delete(promise)); } };
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const init = { method: incoming.method, headers: incoming.headers };
    if (!['GET', 'HEAD'].includes(incoming.method)) { init.body = Readable.toWeb(incoming); init.duplex = 'half'; }
    // Trust only configured public origin, never attacker-controlled Host headers.
    const request = new Request(new URL(incoming.url, base.origin), init);
    const response = await handleRequest(request, env, ctx);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body || incoming.method === 'HEAD') outgoing.end();
    else Readable.fromWeb(response.body).pipe(outgoing);
  } catch { outgoing.writeHead(500); outgoing.end('Internal error'); }
});
let running = false, tick = 0;
const interval = setInterval(async () => {
  if (running) return;
  running = true;
  try { await runJobs(env, { maintenance: ++tick % 30 === 0 }); }
  catch { console.error('Job maintenance failed — inspect database and configuration'); }
  finally { running = false; }
}, 2000);
server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => console.log('Siahe is running on configured host and port'));
async function shutdown() {
  clearInterval(interval); server.close();
  await Promise.allSettled([...tasks]);
  if (running) { setTimeout(shutdown, 250).unref(); return; }
  db.close(); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
