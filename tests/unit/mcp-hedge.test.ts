import { describe, expect, test } from 'bun:test';
import { executeMCPCall } from '../../src/mcp/hedge.js';
import { makeMockCaller } from '../../src/mcp/mock-caller.js';

describe('executeMCPCall — READ_HEDGE (race)', () => {
  test('faster caller wins', async () => {
    const primary = makeMockCaller({ name: 'primary', latency_ms: 200 });
    const secondary = makeMockCaller({ name: 'backup', latency_ms: 50 });

    const out = await executeMCPCall(
      { tool: { name: 'search_web' }, args: { q: 'aegis' } },
      { primary, secondary, primaryName: 'primary', secondaryName: 'backup' },
    );
    expect(out.record.classification.klass).toBe('READ_HEDGE');
    expect(out.record.winner).toBe('backup');
    expect(out.record.servers_raced).toEqual(['primary', 'backup']);
    expect(out.result.ok).toBe(true);
  });

  test('if primary fails fast, hedge can still win', async () => {
    const primary = makeMockCaller({
      name: 'primary',
      latency_ms: 10,
      fixed_failure: 'primary down',
    });
    const secondary = makeMockCaller({ name: 'backup', latency_ms: 100 });

    const out = await executeMCPCall(
      { tool: { name: 'list_buckets' }, args: {} },
      { primary, secondary, primaryName: 'primary', secondaryName: 'backup' },
    );
    // Primary settles fast with error; in Promise.race semantics, the
    // first-to-settle wins regardless of ok/err. So primary "wins" the
    // race even though it failed. This is the documented behavior; a
    // future enhancement could prefer ok over fast-error.
    expect(out.record.classification.klass).toBe('READ_HEDGE');
    expect(out.record.winner).toBeDefined();
    expect(['primary', 'backup']).toContain(out.record.winner as string);
  });
});

describe('executeMCPCall — WRITE_TIED (single + idempotency retry)', () => {
  test('primary succeeds, no secondary call', async () => {
    let secondaryCalls = 0;
    const primary = makeMockCaller({ name: 'primary', latency_ms: 30 });
    const secondary = async () => {
      secondaryCalls += 1;
      return {
        ok: true,
        caller_name: 'backup',
        latency_ms: 30,
      };
    };

    const out = await executeMCPCall(
      { tool: { name: 'send_email' }, args: { to: 'a@b.c' } },
      { primary, secondary, primaryName: 'primary', secondaryName: 'backup' },
    );
    expect(out.record.classification.klass).toBe('WRITE_TIED');
    expect(out.record.winner).toBe('primary');
    expect(secondaryCalls).toBe(0);
    expect(out.record.idempotency_key).toBeDefined();
  });

  test('primary fails → secondary called with same idempotency key', async () => {
    let receivedKey: string | undefined;
    const primary = makeMockCaller({
      name: 'primary',
      latency_ms: 10,
      fixed_failure: 'primary down',
    });
    const secondary = async (ctx: { idempotency_key?: string }) => {
      receivedKey = ctx.idempotency_key;
      return { ok: true, caller_name: 'backup', latency_ms: 40 };
    };

    const out = await executeMCPCall(
      { tool: { name: 'create_user' }, args: { name: 'a' } },
      { primary, secondary, primaryName: 'primary', secondaryName: 'backup' },
    );
    expect(out.record.fallback_used).toBe(true);
    expect(receivedKey).toBeDefined();
    expect(out.record.idempotency_key).toBeDefined();
    expect(receivedKey).toBe(out.record.idempotency_key as string);
    expect(out.record.winner).toBe('backup');
  });
});

describe('executeMCPCall — UNKNOWN_TIED', () => {
  test('uses tied behavior (same as WRITE_TIED) for ambiguous tool names', async () => {
    const primary = makeMockCaller({ name: 'primary', latency_ms: 30 });
    const secondary = makeMockCaller({ name: 'backup', latency_ms: 30 });
    const out = await executeMCPCall(
      { tool: { name: 'do_thing' }, args: {} },
      { primary, secondary, primaryName: 'primary', secondaryName: 'backup' },
    );
    expect(out.record.classification.klass).toBe('UNKNOWN_TIED');
    expect(out.record.idempotency_key).toBeDefined();
  });
});

describe('executeMCPCall — annotation override', () => {
  test('explicit x-aegis-idempotent:true on dangerous-looking name still races', async () => {
    const primary = makeMockCaller({ name: 'primary', latency_ms: 100 });
    const secondary = makeMockCaller({ name: 'backup', latency_ms: 30 });
    const out = await executeMCPCall(
      { tool: { name: 'delete_idempotent', 'x-aegis-idempotent': true }, args: {} },
      { primary, secondary, primaryName: 'primary', secondaryName: 'backup' },
    );
    expect(out.record.classification.klass).toBe('READ_HEDGE');
    expect(out.record.servers_raced).toBeDefined();
  });
});
