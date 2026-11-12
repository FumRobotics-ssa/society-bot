const env = process.env;
for (const key of ['BOT_TOKEN', 'PUBLIC_URL', 'WEBHOOK_SECRET']) if (!env[key]) throw new Error(`Missing ${key}`);
if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET)) throw new Error('WEBHOOK_SECRET must be 32-256 random URL-safe characters');
const base = new URL(env.PUBLIC_URL);
if (base.protocol !== 'https:') throw new Error('Telegram webhook requires a public HTTPS URL');
const url = new URL('/telegram', base).href;
const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], max_connections: 10, drop_pending_updates: false }),
});
const result = await response.json();
if (!result.ok) { console.error('Webhook registration failed', result.error_code, result.description); process.exit(1); }
console.log('Webhook registered successfully at the configured public URL');
