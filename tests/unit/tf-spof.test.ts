import { describe, expect, test } from 'bun:test';
import { isInfrastructureError } from '../../src/aegis/tf-spof.js';

describe('isInfrastructureError', () => {
  test('detects ECONNREFUSED', () => {
    expect(isInfrastructureError({ code: 'ECONNREFUSED', message: 'connection refused' })).toBe(
      true,
    );
  });

  test('detects ECONNRESET / ETIMEDOUT / EAI_AGAIN / ENOTFOUND', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND']) {
      expect(isInfrastructureError({ code })).toBe(true);
    }
  });

  test('detects code on err.cause', () => {
    expect(isInfrastructureError({ cause: { code: 'ECONNREFUSED' } })).toBe(true);
  });

  test('detects HTTP 502 / 504', () => {
    expect(isInfrastructureError({ status: 502 })).toBe(true);
    expect(isInfrastructureError({ status: 504 })).toBe(true);
  });

  test('detects bad-gateway message hint', () => {
    expect(isInfrastructureError({ message: 'TF returned 502 Bad Gateway' })).toBe(true);
  });

  test('does NOT trigger on provider errors (Anthropic 400 / OpenAI 429)', () => {
    expect(
      isInfrastructureError({
        status: 400,
        error: { type: 'invalid_request_error', message: 'credit balance too low' },
      }),
    ).toBe(false);
    expect(
      isInfrastructureError({
        status: 429,
        error: { code: 'insufficient_quota', message: 'quota exceeded' },
      }),
    ).toBe(false);
  });

  test('does NOT trigger on 5xx that is NOT 502/504 (some upstreams use 503 for "service busy")', () => {
    // 503 alone is conservative — we treat it as a provider issue unless TF
    // explicitly returns its own 503 with a clearly TF-shaped body. v0 stays
    // conservative: 503 doesn't bypass.
    expect(isInfrastructureError({ status: 503, error: { message: 'Service Unavailable' } })).toBe(
      false,
    );
  });

  test('does NOT trigger on plain unrelated errors', () => {
    expect(isInfrastructureError(new Error('something else'))).toBe(false);
    expect(isInfrastructureError({})).toBe(false);
    expect(isInfrastructureError(null)).toBe(false);
  });
});
