import { Store } from './store.js';

export async function exportBackup(env) {
  const tables = ['users', 'places', 'events', 'orders', 'tickets', 'admins', 'audit_log'];
  const result = await env.DB.batch(tables.map(table => env.DB.prepare(`SELECT * FROM ${table} LIMIT 10001`)));
  const data = {};
  tables.forEach((table, i) => {
    if (result[i].results.length > 10000) throw new Error('Snapshot limit exceeded — use a full D1 export or SQLite backup');
    data[table] = result[i].results;
  });
  const text = JSON.stringify({ format: 'siahe-json', version: 1, created_at: new Date().toISOString(), tables: data });
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw new Error('Snapshot larger than 8 MB — use full database export');
  return text;
}

const bytes = new TextEncoder();
const hex = v => [...new Uint8Array(v)].map(n => n.toString(16).padStart(2, '0')).join('');
async function sha(v) { return hex(await crypto.subtle.digest('SHA-256', bytes.encode(v))); }
async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? bytes.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, bytes.encode(text));
}
export async function putS3(env, key, content) {
  const endpoint = new URL(env.S3_ENDPOINT);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search) throw new Error('S3 endpoint must be a plain HTTPS URL');
  const path = [...endpoint.pathname.split('/').filter(Boolean), env.S3_BUCKET, ...key.split('/')].map(s => encodeURIComponent(s)).join('/');
  const url = new URL('/' + path, endpoint.origin);
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8), region = env.S3_REGION || 'default';
  const hash = await sha(content);
  const headers = `host:${url.host}\nx-amz-content-sha256:${hash}\nx-amz-date:${timestamp}\n`;
  const signed = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = `PUT\n${url.pathname}\n\n${headers}\n${signed}\n${hash}`;
  const scope = `${date}/${region}/s3/aws4_request`;
  const signText = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${await sha(canonical)}`;
  const dateKey = await hmac('AWS4' + env.S3_SECRET_ACCESS_KEY, date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, 's3');
  const signingKey = await hmac(serviceKey, 'aws4_request');
  const signature = hex(await hmac(signingKey, signText));
  const response = await fetch(url, { method: 'PUT', body: content, headers: {
    'Content-Type': 'application/json', 'x-amz-content-sha256': hash, 'x-amz-date': timestamp,
    Authorization: `AWS4-HMAC-SHA256 Credential=${env.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Private S3 backup failed with HTTP ${response.status}`);
}
export async function runBackup(env, key) {
  const snapshot = await exportBackup(env);
  const filename = `siahe-${new Date().toISOString().slice(0, 10)}-${key}.json`;
  if (env.S3_BUCKET) {
    for (const field of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) if (!env[field]) throw new Error(`Missing ${field}`);
    await putS3(env, `backups/${filename}`, snapshot);
  }
  if (env.BACKUP_CHAT) await new Store(env.DB).enqueue('sendDocument', { chat_id: env.BACKUP_CHAT, _documentText: snapshot, filename, caption: 'نسخه پشتیبان محرمانه انجمن علمی رباتیک' }, `backup-file:${key}`);
}
