// Aegis server entry point. The /v1/chat/completions endpoint is OpenAI-compatible
// and forwards to TrueFoundry's AI Gateway (L1 retry + L2 model fallback + L3
// provider fallback handled by TF's Virtual Model). Every response carries an
// Aegis Receipt summarizing what happened. See docs/RECEIPT.md.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type OpenAI from 'openai';
import { getDefaultVirtualModel, getTFClient } from '../aegis/tf-client.js';
import type { ProviderError, ProviderTry } from '../aegis/types.js';
import { getEnv } from '../config.js';
import { ReceiptBuilder } from '../receipt/builder.js';

const env = getEnv();
const app = new Hono();

app.use('*', logger());
app.use('*', cors());

app.get('/', (c) =>
  c.json({
    name: 'aegis',
    version: '0.1.0',
    motto: 'hedge first, fallback second, continuously chaos-verified',
    docs: '/docs',
    virtual_model: getDefaultVirtualModel(),
  }),
);

app.get('/health', (c) => {
  // L3 invariant probe — full reachability check lands in subsequent commit.
  return c.json({
    status: 'ok',
    uptime_seconds: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// OpenAI-compatible chat completion endpoint.
// Forwards via TF AI Gateway. L1/L2/L3 resilience happens inside TF per the
// configured Virtual Model. Aegis adds: Receipt construction (always), and in
// subsequent commits L0 hedge, L4 semantic error, L5 contract, L6 chaos.
app.post('/v1/chat/completions', async (c) => {
  const receipt = new ReceiptBuilder();
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  if (!body || !Array.isArray(body.messages)) {
    return c.json(
      {
        error: { type: 'invalid_request_error', message: 'messages[] is required' },
        _aegis_receipt: receipt.build(),
      },
      400,
    );
  }

  const requestedModel =
    typeof body.model === 'string' && body.model.length > 0 ? body.model : getDefaultVirtualModel();

  // For now we ignore streaming. Streaming support arrives with the hedge
  // (L0) commit since hedging two streams in parallel changes the request
  // lifecycle materially.
  const streamRequested = Boolean(body.stream);
  if (streamRequested) {
    return c.json(
      {
        error: {
          type: 'not_implemented',
          message: 'stream=true arrives with the L0 hedge commit. Set stream=false for now.',
        },
        _aegis_receipt: receipt.build(),
      },
      501,
    );
  }

  const tf = getTFClient();
  const tryStartedAt = Date.now();

  try {
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      ...(body as Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'model' | 'stream'>),
      model: requestedModel,
      stream: false,
    };
    const response = await tf.chat.completions.create(params);

    const totalMs = Date.now() - tryStartedAt;
    const usage = response.usage;
    const providerTry: ProviderTry = {
      name: response.model ?? requestedModel,
      via: 'tf',
      outcome: 'success',
      ttft_ms: null, // exposed only via streaming
      total_ms: totalMs,
      tokens: {
        input: usage?.prompt_tokens ?? 0,
        output: usage?.completion_tokens ?? 0,
      },
    };
    receipt.recordProvider(providerTry);
    // TF transparently handled L1/L2/L3 — we credit them as fired only if we
    // can detect from response metadata. For v0, mark L1 as a baseline.
    receipt.fired('L1');

    return c.json({
      ...response,
      _aegis_receipt: receipt.build(),
    });
  } catch (err) {
    const totalMs = Date.now() - tryStartedAt;
    const error = parseError(err);
    const providerTry: ProviderTry = {
      name: requestedModel,
      via: 'tf',
      outcome: 'error',
      error,
      ttft_ms: null,
      total_ms: totalMs,
    };
    receipt.recordProvider(providerTry);
    // L4 semantic detection lands next — for v0 we surface the error as-is.

    return c.json(
      {
        error: {
          type: error.type ?? 'upstream_error',
          message: error.raw_message ?? 'TF gateway returned an error',
          status: error.status,
        },
        _aegis_receipt: receipt.build(),
      },
      (error.status ?? 502) as never,
    );
  }
});

function parseError(err: unknown): ProviderError {
  // OpenAI SDK throws OpenAI.APIError with status / type / code / message.
  const e = err as {
    status?: number;
    error?: { type?: string; code?: string; message?: string };
    message?: string;
  };
  return {
    status: e?.status,
    type: e?.error?.type,
    code: e?.error?.code,
    raw_message: e?.error?.message ?? e?.message,
  };
}

console.log(`[aegis] listening on http://localhost:${env.PORT}`);
console.log(`[aegis] virtual model: ${getDefaultVirtualModel()}`);

export default {
  port: env.PORT,
  fetch: app.fetch,
};
