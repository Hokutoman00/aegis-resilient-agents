// MCP call types — generic over the actual transport (HTTP / stdio / TF MCP Gateway).
// Aegis hedges and tied-retries based on the classifier; the Caller is injected
// so we can demo with mock callers in tests and swap in real MCP clients later.

import type { MCPClassification, MCPToolDef } from './classifier.js';

export interface MCPCallContext {
  tool: MCPToolDef;
  args: Record<string, unknown>;
  idempotency_key?: string;
  // Caller identification (for the receipt — e.g. "scrapeless", "primary", "backup")
  caller_name: string;
}

export interface MCPCallResult {
  ok: boolean;
  data?: unknown;
  error?: { message: string; code?: string; status?: number };
  caller_name: string;
  latency_ms: number;
}

export type MCPCaller = (ctx: MCPCallContext) => Promise<MCPCallResult>;

export interface MCPHedgeRecord {
  tool: string;
  classification: MCPClassification;
  servers_raced?: string[];
  winner?: string;
  winner_latency_ms?: number;
  loser_canceled_ms?: number;
  fallback_used?: boolean;
  fallback_latency_ms?: number;
  idempotency_key?: string;
  outcome: 'success' | 'error';
}
