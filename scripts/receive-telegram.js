import { receiveTelegram } from '../src/telegram-receiver.js';

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown.abort());
await receiveTelegram(process.env, shutdown.signal);
