// Read-only network probe for an actual VPS / cloud region. No token is printed.
if (!process.env.BOT_TOKEN) throw new Error('Set BOT_TOKEN locally');
try {
  const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!result.ok) { console.error('Bot authentication failed', result.error_code); process.exit(1); }
  console.log('Outbound Telegram Bot API connection and bot token verified');
} catch { console.error('Telegram connection failed from this environment'); process.exit(1); }
