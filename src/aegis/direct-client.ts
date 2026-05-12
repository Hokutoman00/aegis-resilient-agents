// Direct provider clients used only by the L3 SPOF bypass. When TrueFoundry's
// Gateway itself is unreachable, Aegis routes around it by calling the
// provider's API directly with credentials kept in Aegis's local env.
//
// We never use these by default. Only the SPOF detector triggers them.

import OpenAI from 'openai';
import { getEnv } from '../config.js';

let openaiDirectClient: OpenAI | null = null;

export function hasDirectProvider(model: string): boolean {
  const env = getEnv();
  if (model.startsWith('openai/') || model.includes('gpt')) return Boolean(env.OPENAI_API_KEY);
  if (model.startsWith('anthropic/') || model.includes('claude')) {
    return Boolean(env.ANTHROPIC_API_KEY);
  }
  return false;
}

export function getDirectOpenAI(): OpenAI | null {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) return null;
  if (openaiDirectClient) return openaiDirectClient;
  openaiDirectClient = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_DIRECT_BASE_URL ?? 'https://api.openai.com/v1',
  });
  return openaiDirectClient;
}

// Strip "openai/" / "anthropic/" prefix that TF uses for its provider scoping.
// Direct provider APIs expect bare model names ("gpt-4.1-mini" not "openai/gpt-4.1-mini").
export function bareModelName(prefixedModel: string): string {
  const slash = prefixedModel.indexOf('/');
  return slash > 0 ? prefixedModel.slice(slash + 1) : prefixedModel;
}
