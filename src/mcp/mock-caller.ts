// Mock MCP caller for tests and live /v1/mcp/call demo.
//
// Each mock caller has a configurable latency + failure rate. Useful for
// reproducing the demo Scene C ("MCP server fails mid-tool-call") without
// having to spin up real MCP servers behind Toxiproxy. The real-server
// integration lands in a subsequent commit and reuses the same Caller
// interface so wiring stays unchanged.

import type { MCPCallContext, MCPCallResult, MCPCaller } from './types.js';

export interface MockCallerConfig {
  name: string;
  latency_ms: number;
  fail_rate?: number; // 0..1; probability of returning ok:false
  fixed_failure?: string; // if set, deterministically fails with this message
  result_value?: unknown; // what to return as data on success
}

export function makeMockCaller(cfg: MockCallerConfig): MCPCaller {
  return async (ctx: MCPCallContext): Promise<MCPCallResult> => {
    const started = Date.now();
    await new Promise((res) => setTimeout(res, cfg.latency_ms));
    const latency_ms = Date.now() - started;

    if (cfg.fixed_failure) {
      return {
        ok: false,
        error: { message: cfg.fixed_failure, code: 'mock_fixed_failure' },
        caller_name: cfg.name,
        latency_ms,
      };
    }

    if (cfg.fail_rate && Math.random() < cfg.fail_rate) {
      return {
        ok: false,
        error: { message: 'mock random failure', code: 'mock_random' },
        caller_name: cfg.name,
        latency_ms,
      };
    }

    return {
      ok: true,
      data: cfg.result_value ?? {
        echo_tool: ctx.tool.name,
        echo_args: ctx.args,
        served_by: cfg.name,
        idempotency_key: ctx.idempotency_key,
      },
      caller_name: cfg.name,
      latency_ms,
    };
  };
}
