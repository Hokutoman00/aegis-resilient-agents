// TF SPOF (single point of failure) bypass.
//
// Aegis's preferred path is via the TrueFoundry AI Gateway. But Aegis itself
// would be down if it trusted TF unconditionally — TF *is* a SPOF for Aegis
// in that arrangement. This module wraps every LLM call so that if TF's
// infrastructure (gateway itself, not the provider behind it) fails, Aegis
// routes the same request directly to the provider using locally-stored keys.
//
// "Infrastructure error" detection is conservative: we only bypass on
//   - connection-level errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT, EAI_AGAIN)
//   - HTTP 502 (Bad Gateway), 504 (Gateway Timeout) returned by TF itself
//   - HTTP 503 with empty body (TF unavailable, distinct from provider 503)
// Provider failures (Anthropic 400, OpenAI 429, etc.) DO NOT trigger bypass —
// those stay in TF's domain where L1-L3 + Aegis L4 handle them.

import type OpenAI from 'openai';
import { bareModelName, getDirectOpenAI } from './direct-client.js';
import type { ProviderTry } from './types.js';

export interface TFCallResult {
  response?: OpenAI.ChatCompletion;
  error?: unknown;
  via: 'tf' | 'direct';
  durationMs: number;
  bypassed: boolean;
}

export function isInfrastructureError(err: unknown): boolean {
  const e = err as { status?: number; code?: string; cause?: { code?: string }; message?: string };
  // Network-level: connection refused / reset / timeout / DNS
  const code = e?.code ?? e?.cause?.code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND'
  ) {
    return true;
  }
  // HTTP-level: TF gateway returning gateway errors
  if (e?.status === 502 || e?.status === 504) return true;
  // Heuristic: if message hints at gateway-level error
  if (e?.message && /bad gateway|gateway timeout|gateway unavailable/i.test(e.message)) {
    return true;
  }
  return false;
}

export async function callWithSpofBypass(
  tfClient: OpenAI,
  params: OpenAI.ChatCompletionCreateParamsNonStreaming,
): Promise<TFCallResult> {
  const start = Date.now();
  try {
    const response = await tfClient.chat.completions.create(params);
    return { response, via: 'tf', durationMs: Date.now() - start, bypassed: false };
  } catch (err) {
    if (!isInfrastructureError(err)) {
      return { error: err, via: 'tf', durationMs: Date.now() - start, bypassed: false };
    }

    // TF itself is unhealthy. Try the provider directly.
    const direct = getDirectOpenAI();
    if (!direct) {
      // No direct key configured — propagate the original error.
      return { error: err, via: 'tf', durationMs: Date.now() - start, bypassed: false };
    }

    const directStart = Date.now();
    try {
      const response = await direct.chat.completions.create({
        ...params,
        model: bareModelName(params.model),
      });
      return {
        response,
        via: 'direct',
        durationMs: Date.now() - directStart,
        bypassed: true,
      };
    } catch (directErr) {
      return {
        error: directErr,
        via: 'direct',
        durationMs: Date.now() - directStart,
        bypassed: true,
      };
    }
  }
}

export function markProviderViaInResult(
  providerTry: ProviderTry,
  via: 'tf' | 'direct',
): ProviderTry {
  return { ...providerTry, via };
}
