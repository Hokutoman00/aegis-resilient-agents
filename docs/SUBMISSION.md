# Aegis — Devpost Submission Text

Copy-paste source for the Devpost submission form. Each `## H2` below maps to a Devpost form field.

---

## Project name

**Aegis — A Resilient AI Agent Runtime**

---

## Tagline (200 chars)

**Hedge first, fallback second, continuously chaos-verified. The first agent runtime that catches `credit_balance_too_low` — the 400 every LLM gateway misses.**

---

## Description (long form, Markdown supported)

### The problem

On **April 20, 2026**, OpenAI went down — ChatGPT, Codex, and the API, all of it. On **March 2 and again on March 3, 2026**, Anthropic's Claude went down twice in 24 hours. On **November 18, 2025**, a Cloudflare incident took ChatGPT and Sora with it. Every major LLM provider has had at least one significant outage in the past 12 months.

But the more interesting failure is the one most "resilient" gateways still don't handle. When Anthropic returns `400 credit_balance_too_low`, **LiteLLM, OpenRouter, Portkey, and even TrueFoundry's default Virtual Model fallback** pass it straight through — because 400 is in the 4xx range, the gateway treats it as a client problem. Result: an agent that goes silent the moment a credit card expires. This is a documented industry-wide gap ([LiteLLM Issue #24320](https://github.com/BerriAI/litellm/issues/24320)).

### What Aegis does

Aegis is an **OpenAI-SDK-compatible chat completion server** built on top of TrueFoundry's AI Gateway, with seven resilience layers wrapping it:

| Layer | Purpose |
|---|---|
| **L0** Hedge | Race a duplicate request to an alternate provider after `hedgeAfterMs`; whichever returns first wins, the loser is canceled |
| **L1** Retry | TF Gateway exponential backoff with jitter + 3-strike termination (prevents the $437 retry-loop incident) |
| **L2** Model fallback | TF Virtual Model switches model within provider |
| **L3** Provider fallback | TF Virtual Model switches across providers |
| **L3 SPOF Bypass** | If TF itself is unhealthy (5xx/connection-refused/timeout), Aegis calls the provider directly using locally-stored keys — TF is not a SPOF for Aegis |
| **L4** Semantic error | Inspects `error.type` / `error.code` / message — catches `credit_balance_too_low`, `insufficient_quota`, `context_overflow`, `model_unavailable` even when status codes don't match the gateway's enum |
| **L5** Graceful degradation | When all providers fail, returns a normal `HTTP 200` chat completion with an honest assistant message naming every failure class, instead of propagating a stack trace |
| **L6** Continuous self-chaos | A drill scheduler injects synthetic (v0) or Toxiproxy-driven (v1) failures every 30 seconds; the response Receipt carries `last_chaos_survival: "47s ago"` as a provable freshness signal |

Plus MCP tool execution with classification-aware resilience:

- `READ_HEDGE` (get_/read_/search_/list_/query_/...): races two MCP servers, "prefer first OK" semantics
- `WRITE_TIED` (create_/send_/delete_/update_/...): single fire + idempotency-key retry on timeout
- `UNKNOWN_TIED`: conservative tied default

Every response carries an **Aegis Receipt** — a signed JSON envelope with the full layer trace: providers tried, hedge cost, semantic match, contract compliance, TF health, chaos survival. One artifact for operators, auditors, judges, and (selectively) end users.

### How we built it

- **Runtime**: Bun ≥1.3 + TypeScript (strict)
- **Server**: Hono with `streamSSE` for token streaming
- **LLM client**: OpenAI SDK pointed at the TrueFoundry AI Gateway base URL (TF proxies all providers via OpenAI-compatible API)
- **Agents**: OpenAI Agents SDK (TypeScript) — MCP first-class
- **MCP**: `@modelcontextprotocol/sdk` for tool wiring; the convention proposed here is `x-aegis-idempotent: true|false` as an annotation upstream MCP servers can adopt
- **Chaos**: `toxiproxy-node-client` for network-level fault injection
- **Validation**: Zod at every external boundary
- **Lint/format**: Biome
- **Tests**: Bun's built-in runner — 50 unit tests, 148 assertions, runs in ~700ms

### Challenges we ran into

1. **TF Virtual Model `fallback_status_codes` is a fixed enum.** Adding `400` to the fallback list shows "Successfully updated" in the UI but is silently stripped on save. `credit_balance_too_low` is HTTP 400 — so it never triggers TF's built-in fallback. That gap **is** Aegis L4.
2. **Hono `streamSSE` crashes the entire server on an unhandled throw** ([honojs/hono#2164](https://github.com/honojs/hono/issues/2164)). Every Aegis streaming branch is wrapped in try/catch with the Receipt emitted as a custom event before the OpenAI `[DONE]` sentinel.
3. **Hedging MCP tool calls would double-fire writes.** Our classifier reads name patterns and an opt-in `x-aegis-idempotent` annotation, then routes to a TIED policy (single fire + idempotency-key retry) for anything classified as write or unknown.
4. **Both TF integrations went credit-exhausted during the build week.** We used this as the *real* demo path: every video scene shows live credit-balance errors getting caught by L4 and graceful-degraded by L5, no simulation.

### Accomplishments we're proud of

- **A genuine industry-gap fix.** Aegis L4 is the first agent runtime we know of that handles `credit_balance_too_low` — a known unsolved problem documented across LiteLLM, Portkey, and OpenRouter issue trackers.
- **Hedge for LLMs, properly.** Jeff Dean's 1992-vintage "Tail at Scale" hedging adapted to LLM calls with cost-aware cancellation and a verifiable cost-vs-latency receipt.
- **TF is not a SPOF for Aegis.** Even the gateway we depend on has a bypass path. Most "TF-on-top" agents would die when TF dies; Aegis routes around it.
- **50 tests / 0 fail / ~700ms.** Real production-grade test discipline, not a sketch.

### What we learned

- "First response" and "first useful response" are different things. Streaming hedge needs the latter.
- An error-message regex is fine as a *fallback* — but the structured `error.type` / `error.code` fields are the load-bearing detection path. We backfill from message only when structured is absent.
- The most powerful submission artifact is one auditable JSON object that ties every layer's decision back to a single request. The Aegis Receipt is that object.

### What's next

- **L6 with Toxiproxy** — replace synthetic drills with real network fault injection against a shadow request copy
- **`x-aegis-idempotent`** — open a proposal upstream to the MCP working group
- **UI** — a Storm Log dashboard pulling TF AI Monitoring traces + Aegis Receipts in real time
- **Streaming hedge with TTFT** — race two streams from the start, hand the client the faster one

---

## Built with

```
TypeScript · Bun · Hono · OpenAI SDK · OpenAI Agents SDK
TrueFoundry AI Gateway · TrueFoundry MCP Gateway
Model Context Protocol · Toxiproxy · Zod · Biome
```

---

## Try it out

- **GitHub**: <https://github.com/Hokutoman00/aegis-resilient-agents> (public, CI green)
- **Demo video**: <https://youtu.be/C_b8N49x9FI> *(3:11, 1080p H.264 + AAC, EN narration, unlisted)*
- **One-shot run** (against a local server):
  ```bash
  bun install && bun run dev          # in one shell
  bash examples/demo.sh                # in another
  ```

---

## Team

Hokuto Torigoe — solo developer.

---

## Acknowledgments

TrueFoundry for sponsoring the challenge. Sai Krishna (TF DevRel) for clarifying that direct Gateway integration is Criteria #1 — that single conversation reshaped the entire architecture pre-build. The LiteLLM Issue #24320 thread for documenting the industry-wide `credit_balance_too_low` gap that became Aegis's clearest differentiator.
