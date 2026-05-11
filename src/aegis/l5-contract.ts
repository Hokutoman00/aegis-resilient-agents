// L5 — graceful degradation contract.
//
// When L0-L4 have exhausted every viable provider/model, L5 synthesizes a
// helpful, honest response instead of propagating a raw upstream error.
// The contract is "the user gets a useful answer or an honest explanation,
// never a stack trace."
//
// In v0 we ship the graceful synthesis only. Per-request budget/SLA/quality
// contracts are introduced in a subsequent commit.

import type { ProviderTry } from './types.js';

export interface SyntheticChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string; refusal?: null };
    finish_reason: 'stop' | 'content_filter' | 'length' | 'tool_calls';
    logprobs: null;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  system_fingerprint?: string;
}

export interface L5ContractRecord {
  budgets: {
    latency_ms?: { spent: number; limit: number };
    cost_usd?: { spent: number; limit: number };
  };
  quality_floor?: string;
  actual_quality?: string;
  honored: boolean;
  degraded: boolean;
  degradation_reason?: string;
}

export interface BuildGracefulInput {
  requestId: string;
  providersTried: ProviderTry[];
  startedAt: Date;
}

const FAILURE_CLASS_EXPLANATIONS: Record<string, string> = {
  credit_balance_too_low:
    'the underlying provider account has run out of credit, so its API rejected the request',
  insufficient_quota:
    'the provider has hit its rate-limit / quota window, so the request was throttled',
  context_overflow: 'the prompt + history exceeded what any reachable model could process at once',
  model_unavailable:
    'the requested model has been deprecated or is temporarily unavailable from its provider',
};

export function buildGracefulResponse(input: BuildGracefulInput): {
  completion: SyntheticChatCompletion;
  l5: L5ContractRecord;
} {
  const classes = new Set<string>();
  for (const p of input.providersTried) {
    const cls = p.error?.message_class;
    if (cls) classes.add(cls);
  }

  const explanations: string[] = [];
  for (const c of classes) {
    const e = FAILURE_CLASS_EXPLANATIONS[c];
    if (e) explanations.push(`- ${c}: ${e}`);
  }

  const attemptedNames = input.providersTried.map((p) => p.name).join(', ');
  const content = [
    "I can't reach a working LLM right now, so I'm responding honestly instead of guessing.",
    '',
    `I tried these providers in order: ${attemptedNames || '(none)'}.`,
    explanations.length > 0
      ? `What appears to have failed:\n${explanations.join('\n')}`
      : 'All attempts returned upstream errors that I could not auto-classify.',
    '',
    'You can: (a) try again in a few seconds (transient outages often clear), (b) check the Aegis Receipt attached to this response for the exact upstream error, or (c) configure additional providers in your TrueFoundry Virtual Model to expand the fallback chain.',
  ].join('\n');

  const created = Math.floor(input.startedAt.getTime() / 1000);
  const completion: SyntheticChatCompletion = {
    id: `chatcmpl-aegis-${input.requestId}`,
    object: 'chat.completion',
    created,
    model: 'aegis/graceful-l5',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: Math.ceil(content.length / 4),
      total_tokens: Math.ceil(content.length / 4),
    },
    system_fingerprint: 'aegis-v3.0-l5',
  };

  const l5: L5ContractRecord = {
    budgets: {},
    honored: true,
    degraded: true,
    degradation_reason: `all_providers_failed (${[...classes].join('|') || 'unclassified'})`,
  };

  return { completion, l5 };
}
