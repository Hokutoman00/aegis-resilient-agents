// Aegis server entry point. The /v1/chat/completions endpoint is OpenAI-compatible
// and forwards to TrueFoundry's AI Gateway (L1 retry + L2 model fallback + L3
// provider fallback handled by TF's Virtual Model). Every response carries an
// Aegis Receipt summarizing what happened. See docs/RECEIPT.md.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { streamSSE } from 'hono/streaming';
import type OpenAI from 'openai';
import { hedgedChatCompletion } from '../aegis/l0-hedge.js';
import { classifyError, pickFallbackTarget } from '../aegis/l4-semantic.js';
import { buildGracefulResponse } from '../aegis/l5-contract.js';
import { getChaosState, startChaosScheduler } from '../aegis/l6-chaos.js';
import { getDefaultVirtualModel, getTFClient } from '../aegis/tf-client.js';
import { callWithSpofBypass, isInfrastructureError } from '../aegis/tf-spof.js';
import type { ProviderError } from '../aegis/types.js';
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
app.get('/v1/chaos/status', (c) => c.json(getChaosState()));

// MCP tool execution with classification-aware resilience.
// POST /v1/mcp/call
// body: { tool: { name, "x-aegis-idempotent"? }, args: {...},
//         primary?: { name, latency_ms, fail_rate?, fixed_failure? },
//         secondary?: { name, latency_ms, fail_rate?, fixed_failure? } }
// If primary/secondary blocks are omitted, default mock callers are used so
// the demo path always works. In a real deployment these would be HTTP
// clients pointing at registered MCP servers.
app.post('/v1/mcp/call', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.tool !== 'object' || body.tool === null) {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'tool (object) required' } },
      400,
    );
  }
  const tool = body.tool as { name: string; 'x-aegis-idempotent'?: boolean };
  if (typeof tool.name !== 'string') {
    return c.json({ error: { type: 'invalid_request_error', message: 'tool.name required' } }, 400);
  }
  const args = (body.args ?? {}) as Record<string, unknown>;

  const { makeMockCaller } = await import('../mcp/mock-caller.js');
  const { executeMCPCall } = await import('../mcp/hedge.js');

  const primaryCfg = (body.primary as Record<string, unknown>) ?? {
    name: 'primary',
    latency_ms: 50,
  };
  const secondaryCfg = (body.secondary as Record<string, unknown>) ?? {
    name: 'backup',
    latency_ms: 100,
  };
  const primary = makeMockCaller({
    name: String(primaryCfg.name ?? 'primary'),
    latency_ms: Number(primaryCfg.latency_ms ?? 50),
    fail_rate: typeof primaryCfg.fail_rate === 'number' ? primaryCfg.fail_rate : undefined,
    fixed_failure:
      typeof primaryCfg.fixed_failure === 'string' ? primaryCfg.fixed_failure : undefined,
  });
  const secondary = makeMockCaller({
    name: String(secondaryCfg.name ?? 'backup'),
    latency_ms: Number(secondaryCfg.latency_ms ?? 100),
    fail_rate: typeof secondaryCfg.fail_rate === 'number' ? secondaryCfg.fail_rate : undefined,
    fixed_failure:
      typeof secondaryCfg.fixed_failure === 'string' ? secondaryCfg.fixed_failure : undefined,
  });

  const out = await executeMCPCall(
    { tool, args },
    {
      primary,
      secondary,
      primaryName: String(primaryCfg.name ?? 'primary'),
      secondaryName: String(secondaryCfg.name ?? 'backup'),
      tied_timeout_ms: typeof body.tied_timeout_ms === 'number' ? body.tied_timeout_ms : 2_000,
    },
  );
  return c.json(out);
});

// MCP tool classification probe. Useful for verifying the convention works
// for a given tool definition before wiring it to a hedge / tied execution.
//
// POST /v1/mcp/classify
// body: { name: "search_web", "x-aegis-idempotent"?: true|false }
app.post('/v1/mcp/classify', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.name !== 'string') {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'name (string) required' } },
      400,
    );
  }
  const { classifyTool, hedgePolicyFor } = await import('../mcp/classifier.js');
  const classification = classifyTool({
    name: body.name,
    'x-aegis-idempotent':
      typeof body['x-aegis-idempotent'] === 'boolean'
        ? (body['x-aegis-idempotent'] as boolean)
        : undefined,
  });
  return c.json({
    classification,
    policy: hedgePolicyFor(classification.klass),
  });
});

app.post('/v1/chat/completions', async (c) => {
  const receipt = new ReceiptBuilder();
  receipt.setL6Chaos(getChaosState()); // attach freshness signal to every receipt
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

  const tf = getTFClient();
  const streamRequested = Boolean(body.stream);

  // ── Streaming path ────────────────────────────────────────────────────
  // SSE response. Each upstream chunk is forwarded as a `data:` event; after
  // the stream completes (success or failure), Aegis emits a custom
  // `aegis.receipt` event with the full Receipt, then `data: [DONE]` per the
  // OpenAI streaming convention. v0 streaming skips L0 hedge and L4
  // cascade retries — those re-enter the lifecycle in non-streaming mode.
  if (streamRequested) {
    return streamSSE(c, async (stream) => {
      const startedAt = Date.now();
      let firstChunkAt: number | null = null;
      let providerModel: string | undefined;
      let outputTokens = 0;

      try {
        const tfStream = await tf.chat.completions.create({
          ...(body as Omit<OpenAI.ChatCompletionCreateParamsStreaming, 'stream'>),
          model: requestedModel,
          stream: true,
        });

        for await (const chunk of tfStream) {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          if (!providerModel) providerModel = chunk.model;
          if (chunk.choices?.[0]?.delta?.content) outputTokens += 1;
          await stream.writeSSE({ data: JSON.stringify(chunk) });
        }

        const totalMs = Date.now() - startedAt;
        receipt.recordProvider({
          name: providerModel ?? requestedModel,
          via: 'tf',
          outcome: 'success',
          ttft_ms: firstChunkAt ? firstChunkAt - startedAt : null,
          total_ms: totalMs,
          tokens: { input: 0, output: outputTokens },
        });
        receipt.fired('L1');
        receipt.setTFHealth({ reachable: true, bypass_used: false });
      } catch (err) {
        const totalMs = Date.now() - startedAt;
        const error = parseError(err);
        const bypass = isInfrastructureError(err);
        receipt.recordProvider({
          name: providerModel ?? requestedModel,
          via: 'tf',
          outcome: 'error',
          error,
          ttft_ms: firstChunkAt ? firstChunkAt - startedAt : null,
          total_ms: totalMs,
        });
        receipt.setTFHealth({ reachable: !bypass, bypass_used: bypass });

        // L4 classification in stream mode is informational only; we don't
        // restart the stream on a different model. Client can retry without
        // stream=true to get the full L4 cascade + L5 graceful path.
        const match = classifyError(error, providerModel ?? requestedModel);
        if (match) receipt.setL4Match(match);

        // Surface error as a custom event so OpenAI-compat clients don't
        // mistake it for a chunk.
        await stream.writeSSE({
          event: 'aegis.error',
          data: JSON.stringify({
            type: error.type ?? 'upstream_error',
            message: error.raw_message ?? 'streaming failed',
            status: error.status,
            advice: 'retry without stream=true to engage the L4 cascade + L5 graceful response',
          }),
        });
      }

      // Receipt as the final domain event, then the OpenAI sentinel.
      await stream.writeSSE({
        event: 'aegis.receipt',
        data: JSON.stringify(receipt.build()),
      });
      await stream.writeSSE({ data: '[DONE]' });
    });
  }
  // ── End streaming path ───────────────────────────────────────────────
  const baseParams: Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'model'> = {
    ...(body as Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'model' | 'stream'>),
    stream: false,
  };

  // L0 hedge — fire a duplicate to an alternate model after a latency threshold.
  // Opt-in per request via the `x-aegis-hedge` body field (object or "true"
  // shorthand). Off by default to keep behavior predictable; demo scenarios
  // pass `x-aegis-hedge: { hedge_model: ..., hedge_after_ms: 1500 }`.
  const hedgeOpt = (body as Record<string, unknown>)['x-aegis-hedge'];
  let hedgeInitial: OpenAI.ChatCompletion | undefined;
  let hedgeInitialError: ProviderError | undefined;
  const triedModels = new Set<string>();

  if (hedgeOpt) {
    const config = typeof hedgeOpt === 'object' ? (hedgeOpt as Record<string, unknown>) : {};
    const hedgeModel =
      typeof config.hedge_model === 'string'
        ? config.hedge_model
        : (pickFallbackTarget(requestedModel, new Set([requestedModel])) ?? 'openai/gpt-4.1-mini');
    const hedgeAfterMs = typeof config.hedge_after_ms === 'number' ? config.hedge_after_ms : 1500;

    const result = await hedgedChatCompletion(
      { primaryModel: requestedModel, hedgeModel, hedgeAfterMs },
      baseParams,
      tf,
    );
    receipt.recordProvider(result.primaryAttempt);
    triedModels.add(requestedModel);
    if (result.hedgeAttempt) {
      receipt.recordProvider(result.hedgeAttempt);
      triedModels.add(hedgeModel);
    }
    receipt.setL0Hedge(result.record);
    receipt.fired('L1');
    if (result.response) {
      hedgeInitial = result.response;
    } else {
      hedgeInitialError = result.lastError;
    }
  }

  // Standard attempt loop continues from here (or starts here if no hedge).
  // Primary call (if hedge didn't already run), then up to 2 L4-driven fallback attempts.
  let currentModel = requestedModel;
  let lastError: ProviderError | undefined = hedgeInitialError;
  let success: OpenAI.ChatCompletion | undefined = hedgeInitial;
  const MAX_L4_FALLBACKS = 2;
  const startingAttempt = hedgeOpt ? 1 : 0;

  // If hedge completed with success, skip the loop. Otherwise classify the
  // hedge's lastError via L4 and possibly continue with a different alternate.
  if (!success && hedgeInitialError) {
    const match = classifyError(hedgeInitialError, requestedModel);
    if (match?.action_taken === 'fallback_provider') {
      receipt.setL4Match(match);
      const next = pickFallbackTarget(currentModel, triedModels);
      if (next) currentModel = next;
    }
  }

  let bypassUsedAny = false;

  for (let attempt = startingAttempt; attempt <= MAX_L4_FALLBACKS && !success; attempt += 1) {
    triedModels.add(currentModel);
    const result = await callWithSpofBypass(tf, { ...baseParams, model: currentModel });
    if (result.bypassed) bypassUsedAny = true;

    if (result.response) {
      const usage = result.response.usage;
      receipt.recordProvider({
        name: result.response.model ?? currentModel,
        via: result.via,
        outcome: 'success',
        ttft_ms: null,
        total_ms: result.durationMs,
        tokens: { input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0 },
      });
      receipt.fired('L1');
      success = result.response;
      break;
    }

    const error = parseError(result.error);
    receipt.recordProvider({
      name: currentModel,
      via: result.via,
      outcome: 'error',
      error,
      ttft_ms: null,
      total_ms: result.durationMs,
    });
    lastError = error;

    // L4 — classify the error and decide whether to retry with an alternate.
    const match = classifyError(error, currentModel);
    if (match) {
      receipt.setL4Match(match); // also backfills message_class on the last provider entry
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

  receipt.setTFHealth({ reachable: !bypassUsedAny, bypass_used: bypassUsedAny });

  if (success) {
    return c.json({ ...success, _aegis_receipt: receipt.build() });
  }

  // L5 — every viable path failed. Synthesize a graceful, honest response
  // instead of propagating a raw upstream error. The Receipt records the full
  // attempt chain plus the L5 degradation reason.
  const { completion, l5 } = buildGracefulResponse({
    requestId: receipt.getRequestId(),
    providersTried: receipt.getProviders(),
    startedAt: receipt.getStartedAt(),
  });
  receipt.setL5Contract(l5);

  return c.json({ ...completion, _aegis_receipt: receipt.build() });
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

// Start L6 self-chaos scheduler. Drill every 30s with a rotating scenario.
// In production this would be Toxiproxy-injected; v0 uses synthetic drills
// against the L4 classifier (see src/aegis/l6-chaos.ts).
startChaosScheduler(30_000);
console.log('[aegis] L6 self-chaos scheduler started (30s interval)');

export default {
  port: env.PORT,
  fetch: app.fetch,
};
