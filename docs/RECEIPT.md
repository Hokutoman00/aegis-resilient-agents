# Aegis Receipt — schema

Every Aegis response carries a Receipt: a JSON envelope summarizing what happened across all 7 resilience layers. The Receipt is the load-bearing observable artifact for Aegis — operators, auditors, demos, and (selectively) end users all read from it.

## Transport

- **Non-streaming (`/v1/chat/completions`).** Receipt is on the response as `_aegis_receipt` (sibling of `choices`).
- **Streaming (SSE).** Receipt is the **final SSE event** with `event: aegis.receipt`, sent just before the `data: [DONE]` terminator. Clients that don't read it lose nothing functional.

## Example

```json
{
  "version": "aegis-v3.0",
  "request_id": "01HWXY3K8VQS6N4MDPB7E9T2RJ",
  "started_at": "2026-05-11T18:42:01.183Z",
  "duration_ms": 850,

  "providers_tried": [
    {
      "name": "anthropic/claude-sonnet-4-5",
      "via": "tf",
      "outcome": "error",
      "error": { "status": 400, "type": "invalid_request_error",
                 "message_class": "credit_balance_too_low" },
      "ttft_ms": null,
      "total_ms": 420,
      "tokens": { "input": 24, "output": 0 }
    },
    {
      "name": "openai/gpt-4.1",
      "via": "tf",
      "outcome": "success",
      "ttft_ms": 320,
      "total_ms": 430,
      "tokens": { "input": 24, "output": 87 }
    }
  ],

  "layers_fired": ["L4"],

  "l0_hedge": {
    "fired": false,
    "trigger_threshold_ms": 1500,
    "canceled_at_ms": null,
    "extra_cost_usd": 0
  },

  "l4_semantic": {
    "matched_rule": "anthropic.400.invalid_request_error.credit_balance",
    "rule_source": "default",
    "action_taken": "fallback_provider"
  },

  "l5_contract": {
    "budgets": {
      "latency_ms":  { "spent": 850,    "limit": 2000   },
      "cost_usd":    { "spent": 0.0023, "limit": 0.05   }
    },
    "quality_floor": "sonnet",
    "actual_quality": "gpt-4.1",
    "honored": true,
    "degraded": false
  },

  "tf_health": {
    "reachable": true,
    "bypass_used": false,
    "last_heartbeat_ms": 47
  },

  "mcp_calls": [
    {
      "tool": "search_web",
      "classification": "READ_HEDGE",
      "servers_raced": ["scrapeless", "brave-search"],
      "winner": "scrapeless",
      "winner_latency_ms": 412,
      "loser_canceled_ms": 38
    }
  ],

  "l6_chaos": {
    "shadow_injected_this_request": false,
    "last_chaos_survival": {
      "seconds_ago": 47,
      "toxic": "anthropic_400_credit_balance",
      "outcome": "survived"
    },
    "shadow_divergence_ratio_24h": 0.003
  },

  "cost_usd_total": 0.0023,

  "signature": "aegis_v3:sha256:9f...3a"
}
```

## Field reference

### `version` (string)

Schema version. Currently `aegis-v3.0`. Bumped on any breaking schema change.

### `request_id` (string)

ULID, generated server-side. Used to correlate with TF AI Monitoring traces, logs, and the user-facing error UI.

### `started_at` (ISO 8601 datetime) / `duration_ms` (number)

Wall-clock start and end-to-end duration. Includes hedge time but does not include L6 shadow time.

### `providers_tried` (array)

Ordered list of provider attempts within this request, including failures.

| field | meaning |
|---|---|
| `name` | provider/model id as Aegis saw it |
| `via` | `tf` (default) or `direct` (L3 SPOF bypass active) |
| `outcome` | `success` / `error` / `canceled` / `timeout` |
| `error.status` | HTTP status (if outcome=error) |
| `error.type` | structured field from provider (e.g., `invalid_request_error`) |
| `error.message_class` | Aegis L4's normalization of the error message (e.g., `credit_balance_too_low`, `context_overflow`, `unknown`) |
| `ttft_ms` | time-to-first-token, or `null` if no tokens emitted |
| `total_ms` | total time on this attempt |
| `tokens` | input/output token counts |

### `layers_fired` (array of strings)

Which layers were active. Subset of `["L0", "L1", "L2", "L3", "L4", "L5", "L6"]`. Order is the firing order.

### `l0_hedge` (object)

```ts
{ fired: boolean, trigger_threshold_ms: number,
  canceled_at_ms: number | null, extra_cost_usd: number }
```

- `fired`: did the hedge launch?
- `canceled_at_ms`: if fired and won, the time at which the hedge was canceled (i.e., how much extra cost was avoided)
- `extra_cost_usd`: actual incurred cost from the hedge (tokens produced before cancellation)

### `l4_semantic` (object)

Which rule matched, where it came from (`default` / `user_config` / `learned`), and what action was taken (`fallback_provider` / `fallback_model` / `split_and_retry` / `pass_through`).

### `l5_contract` (object)

Budget tracking. Each budget shows spent vs limit. `honored: false` means at least one budget was exceeded; `degraded: true` means Aegis explicitly degraded (smaller model / partial answer / honest refusal) to stay within budget or to be honest about its failure.

### `tf_health` (object)

- `reachable`: did the TF Gateway respond at all this request?
- `bypass_used`: did Aegis bypass TF and call the provider directly?
- `last_heartbeat_ms`: age of the last successful TF heartbeat

### `mcp_calls` (array)

One entry per MCP tool call made during this request. Records the classification (READ_HEDGE / WRITE_TIED / UNKNOWN_TIED), which servers were involved, who won, and the per-side latencies.

### `l6_chaos` (object)

- `shadow_injected_this_request`: was this request's *shadow copy* given chaos? (Real path is always clean.)
- `last_chaos_survival`: when did Aegis last endure a chaos drill, what was the injected toxic, and what was the outcome (`survived` / `degraded` / `failed`)?
- `shadow_divergence_ratio_24h`: fraction of shadow/clean comparisons that diverged in the past 24h (high values = real bug, not chaos noise, → triggers chaos auto-disable)

### `cost_usd_total` (number)

Total cost incurred (LLM tokens × provider price). Includes hedge cost. Does not include L6 shadow cost (separate budget).

### `signature` (string)

HMAC-SHA256 of the canonical JSON serialization of the Receipt body (excluding `signature` itself), keyed with a per-deployment Aegis signing key. Lets external verifiers detect post-hoc tampering.

> Note: signature is honest, not authenticated. The key is server-side. Aegis is the issuer; it is not a third-party attestation. For real trust, pair with TF AI Monitoring traces and the request's TLS / mTLS chain.

## Reading the Receipt

| Stakeholder | What to look at |
|---|---|
| **End user** (when surfaced) | `l5_contract.honored`, `l5_contract.degraded`, the `error.message_class` if request failed |
| **Operator / oncall** | `tf_health`, `layers_fired`, `l6_chaos.shadow_divergence_ratio_24h` |
| **Auditor / compliance** | `signature`, `providers_tried[].via`, `cost_usd_total` |
| **Hackathon judge** | `layers_fired`, `l6_chaos.last_chaos_survival` (the "provable resilience" artifact) |

## Versioning

Aegis follows additive-only changes within a major version. New fields default to `null` / `false` / `0`. Removal or semantic shift bumps `version`.
