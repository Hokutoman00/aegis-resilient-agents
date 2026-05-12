// MCP tool call execution with classification-aware resilience.
//
// READ_HEDGE  → race two callers from the start; faster wins, slower canceled.
// WRITE_TIED  → fire primary; on timeout, retry with secondary + idempotency key.
// UNKNOWN_TIED → conservative default == WRITE_TIED.

import { ulid } from 'ulid';
import { classifyTool } from './classifier.js';
import type { MCPCallContext, MCPCallResult, MCPCaller, MCPHedgeRecord } from './types.js';

export interface MCPHedgeConfig {
  primary: MCPCaller;
  secondary?: MCPCaller;
  primaryName: string;
  secondaryName?: string;
  tied_timeout_ms?: number; // for WRITE_TIED / UNKNOWN_TIED retry
}

export interface MCPExecutionInput {
  tool: { name: string; description?: string; 'x-aegis-idempotent'?: boolean };
  args: Record<string, unknown>;
}

export interface MCPExecutionOutput {
  result: MCPCallResult;
  record: MCPHedgeRecord;
}

export async function executeMCPCall(
  input: MCPExecutionInput,
  config: MCPHedgeConfig,
): Promise<MCPExecutionOutput> {
  const classification = classifyTool(input.tool);

  if (classification.klass === 'READ_HEDGE' && config.secondary && config.secondaryName) {
    return raceReadHedge(input, config, classification);
  }

  return tiedWriteOrUnknown(input, config, classification);
}

async function raceReadHedge(
  input: MCPExecutionInput,
  config: MCPHedgeConfig,
  classification: ReturnType<typeof classifyTool>,
): Promise<MCPExecutionOutput> {
  const ctxA: MCPCallContext = {
    tool: input.tool,
    args: input.args,
    caller_name: config.primaryName,
  };
  const ctxB: MCPCallContext = {
    tool: input.tool,
    args: input.args,
    caller_name: config.secondaryName ?? 'secondary',
  };

  // Both legs start now — race semantics.
  const racedStart = Date.now();
  const promiseA = config.primary(ctxA);
  // biome-ignore lint/style/noNonNullAssertion: secondary is checked by caller above
  const promiseB = config.secondary!(ctxB);

  // Race the two: whichever resolves first wins. If the winner is OK,
  // we still let the loser settle (no real network cancellation primitive
  // for a generic caller — losing callers should respect their own
  // deadlines). The "loser_canceled_ms" metric records the slower side's
  // total latency relative to the winner's finish.
  type Settled = { result: MCPCallResult; side: 'primary' | 'secondary' };
  const wrapped: Promise<Settled>[] = [
    promiseA.then((r) => ({ result: r, side: 'primary' as const })),
    promiseB.then((r) => ({ result: r, side: 'secondary' as const })),
  ];

  // Race for the first OK: if the first settled is OK, take it. If it errors,
  // give the other side a chance to succeed within tied_timeout_ms. This is
  // the LLM-domain adaptation of Tail-at-Scale hedging — we prefer "first
  // useful response" over "first response."
  const first = await Promise.race(wrapped);
  let winner: Settled = first;

  if (!first.result.ok) {
    const otherPromise = first.side === 'primary' ? promiseB : promiseA;
    const otherSettled = await Promise.race([
      otherPromise.then((r) => ({
        settled: true,
        value: {
          result: r,
          side: first.side === 'primary' ? ('secondary' as const) : ('primary' as const),
        },
      })),
      new Promise<{ settled: false }>((res) =>
        setTimeout(() => res({ settled: false }), config.tied_timeout_ms ?? 5_000),
      ),
    ]);
    if (otherSettled.settled && otherSettled.value.result.ok) {
      winner = otherSettled.value;
    }
  }

  // Loser metric: wait for the loser (bounded), record relative latency.
  const loserSide = winner.side === 'primary' ? 'secondary' : 'primary';
  const loserPromise = loserSide === 'primary' ? promiseA : promiseB;
  const loserResult = await Promise.race([
    loserPromise.then((r) => ({ settled: true, result: r })),
    new Promise<{ settled: false }>((res) =>
      setTimeout(() => res({ settled: false }), config.tied_timeout_ms ?? 5_000),
    ),
  ]);

  const winnerLatency = winner.result.latency_ms;
  const loserCanceledMs = loserResult.settled
    ? Math.max(0, loserResult.result.latency_ms - winnerLatency)
    : Math.max(0, Date.now() - racedStart - winnerLatency);

  const record: MCPHedgeRecord = {
    tool: input.tool.name,
    classification,
    servers_raced: [config.primaryName, config.secondaryName ?? 'secondary'],
    winner: winner.side === 'primary' ? config.primaryName : (config.secondaryName ?? 'secondary'),
    winner_latency_ms: winnerLatency,
    loser_canceled_ms: loserCanceledMs,
    outcome: winner.result.ok ? 'success' : 'error',
  };

  return { result: winner.result, record };
}

async function tiedWriteOrUnknown(
  input: MCPExecutionInput,
  config: MCPHedgeConfig,
  classification: ReturnType<typeof classifyTool>,
): Promise<MCPExecutionOutput> {
  const idempotency_key = ulid();
  const primaryCtx: MCPCallContext = {
    tool: input.tool,
    args: input.args,
    idempotency_key,
    caller_name: config.primaryName,
  };

  const primaryStart = Date.now();
  const primaryResult = await Promise.race([
    config.primary(primaryCtx),
    new Promise<MCPCallResult>((_, rej) =>
      setTimeout(() => rej(new Error('p95_timeout')), config.tied_timeout_ms ?? 5_000),
    ),
  ]).catch(
    (err): MCPCallResult => ({
      ok: false,
      error: { message: err?.message ?? 'unknown', code: 'timeout' },
      caller_name: config.primaryName,
      latency_ms: Date.now() - primaryStart,
    }),
  );

  // If primary OK, return.
  if (primaryResult.ok) {
    return {
      result: primaryResult,
      record: {
        tool: input.tool.name,
        classification,
        winner: config.primaryName,
        winner_latency_ms: primaryResult.latency_ms,
        idempotency_key,
        outcome: 'success',
      },
    };
  }

  // Primary failed/timed out. Fall back to secondary with the same
  // idempotency key so a server that respects it won't double-execute.
  if (!config.secondary || !config.secondaryName) {
    return {
      result: primaryResult,
      record: {
        tool: input.tool.name,
        classification,
        winner: config.primaryName,
        winner_latency_ms: primaryResult.latency_ms,
        idempotency_key,
        outcome: 'error',
      },
    };
  }

  const secondaryCtx: MCPCallContext = {
    tool: input.tool,
    args: input.args,
    idempotency_key,
    caller_name: config.secondaryName,
  };
  const secondaryResult = await config.secondary(secondaryCtx);

  return {
    result: secondaryResult,
    record: {
      tool: input.tool.name,
      classification,
      winner: secondaryResult.ok ? config.secondaryName : config.primaryName,
      winner_latency_ms: secondaryResult.ok ? secondaryResult.latency_ms : primaryResult.latency_ms,
      fallback_used: true,
      fallback_latency_ms: secondaryResult.latency_ms,
      idempotency_key,
      outcome: secondaryResult.ok ? 'success' : 'error',
    },
  };
}
