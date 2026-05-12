// MCP tool classifier.
//
// Naively hedging an MCP tool call would double-fire WRITE_* operations:
// send_email twice, create_record twice, delete_file twice. Aegis therefore
// classifies every tool call before deciding on a resilience strategy.
//
// Three classes, derived in priority order:
//
//   READ_HEDGE   — safe to fire to two MCP servers in parallel; first response wins
//   WRITE_TIED   — fire to one server; on p95 timeout, retry with an idempotency-key header
//   UNKNOWN_TIED — same as WRITE_TIED by default (conservative)
//
// Detection priority:
//   1. Explicit annotation in the tool definition (`x-aegis-idempotent: true|false`).
//      This is the Aegis-proposed convention; if it shows up upstream, prefer it.
//   2. Name pattern: `^(get|read|search|list|query|find|fetch|describe|count)_`
//      → READ_HEDGE.
//   3. Name pattern: `^(create|send|delete|update|post|put|patch|remove|insert|move|rename)_`
//      → WRITE_TIED.
//   4. Otherwise: UNKNOWN_TIED.

export type MCPToolClass = 'READ_HEDGE' | 'WRITE_TIED' | 'UNKNOWN_TIED';

export interface MCPToolDef {
  name: string;
  description?: string;
  // The Aegis-proposed annotation. Optional. If `true` => READ_HEDGE.
  // If `false` => WRITE_TIED. If absent => fall through to name patterns.
  'x-aegis-idempotent'?: boolean;
}

export interface MCPClassification {
  klass: MCPToolClass;
  source: 'annotation' | 'name_pattern' | 'default';
  matched_pattern?: string;
}

const READ_PREFIXES = [
  'get_',
  'read_',
  'search_',
  'list_',
  'query_',
  'find_',
  'fetch_',
  'describe_',
  'count_',
];
const WRITE_PREFIXES = [
  'create_',
  'send_',
  'delete_',
  'update_',
  'post_',
  'put_',
  'patch_',
  'remove_',
  'insert_',
  'move_',
  'rename_',
];

export function classifyTool(tool: MCPToolDef): MCPClassification {
  // 1. Explicit annotation wins.
  const explicit = tool['x-aegis-idempotent'];
  if (explicit === true) return { klass: 'READ_HEDGE', source: 'annotation' };
  if (explicit === false) return { klass: 'WRITE_TIED', source: 'annotation' };

  const name = tool.name.toLowerCase();

  // 2. Read-side name patterns.
  for (const p of READ_PREFIXES) {
    if (name.startsWith(p)) {
      return { klass: 'READ_HEDGE', source: 'name_pattern', matched_pattern: p };
    }
  }

  // 3. Write-side name patterns.
  for (const p of WRITE_PREFIXES) {
    if (name.startsWith(p)) {
      return { klass: 'WRITE_TIED', source: 'name_pattern', matched_pattern: p };
    }
  }

  // 4. Conservative default.
  return { klass: 'UNKNOWN_TIED', source: 'default' };
}

export interface MCPHedgePolicy {
  klass: MCPToolClass;
  fire_in_parallel: boolean; // true for READ_HEDGE; false for TIED variants
  retry_with_idempotency_key: boolean; // true for WRITE_TIED + UNKNOWN_TIED
  description: string;
}

export function hedgePolicyFor(klass: MCPToolClass): MCPHedgePolicy {
  switch (klass) {
    case 'READ_HEDGE':
      return {
        klass,
        fire_in_parallel: true,
        retry_with_idempotency_key: false,
        description:
          'Read-side tool. Fire to two MCP servers in parallel; whichever responds first wins.',
      };
    case 'WRITE_TIED':
      return {
        klass,
        fire_in_parallel: false,
        retry_with_idempotency_key: true,
        description:
          'Write-side tool. Fire to one MCP server. On p95 timeout, retry with idempotency key.',
      };
    case 'UNKNOWN_TIED':
      return {
        klass,
        fire_in_parallel: false,
        retry_with_idempotency_key: true,
        description: 'Unclassified tool. Conservative default: same handling as WRITE_TIED.',
      };
  }
}
