import { describe, expect, test } from 'bun:test';
import { buildGracefulResponse } from '../../src/aegis/l5-contract.js';

describe('L5 buildGracefulResponse', () => {
  const baseInput = () => ({
    requestId: '01HX0000000000000000000000',
    providersTried: [
      {
        name: 'anthropic/claude-sonnet-4-5',
        via: 'tf' as const,
        outcome: 'error' as const,
        error: {
          status: 400,
          raw_message: 'Your credit balance is too low.',
          message_class: 'credit_balance_too_low',
        },
        ttft_ms: null,
        total_ms: 800,
      },
      {
        name: 'openai/gpt-4.1-mini',
        via: 'tf' as const,
        outcome: 'error' as const,
        error: {
          status: 429,
          raw_message: 'You exceeded your current quota.',
          message_class: 'insufficient_quota',
        },
        ttft_ms: null,
        total_ms: 1100,
      },
    ],
    startedAt: new Date('2026-05-11T10:48:00Z'),
  });

  test('returns an OpenAI-compatible chat completion shape', () => {
    const { completion } = buildGracefulResponse(baseInput());
    expect(completion.object).toBe('chat.completion');
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0]?.message.role).toBe('assistant');
    expect(completion.choices[0]?.finish_reason).toBe('stop');
    expect(completion.model).toBe('aegis/graceful-l5');
  });

  test('assistant message names every failure class seen', () => {
    const { completion } = buildGracefulResponse(baseInput());
    const content = completion.choices[0]?.message.content ?? '';
    expect(content).toContain('credit_balance_too_low');
    expect(content).toContain('insufficient_quota');
  });

  test('assistant message lists every provider attempted', () => {
    const { completion } = buildGracefulResponse(baseInput());
    const content = completion.choices[0]?.message.content ?? '';
    expect(content).toContain('anthropic/claude-sonnet-4-5');
    expect(content).toContain('openai/gpt-4.1-mini');
  });

  test('contract record is honored + degraded with reason', () => {
    const { l5 } = buildGracefulResponse(baseInput());
    expect(l5.honored).toBe(true);
    expect(l5.degraded).toBe(true);
    expect(l5.degradation_reason).toContain('all_providers_failed');
    expect(l5.degradation_reason).toContain('credit_balance_too_low');
    expect(l5.degradation_reason).toContain('insufficient_quota');
  });

  test('id is namespaced by request id', () => {
    const { completion } = buildGracefulResponse(baseInput());
    expect(completion.id.startsWith('chatcmpl-aegis-')).toBe(true);
    expect(completion.id).toContain('01HX0000000000000000000000');
  });

  test('handles empty failure classes (unclassified upstream)', () => {
    const base = baseInput();
    const input = {
      ...base,
      providersTried: base.providersTried.map((p) => ({
        ...p,
        error: p.error ? { status: p.error.status, raw_message: p.error.raw_message } : p.error,
      })),
    };
    const { completion, l5 } = buildGracefulResponse(input);
    expect(l5.degradation_reason).toContain('unclassified');
    expect(completion.choices[0]?.message.content).toContain('upstream errors');
  });
});
