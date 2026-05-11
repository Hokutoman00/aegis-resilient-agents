// L0 — request hedging.
//
// Most "resilient" gateways are reactive: they fall back only after a failure.
// By the time the fallback fires, the user has already waited. L0 is proactive:
// after the primary has been outstanding for `hedgeAfterMs`, Aegis fires a
// duplicate request to an alternate provider. Whichever returns first wins;
// the loser is canceled to bound cost. See Jeff Dean & Luiz Barroso,
// "The Tail at Scale" (2013), and docs/ARCHITECTURE.md §L0.
//
// v0 — non-streaming only. TTFT-based hedging arrives with streaming support.

import type OpenAI from 'openai';
import type { ProviderError, ProviderTry } from './types.js';

export interface HedgeConfig {
  primaryModel: string;
  hedgeModel: string;
  hedgeAfterMs: number; // delay before firing the hedge (default: ~p95 latency)
}

export interface HedgeRecord {
  fired: boolean;
  trigger_threshold_ms: number;
  canceled_at_ms: number | null;
  extra_cost_usd: number;
}

export interface HedgeResult {
  primaryAttempt: ProviderTry;
  hedgeAttempt?: ProviderTry;
  winner: 'primary' | 'hedge' | 'none';
  response?: OpenAI.ChatCompletion;
  lastError?: ProviderError;
  record: HedgeRecord;
}

interface AttemptOutcome {
  who: 'primary' | 'hedge';
  startedAt: number;
  response?: OpenAI.ChatCompletion;
  error?: ProviderError;
  rawErr?: unknown;
}

// Build a ProviderTry from an outcome. Caller decides outcome label since
// 'canceled' is determined by who lost the race, not by the outcome itself.
function toProviderTry(
  modelName: string,
  outcome: AttemptOutcome,
  endTime: number,
  outcomeLabel: 'success' | 'error' | 'canceled',
): ProviderTry {
  const usage = outcome.response?.usage;
  return {
    name: outcome.response?.model ?? modelName,
    via: 'tf',
    outcome: outcomeLabel,
    error: outcome.error,
    ttft_ms: null,
    total_ms: endTime - outcome.startedAt,
    tokens: usage
      ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
      : undefined,
  };
}

function parseSdkError(err: unknown): ProviderError {
  const e = err as {
    status?: number;
    error?: { type?: string; code?: string; message?: string };
    message?: string;
    name?: string;
  };
  return {
    status: e?.status,
    type: e?.error?.type ?? e?.name,
    code: e?.error?.code ?? (e?.status ? String(e.status) : undefined),
    raw_message: e?.error?.message ?? e?.message,
  };
}

export async function hedgedChatCompletion(
  config: HedgeConfig,
  baseParams: Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'model'>,
  tf: OpenAI,
): Promise<HedgeResult> {
  const primaryController = new AbortController();
  const hedgeController = new AbortController();

  const primaryStart = Date.now();
  const primary: Promise<AttemptOutcome> = tf.chat.completions
    .create({ ...baseParams, model: config.primaryModel }, { signal: primaryController.signal })
    .then((r) => ({ who: 'primary' as const, startedAt: primaryStart, response: r }))
    .catch((e) => ({
      who: 'primary' as const,
      startedAt: primaryStart,
      error: parseSdkError(e),
      rawErr: e,
    }));

  // Latched hedge promise: never resolves until the timer fires it.
  let hedgeResolve: (o: AttemptOutcome) => void = () => {};
  const hedgePromise = new Promise<AttemptOutcome>((resolve) => {
    hedgeResolve = resolve;
  });

  let hedgeFired = false;
  let hedgeStart = 0;

  const hedgeTimer = setTimeout(() => {
    hedgeFired = true;
    hedgeStart = Date.now();
    tf.chat.completions
      .create({ ...baseParams, model: config.hedgeModel }, { signal: hedgeController.signal })
      .then((r) => hedgeResolve({ who: 'hedge', startedAt: hedgeStart, response: r }))
      .catch((e) =>
        hedgeResolve({
          who: 'hedge',
          startedAt: hedgeStart,
          error: parseSdkError(e),
          rawErr: e,
        }),
      );
  }, config.hedgeAfterMs);

  const first = await Promise.race([primary, hedgePromise]);
  clearTimeout(hedgeTimer);
  const firstEndedAt = Date.now();

  // Decision: if the first one is a success, cancel the other and we're done.
  // If it's a failure, await the other (it might still succeed) — but bound it.
  const winnerIsSuccess = first.response !== undefined;

  if (winnerIsSuccess) {
    if (first.who === 'primary') hedgeController.abort();
    else primaryController.abort();
  }

  // If the winner failed, give the other side a chance — but if hedge wasn't
  // even fired (primary failed fast under hedgeAfterMs), don't wait.
  let other: AttemptOutcome | undefined;
  if (!winnerIsSuccess) {
    if (first.who === 'primary' && hedgeFired) {
      other = await hedgePromise;
    } else if (first.who === 'hedge') {
      other = await primary;
    }
  }

  // Build provider tries. The "loser" in a winning race is canceled.
  const primaryTry =
    first.who === 'primary'
      ? toProviderTry(
          config.primaryModel,
          first,
          firstEndedAt,
          winnerIsSuccess ? 'success' : 'error',
        )
      : other && other.who === 'primary'
        ? toProviderTry(
            config.primaryModel,
            other,
            Date.now(),
            other.response ? 'success' : 'error',
          )
        : toProviderTry(
            config.primaryModel,
            { who: 'primary', startedAt: primaryStart },
            firstEndedAt,
            winnerIsSuccess ? 'canceled' : 'canceled',
          );

  let hedgeTry: ProviderTry | undefined;
  if (hedgeFired) {
    if (first.who === 'hedge') {
      hedgeTry = toProviderTry(
        config.hedgeModel,
        first,
        firstEndedAt,
        winnerIsSuccess ? 'success' : 'error',
      );
    } else if (other && other.who === 'hedge') {
      hedgeTry = toProviderTry(
        config.hedgeModel,
        other,
        Date.now(),
        other.response ? 'success' : 'error',
      );
    } else {
      hedgeTry = toProviderTry(
        config.hedgeModel,
        { who: 'hedge', startedAt: hedgeStart },
        firstEndedAt,
        'canceled',
      );
    }
  }

  // Determine the winner of the overall hedged call.
  const winnerAttempt = winnerIsSuccess ? first : other?.response ? other : undefined;
  const winnerSide: 'primary' | 'hedge' | 'none' = winnerAttempt ? winnerAttempt.who : 'none';

  // Extra cost: only the hedge's emitted tokens count as extra. If hedge was
  // canceled before any output, cost ≈ 0. For v0 we estimate from completion
  // tokens at a flat rate ($0.003/1k); real per-model pricing arrives later.
  let extraCostUsd = 0;
  if (hedgeTry?.tokens?.output) {
    extraCostUsd = (hedgeTry.tokens.output / 1000) * 0.003;
  }

  const canceledAtMs = hedgeFired && hedgeStart > 0 ? firstEndedAt - hedgeStart : null;

  return {
    primaryAttempt: primaryTry,
    hedgeAttempt: hedgeTry,
    winner: winnerSide,
    response: winnerAttempt?.response ?? undefined,
    lastError: !winnerAttempt ? (first.error ?? other?.error) : undefined,
    record: {
      fired: hedgeFired,
      trigger_threshold_ms: config.hedgeAfterMs,
      canceled_at_ms: canceledAtMs,
      extra_cost_usd: Math.round(extraCostUsd * 1e6) / 1e6,
    },
  };
}
