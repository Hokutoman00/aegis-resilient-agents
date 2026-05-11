// L4 — semantic error fallback.
//
// Catches errors the TF Gateway didn't (400 credit_balance_too_low, 429
// insufficient_quota, context-window overflows, deprecation messages, etc.)
// and routes them to an alternate provider/model. Closes the industry-wide
// gap documented in LiteLLM issue #24320.
//
// Detection priority: structured field (error.type / error.code) before
// regex on raw message. See docs/ARCHITECTURE.md §L4.

import type { ProviderError } from './types.js';

export type L4Action = 'fallback_provider' | 'fallback_model' | 'split_and_retry' | 'pass_through';

export interface L4Rule {
  id: string;
  matchProvider?: 'anthropic' | 'openai' | 'google' | '*';
  matchStatus?: number;
  matchType?: string;
  matchCode?: string;
  matchMessage?: RegExp;
  messageClass: string;
  action: L4Action;
}

export interface L4Match {
  rule_id: string;
  rule_source: 'default' | 'user_config' | 'learned';
  action_taken: L4Action;
  message_class: string;
  fallback_target?: string;
}

// Default rules. Order matters — first match wins. The list intentionally
// duplicates structured + regex variants so we catch the same class even
// if a provider changes its exact wording.
export const DEFAULT_L4_RULES: L4Rule[] = [
  // Anthropic credit-balance — the canonical industry-gap case.
  {
    id: 'anthropic.400.credit_balance.structured',
    matchProvider: 'anthropic',
    matchStatus: 400,
    matchType: 'invalid_request_error',
    matchMessage: /credit balance/i,
    messageClass: 'credit_balance_too_low',
    action: 'fallback_provider',
  },
  {
    id: 'anthropic.400.credit_balance.regex',
    matchStatus: 400,
    matchMessage: /credit balance.{0,40}too low/i,
    messageClass: 'credit_balance_too_low',
    action: 'fallback_provider',
  },

  // OpenAI quota exhaustion.
  {
    id: 'openai.429.insufficient_quota',
    matchProvider: 'openai',
    matchStatus: 429,
    matchCode: 'insufficient_quota',
    messageClass: 'insufficient_quota',
    action: 'fallback_provider',
  },
  {
    id: 'openai.quota.regex',
    matchStatus: 429,
    matchMessage: /exceeded your current quota|insufficient[_ ]quota/i,
    messageClass: 'insufficient_quota',
    action: 'fallback_provider',
  },

  // Context-window overflow — split-and-retry rather than provider swap.
  {
    id: 'context_overflow',
    matchMessage: /context.{0,20}(too long|window exceeded|length exceeded)|too many tokens/i,
    messageClass: 'context_overflow',
    action: 'split_and_retry',
  },

  // Model deprecation / not found — fallback to a different model.
  {
    id: 'model_unavailable',
    matchMessage: /model.{0,20}(deprecated|not found|unavailable|does not exist)/i,
    messageClass: 'model_unavailable',
    action: 'fallback_model',
  },
];

export function classifyError(
  error: ProviderError | undefined,
  providerName: string,
  rules: L4Rule[] = DEFAULT_L4_RULES,
): L4Match | null {
  if (!error) return null;
  const provider = inferProvider(providerName);

  for (const rule of rules) {
    if (rule.matchProvider && rule.matchProvider !== '*' && rule.matchProvider !== provider)
      continue;
    if (rule.matchStatus !== undefined && rule.matchStatus !== error.status) continue;
    if (rule.matchType !== undefined && rule.matchType !== error.type) continue;
    if (rule.matchCode !== undefined && rule.matchCode !== error.code) continue;
    if (rule.matchMessage) {
      if (!error.raw_message || !rule.matchMessage.test(error.raw_message)) continue;
    }
    return {
      rule_id: rule.id,
      rule_source: 'default',
      action_taken: rule.action,
      message_class: rule.messageClass,
    };
  }
  return null;
}

function inferProvider(name: string): 'anthropic' | 'openai' | 'google' | 'unknown' {
  const n = name.toLowerCase();
  if (n.includes('anthropic') || n.includes('claude')) return 'anthropic';
  if (n.includes('openai') || n.includes('gpt')) return 'openai';
  if (n.includes('google') || n.includes('gemini')) return 'google';
  return 'unknown';
}

// Default fallback targets when L4 decides to route to another provider.
// In subsequent commits these become configurable.
export const DEFAULT_FALLBACK_TARGETS = {
  anthropic: ['openai/gpt-4.1-mini', 'openai/gpt-4.1', 'openai/chat-latest'],
  openai: ['anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-4-5'],
  google: ['anthropic/claude-haiku-4-5', 'openai/gpt-4.1-mini'],
  unknown: ['openai/gpt-4.1-mini', 'anthropic/claude-haiku-4-5'],
} as const;

export function pickFallbackTarget(
  originalModel: string,
  alreadyTried: Set<string>,
): string | null {
  const provider = inferProvider(originalModel);
  const targets = DEFAULT_FALLBACK_TARGETS[provider] ?? DEFAULT_FALLBACK_TARGETS.unknown;
  for (const t of targets) {
    if (!alreadyTried.has(t)) return t;
  }
  return null;
}
