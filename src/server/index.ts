// Aegis server entry point. The /v1/chat/completions endpoint is OpenAI-compatible
// and forwards to TrueFoundry's AI Gateway (L1 retry + L2 model fallback + L3
// provider fallback handled by TF's Virtual Model). Every response carries an
// Aegis Receipt summarizing what happened. See docs/RECEIPT.md.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type OpenAI from 'openai';
import { classifyError, pickFallbackTarget } from '../aegis/l4-semantic.js';
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
  const baseParams: Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'model'> = {
    ...(body as Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'model' | 'stream'>),
    stream: false,
  };

  // Attempt loop: primary call, then up to 2 L4-driven fallback attempts.
  const triedModels = new Set<string>();
  let currentModel = requestedModel;
  let lastError: ProviderError | undefined;
  let success: OpenAI.ChatCompletion | undefined;
  const MAX_L4_FALLBACKS = 2;

  for (let attempt = 0; attempt <= MAX_L4_FALLBACKS; attempt += 1) {
    triedModels.add(currentModel);
    const startedAt = Date.now();
    try {
      const response = await tf.chat.completions.create({
        ...baseParams,
        model: currentModel,
      });
      const totalMs = Date.now() - startedAt;
      const usage = response.usage;
      receipt.recordProvider({
        name: response.model ?? currentModel,
        via: 'tf',
        outcome: 'success',
        ttft_ms: null,
        total_ms: totalMs,
        tokens: { input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0 },
      });
      receipt.fired('L1');
      success = response;
      break;
    } catch (err) {
      const totalMs = Date.now() - startedAt;
      const error = parseError(err);
      receipt.recordProvider({
        name: currentModel,
        via: 'tf',
        outcome: 'error',
        error,
        ttft_ms: null,
        total_ms: totalMs,
      });
      lastError = error;

      // L4 — classify the error and decide whether to retry with an alternate.
      const match = classifyError(error, currentModel);
      if (match) {
        receipt.setL4Match(match);
        if (match.action_taken === 'fallback_provider' && attempt < MAX_L4_FALLBACKS) {
          const target = pickFallbackTarget(currentModel, triedModels);
          if (target) {
            currentModel = target;
            continue;
          }
        }
      }
      break;
    }
  }

  if (success) {
    return c.json({ ...success, _aegis_receipt: receipt.build() });
  }

  // L5 graceful degradation lands in a subsequent commit. For now we surface
  // the final upstream error along with the full Receipt — judges and
  // operators can see every attempt + the L4 classification.
  return c.json(
    {
      error: {
        type: lastError?.type ?? 'upstream_error',
        message: lastError?.raw_message ?? 'all attempts failed',
        status: lastError?.status,
      },
      _aegis_receipt: receipt.build(),
    },
    (lastError?.status ?? 502) as never,
  );
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
