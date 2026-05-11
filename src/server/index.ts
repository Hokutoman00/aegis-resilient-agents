// Aegis server entry point — minimal Hono skeleton.
// Real layer logic lives in src/aegis/*. This file is the bare HTTP surface.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

const app = new Hono();

app.use('*', logger());
app.use('*', cors());

app.get('/', (c) =>
  c.json({
    name: 'aegis',
    version: '0.1.0',
    motto: 'hedge first, fallback second, continuously chaos-verified',
    docs: '/docs',
  }),
);

app.get('/health', (c) => {
  // L3 invariant probe will live here: TF heartbeat, provider reachability summary.
  // For now, just a heartbeat.
  return c.json({
    status: 'ok',
    uptime_seconds: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// OpenAI-compatible chat endpoint. Real implementation will:
//   1. Wrap the request in the L5 contract envelope
//   2. Launch L0 hedge if applicable
//   3. Route via TF (with L3 SPOF fall-through)
//   4. Apply L4 semantic error inspection on failures
//   5. Append the Aegis Receipt to the response
app.post('/v1/chat/completions', async (c) => {
  return c.json(
    {
      error: {
        type: 'not_implemented',
        message:
          'Chat endpoint scaffold present; layer wiring lands in subsequent commits. See AGENTS.md for the implementation order.',
      },
    },
    501,
  );
});

const port = Number(process.env.PORT ?? 3000);

console.log(`[aegis] listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
