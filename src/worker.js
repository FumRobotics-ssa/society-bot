import { handleRequest } from './app.js';
import { runJobs } from './jobs.js';
export default {
  fetch: handleRequest,
  async scheduled(event, env, ctx) { ctx.waitUntil(runJobs(env, { maintenance: true })); },
};
