import { describe, expect, test } from 'bun:test';
import { ReceiptBuilder } from '../../src/receipt/builder.js';

describe('ReceiptBuilder', () => {
  test('produces a valid v0 receipt with defaults', () => {
    const b = new ReceiptBuilder();
    const r = b.build();
    expect(r.version).toBe('aegis-v3.0');
    expect(r.request_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID Crockford alphabet
    expect(r.providers_tried).toEqual([]);
    expect(r.layers_fired).toEqual([]);
    expect(r.cost_usd_total).toBe(0);
    expect(r.tf_health).toEqual({ reachable: true, bypass_used: false });
  });

  test('records a provider attempt and exposes it on build', () => {
    const b = new ReceiptBuilder();
    b.recordProvider({
      name: 'anthropic/claude-sonnet-4-5',
      via: 'tf',
      outcome: 'success',
      ttft_ms: 320,
      total_ms: 800,
      tokens: { input: 24, output: 87 },
    });
    const r = b.build();
    expect(r.providers_tried).toHaveLength(1);
    expect(r.providers_tried[0]?.name).toBe('anthropic/claude-sonnet-4-5');
    expect(r.providers_tried[0]?.outcome).toBe('success');
  });

  test('setL0Hedge accrues extra cost and fires L0 layer', () => {
    const b = new ReceiptBuilder();
    b.setL0Hedge({
      fired: true,
      trigger_threshold_ms: 1500,
      canceled_at_ms: 80,
      extra_cost_usd: 0.000045,
    });
    const r = b.build();
    expect(r.layers_fired).toContain('L0');
    expect(r.cost_usd_total).toBeCloseTo(0.000045);
    expect(r.l0_hedge?.fired).toBe(true);
  });

  test('setL4Match adds L4 to fired layers + backfills message_class', () => {
    const b = new ReceiptBuilder();
    b.recordProvider({
      name: 'anthropic/claude-sonnet-4-5',
      via: 'tf',
      outcome: 'error',
      error: { status: 400, raw_message: 'credit balance too low' },
      ttft_ms: null,
      total_ms: 500,
    });
    b.setL4Match({
      rule_id: 'anthropic.400.credit_balance.regex',
      rule_source: 'default',
      action_taken: 'fallback_provider',
      message_class: 'credit_balance_too_low',
    });
    const r = b.build();
    expect(r.layers_fired).toContain('L4');
    expect(r.providers_tried[0]?.error?.message_class).toBe('credit_balance_too_low');
    expect(r.l4_semantic?.rule_id).toBe('anthropic.400.credit_balance.regex');
  });

  test('setL5Contract adds L5 to fired layers', () => {
    const b = new ReceiptBuilder();
    b.setL5Contract({
      budgets: {},
      honored: true,
      degraded: true,
      degradation_reason: 'all_providers_failed (credit_balance_too_low)',
    });
    expect(b.build().layers_fired).toContain('L5');
  });

  test('setL6Chaos attaches the chaos record but does NOT fire L6 unless this request was shadowed', () => {
    const b = new ReceiptBuilder();
    b.setL6Chaos({
      shadow_injected_this_request: false,
      last_chaos_survival: null,
      total_drills: 5,
      survival_rate: 1,
    });
    expect(b.build().layers_fired).not.toContain('L6');

    const b2 = new ReceiptBuilder();
    b2.setL6Chaos({
      shadow_injected_this_request: true,
      last_chaos_survival: null,
      total_drills: 6,
      survival_rate: 1,
    });
    expect(b2.build().layers_fired).toContain('L6');
  });

  test('setTFHealth marks L3 fired only when bypass_used=true', () => {
    const b1 = new ReceiptBuilder();
    b1.setTFHealth({ reachable: true, bypass_used: false });
    expect(b1.build().layers_fired).not.toContain('L3');

    const b2 = new ReceiptBuilder();
    b2.setTFHealth({ reachable: false, bypass_used: true });
    expect(b2.build().layers_fired).toContain('L3');
  });

  test('build() output is JSON-serializable (no circular refs)', () => {
    const b = new ReceiptBuilder();
    b.recordProvider({
      name: 'anthropic/claude-sonnet-4-5',
      via: 'tf',
      outcome: 'success',
      ttft_ms: null,
      total_ms: 800,
    });
    const r = b.build();
    expect(() => JSON.stringify(r)).not.toThrow();
    // round-trip preserves shape
    const round = JSON.parse(JSON.stringify(r));
    expect(round.version).toBe(r.version);
    expect(round.providers_tried).toHaveLength(1);
  });
});
