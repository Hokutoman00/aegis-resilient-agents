# Aegis — Architecture (v3)

This document specifies the 7 resilience layers, their invariants, and their degraded behaviors. The thesis is **"hedge first, fallback second, continuously chaos-verified."** See [../README.md](../README.md) for the elevator pitch.

## System overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Client (HTTP / SSE)                                                │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Aegis Server (Hono on Bun)                                         │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  L0 Hedge   ──┐                                              │   │
│  │  L4 Semantic │ → classify error, re-route                    │   │
│  │  L5 Contract │ → enforce budget/SLA, degrade explicitly      │   │
│  │  L6 Chaos    │ → shadow drill in background                  │   │
│  │  Receipt     │ → JSON envelope appended to every response    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ (preferred path: via TF Gateway)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TrueFoundry AI Gateway                                             │
│    L1 Retry / L2 Model fallback / L3 Provider fallback              │
│    AI Monitoring (OTel) ──┐                                         │
│    MCP Gateway ────────────┤                                        │
└──────────────────────────┬┘──────────────────────────────────────────┘
                           │                                ┌─────────┘
              ┌────────────┴────────────┐                   │
              ▼                         ▼                   ▼
   ┌──────────────────┐      ┌─────────────────┐   ┌────────────────┐
   │ LLM Providers    │      │ MCP Servers     │   │ Aegis Receipt  │
   │ - Anthropic      │      │ - Search        │   │ (trace pull)   │
   │ - OpenAI         │      │ - Filesystem    │   │                │
   │ - Google         │      │ - Browser       │   │                │
   └──────────────────┘      └─────────────────┘   └────────────────┘
                           ▲
                           │ (fallback path: direct, only if TF unreachable)
                           │
              ┌────────────┴──────┐
              │  L3 SPOF Bypass   │  Aegis → Provider direct
              └───────────────────┘  (env-stored provider keys)
```

## The 7 layers

Each layer has an **invariant** (the assumption it depends on), a **monitor** (how Aegis checks the invariant), and a **degraded behavior** (what to do when the invariant breaks).

### L0 — Hedge

**Job.** Send a duplicate request to a second provider when the first has not produced a first token (TTFT) within p95 latency. Whichever responds first wins; the loser is canceled.

**Why.** Most "resilient" gateways are *reactive* — they fall back only after a failure. By the time fallback triggers, the user has already waited. Hedging is *proactive*: race two providers from the start of latency anomalies.

**Math.** With p95 = 1.5s, hedge rate ≈ 5% of requests fire a hedge. Cancellation rate ≈ 70% (most hedges are canceled before generating substantial output). For Claude Sonnet 4.5 ($0.003/1k output tokens, 200 tokens typical):

```
extra cost per request = 5% × 200 × $0.003/1k × (1 - 70%) = $0.0000009
```

For 1M requests/day, hedge adds **~$9/day** while improving p99 for ~4% of requests from p99 to p50.

**Invariant.** `hedge_cost < latency_benefit`. Monitored per-call in the Receipt.

**Degraded behavior.** Token-bucket cap. If hedge rate exceeds threshold (e.g., 15% over 60s — sign of correlated provider degradation), reduce hedge probability adaptively. During total outage, drop hedge entirely so we don't amplify load.

### L1 — Retry

**Job.** Exponential backoff with jitter on transient errors (HTTP 5xx, network errors, timeout).

**Owner.** TrueFoundry AI Gateway (configured at the Virtual Model).

**Default policy.** 3 attempts, base = 1s, max = 8s, jitter = ±25%. Plus a hard **3-strike termination** to prevent the [$437 retry-loop incident](https://dev.to/waxell/ai-agent-circuit-breakers-the-reliability-pattern-production-teams-are-missing-5bpg) (April 2026, AI agent ran 8 hours of retries).

**Invariant.** Retried operation is non-destructive. For LLM calls this is true by construction; for MCP tool calls it depends on the tool. See L0 MCP classification below.

### L2 — Model fallback

**Job.** Within a single provider, fall back to a different model on capability errors (e.g., context too long → bigger context model; image unsupported → multimodal model).

**Owner.** TF Virtual Model rules.

### L3 — Provider fallback

**Job.** Across providers, fall back when the primary provider returns a status code in the configured fallback set.

**Owner.** TF Virtual Model.

**Default set.** `[401, 403, 408, 429, 500, 502, 503]`.

**Known gap.** The set is enum-validated by TF and does *not* accept additions like `400`, `402`, or `504` (silent-strip on save). This means `400 credit_balance_too_low` does *not* trigger TF's fallback. Aegis L4 below closes that gap.

**Invariant.** TF Gateway itself is reachable. Monitored by per-call infrastructure-level error detection (TCP refusal, connection timeout, TF-own 5xx). When violated → **L3 SPOF bypass**: Aegis calls the next provider directly using locally-stored keys, bypassing TF until health returns.

### L4 — Semantic error fallback

**Job.** Inspect error responses the gateway didn't catch, classify them, and route appropriately.

**Detection priority.**

1. **Structured field.** Match on `error.type` (Anthropic) or `error.code` (OpenAI) — stable, intentional fields.
2. **Message regex.** Fallback to substring matching only if structured detection misses.

**Default rule table.**

```ts
[
  { provider: 'anthropic', status: 400, type: 'invalid_request_error',
    messageMatches: /credit balance/i,    action: 'fallback_provider' },
  { provider: 'openai',    status: 429, code: 'insufficient_quota',
    action: 'fallback_provider' },
  { provider: '*',         status: 400,
    messageMatches: /context.{0,20}too long|too many tokens/i,
    action: 'split_and_retry' },
  { provider: '*',         status: 400,
    messageMatches: /model.{0,20}(deprecated|not found|unavailable)/i,
    action: 'fallback_model' },
]
```

**Invariant.** Error formats are stable. Monitored by unhit-rule logging (any error response that doesn't match any rule is logged for review).

**Degraded behavior.** Unknown errors propagate to L5 (graceful degradation) rather than crashing the request.

### L5 — Graceful degradation contract

**Job.** Honor an explicit per-request user contract: max latency, max cost, minimum quality (model tier).

**Contract shape.**

```ts
type Contract = {
  latency_budget_ms: number;   // e.g., 5000
  cost_budget_usd:   number;   // e.g., 0.05
  quality_floor:     'haiku' | 'sonnet' | 'opus' | 'gpt-4-mini' | 'gpt-4';
}
```

**Behavior.**

- Track current latency / cost during the request lifecycle.
- If breaching the budget seems likely (e.g., L1 retry would push past `latency_budget_ms`), **degrade explicitly**: drop to a smaller model, return a partial answer, or return a deliberate "I can't right now, here's why" response.
- The Receipt always shows which budget was breached, by how much, and what the degraded response was.

**Invariant.** User contract is met. Monitored by the per-request budget tracker.

### L6 — Continuous self-chaos (shadow)

**Job.** Continuously verify Aegis's own resilience by injecting failures into a shadow copy of real production requests.

**Operation.**

```
real request → response (clean) → user
            ↓ (parallel)
shadow copy → Toxiproxy chaos toxic → response (test) → discard, compare metrics
```

**Toxics rotated:**

- `latency` (add 2-5s delay to provider)
- `timeout` (drop connection)
- `bandwidth` (throttle)
- TF returns `503`
- Provider returns `400 credit_balance_too_low`
- MCP server returns 30% error rate

**Invariant.** Shadow chaos doesn't harm real users. Monitored by `shadow_output_divergence_metric` — if shadow and clean diverge beyond threshold for non-chaos reasons (= a real bug), auto-disable chaos and alert.

**Artifact in Receipt.** `last_chaos_survival: "47s ago"` — a continuously-updated freshness counter that any judge / auditor can verify.

## L0 MCP tool classification (preventing side-effect doubling)

Hedging MCP tool calls would *double-fire* writes (DB inserts, emails, API POSTs) if applied naively. Aegis classifies every MCP call before execution:

| Class | Detected via | Strategy |
|---|---|---|
| **READ_HEDGE** | tool name matches `get_*` / `read_*` / `search_*` / `list_*` / `query_*`, or tool definition contains `x-aegis-idempotent: true` | Race 2 MCP servers from start, first response wins |
| **WRITE_TIED** | tool name matches `create_*` / `send_*` / `delete_*` / `update_*` / `post_*` | Single server primary; on p95 timeout, retry with second server using **idempotency-key header** |
| **UNKNOWN_TIED** | no pattern match, no annotation | Same as WRITE_TIED (conservative default) |

The `x-aegis-idempotent` MCP annotation is an Aegis-proposed convention. Aegis ships a few pre-classified entries for the popular MCP servers (filesystem `read_file` → READ_HEDGE, `write_file` → WRITE_TIED, etc.) and the registry is config-overridable.

## Receipt

Every Aegis response carries a JSON envelope summarizing what happened. Schema: [RECEIPT.md](./RECEIPT.md).

The Receipt is the unified observable artifact that ties all layers together. Operators see it in logs; auditors see it for compliance; demos use it for transparency; users (when surfaced) see honest accounts of any degradation.

## TF SPOF bypass (L3 fall-through)

```
async function callLLM(req: ChatRequest): Promise<ChatResponse> {
  try {
    return await callViaTF(req);
  } catch (e) {
    if (isInfrastructureError(e)) {
      // TF itself returned 5xx or connection refused
      return await callDirectProvider(req);  // bypasses TF, uses env keys
    }
    throw e;  // provider error within TF — let L1-L3 handle
  }
}
```

`isInfrastructureError` distinguishes TF-own failures (TF Gateway 503, network refused) from provider failures relayed by TF. Only the former triggers bypass — provider failures stay within TF's L1-L3.

## Implementation order (5/11 onward)

1. Skeleton (Hono on Bun, `/health`, `/v1/chat/completions` proxying to TF)
2. L1-L3 working via TF Virtual Model
3. L4 semantic detection (rule table + structured-first matching)
4. Receipt v0 (provider trace + outcome)
5. L5 contract enforcement
6. L6 shadow chaos (Toxiproxy integration)
7. L0 LLM hedge
8. L0 MCP READ_HEDGE / WRITE_TIED classifier
9. TF SPOF bypass
10. UI (Storm Log, Health Strip) + Demo scenarios

## References

- Jeff Dean, Luiz Barroso. ["The Tail at Scale"](https://cseweb.ucsd.edu/classes/sp18/cse291-c/post/schedule/p74-dean.pdf) — hedged requests, tied requests.
- [LiteLLM Issue #24320](https://github.com/BerriAI/litellm/issues/24320) — industry-wide `credit_balance_too_low` fallback gap.
- [TF AI Gateway docs](https://www.truefoundry.com/docs/ai-gateway/openai-agents-sdk).
- [Hono streamSSE issue #2164](https://github.com/honojs/hono/issues/2164) — unhandled throw kills server, hence our try/catch convention.
- [Toxiproxy](https://github.com/Shopify/toxiproxy) — network failure injection for L6.
