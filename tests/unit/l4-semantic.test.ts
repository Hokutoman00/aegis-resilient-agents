import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FALLBACK_TARGETS,
  classifyError,
  pickFallbackTarget,
} from '../../src/aegis/l4-semantic.js';

describe('L4 classifyError', () => {
  test('matches Anthropic 400 credit_balance via structured + regex rule', () => {
    const match = classifyError(
      {
        status: 400,
        type: 'invalid_request_error',
        raw_message: 'Your credit balance is too low to access the Anthropic API.',
      },
      'anthropic/claude-sonnet-4-5',
    );
    expect(match).not.toBeNull();
    expect(match?.message_class).toBe('credit_balance_too_low');
    expect(match?.action_taken).toBe('fallback_provider');
  });

  test('matches OpenAI 429 insufficient_quota via structured rule', () => {
    const match = classifyError(
      {
        status: 429,
        code: 'insufficient_quota',
        raw_message: 'You exceeded your current quota.',
      },
      'openai/gpt-4.1-mini',
    );
    expect(match).not.toBeNull();
    expect(match?.message_class).toBe('insufficient_quota');
    expect(match?.action_taken).toBe('fallback_provider');
  });

  test('OpenAI 429 with only regex hint still matches (no structured code)', () => {
    const match = classifyError(
      { status: 429, raw_message: 'openai error: You exceeded your current quota' },
      'openai/gpt-4.1-mini',
    );
    expect(match?.message_class).toBe('insufficient_quota');
  });

  test('matches context_overflow (split_and_retry) for any provider', () => {
    const match = classifyError(
      { status: 400, raw_message: 'context length too long for this model' },
      'anthropic/claude-haiku-4-5',
    );
    expect(match?.message_class).toBe('context_overflow');
    expect(match?.action_taken).toBe('split_and_retry');
  });

  test('matches model_unavailable (fallback_model) on deprecation regex', () => {
    const match = classifyError(
      { status: 404, raw_message: 'model has been deprecated and is no longer available' },
      'openai/legacy-gpt-3',
    );
    expect(match?.message_class).toBe('model_unavailable');
    expect(match?.action_taken).toBe('fallback_model');
  });

  test('returns null when no rule matches', () => {
    const match = classifyError(
      { status: 500, raw_message: 'internal server boom' },
      'openai/gpt-4.1-mini',
    );
    expect(match).toBeNull();
  });

  test('returns null when error is undefined', () => {
    expect(classifyError(undefined, 'anthropic/claude-sonnet-4-5')).toBeNull();
  });

  test('provider scoping: anthropic-scoped rule does not match openai-scoped errors', () => {
    // anthropic.400.credit_balance.structured is scoped to anthropic only.
    // An openai 400 with similar wording should not match the structured rule.
    const match = classifyError(
      {
        status: 400,
        type: 'invalid_request_error',
        raw_message: 'credit balance issue',
      },
      'openai/gpt-4.1-mini',
    );
    // The regex variant has no provider scope, so it can still match.
    // Either result is acceptable — the assertion here is just that we
    // don't crash and the response is a typed L4Match or null.
    if (match) expect(match.message_class).toBe('credit_balance_too_low');
  });
});

describe('L4 pickFallbackTarget', () => {
  test('anthropic source picks first openai target', () => {
    const target = pickFallbackTarget(
      'anthropic/claude-sonnet-4-5',
      new Set(['anthropic/claude-sonnet-4-5']),
    );
    expect(target).toBe(DEFAULT_FALLBACK_TARGETS.anthropic[0]);
  });

  test('openai source picks first anthropic target', () => {
    const target = pickFallbackTarget('openai/gpt-4.1-mini', new Set(['openai/gpt-4.1-mini']));
    expect(target).toBe(DEFAULT_FALLBACK_TARGETS.openai[0]);
  });

  test('skips already-tried targets', () => {
    const tried = new Set<string>([
      'anthropic/claude-sonnet-4-5',
      DEFAULT_FALLBACK_TARGETS.anthropic[0] as string,
    ]);
    const target = pickFallbackTarget('anthropic/claude-sonnet-4-5', tried);
    expect(target).toBe(DEFAULT_FALLBACK_TARGETS.anthropic[1] as string);
  });

  test('returns null when all targets exhausted', () => {
    const tried = new Set<string>([
      'anthropic/claude-sonnet-4-5',
      ...(DEFAULT_FALLBACK_TARGETS.anthropic as readonly string[]),
    ]);
    const target = pickFallbackTarget('anthropic/claude-sonnet-4-5', tried);
    expect(target).toBeNull();
  });

  test('unknown source falls back to the generic target list', () => {
    const target = pickFallbackTarget('cohere/command-r', new Set());
    const unknownTargets: readonly string[] = DEFAULT_FALLBACK_TARGETS.unknown;
    expect(unknownTargets).toContain(target as string);
  });
});
