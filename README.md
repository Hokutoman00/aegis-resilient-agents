# Aegis — A Resilient AI Agent Runtime

[![Hackathon](https://img.shields.io/badge/DevNetwork_AI%2FML_Hackathon-2026-blue)](https://devnetwork-ai-ml-hack-2026.devpost.com/)
[![Challenge](https://img.shields.io/badge/TrueFoundry-Resilient_Agents-orange)](https://devnetwork-ai-ml-hack-2026.devpost.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

> **Hedge first, fallback second, continuously chaos-verified.**

On **April 20, 2026**, OpenAI went dark — ChatGPT, Codex, and the API platform, all of them, for hours. On **March 2-3, 2026**, Anthropic's Claude went down twice in 24 hours. On **November 18, 2025**, a Cloudflare incident took ChatGPT and Sora with it. Every major LLM provider has had at least one significant outage in the past 12 months.

Most "resilient" AI gateways — LiteLLM, OpenRouter, Portkey, even TrueFoundry's default Virtual Model fallback — **silently fail** on one of the most common production errors: Anthropic returning `400 credit_balance_too_low`. The HTTP code is in the 4xx range, so the gateway's fallback list (typically `[401, 403, 408, 429, 500, 502, 503]`) doesn't trigger. ([LiteLLM issue #24320](https://github.com/BerriAI/litellm/issues/24320) documents this gap across the industry.)

**Aegis is built on TrueFoundry's AI Gateway**, but doesn't trust it alone. Aegis adds seven layers of behavioral resilience and a verifiable runtime receipt, so an agent stays useful even when its dependencies — including its own gateway — break.

---

## The 7 layers

| Layer | Job | Owner | Invariant monitored |
|------:|---|---|---|
| **L0** | **Hedge** parallel requests on TTFT > p95 | Aegis | hedge cost < latency benefit (cost/latency receipt) |
| **L1** | **Retry** with exponential backoff + jitter | TF Gateway | retries are non-destructive (tool side-effect taxonomy) |
| **L2** | **Model fallback** within provider | TF Virtual Model | configured chain still has reachable models |
| **L3** | **Provider fallback** across providers | TF Virtual Model | TF Gateway itself is reachable (heartbeat) |
| **L4** | **Semantic error fallback** — error.type / .code | Aegis | error format stable (structured-first, regex fallback) |
| **L5** | **Graceful degradation contract** — budget / SLA / quality | Aegis | user contract is honored |
| **L6** | **Continuous self-chaos** in shadow | Aegis | chaos doesn't harm real users (output divergence monitored) |

Every response carries a signed **Aegis Receipt** — a JSON envelope showing which providers were tried, which layers fired, which contract budgets were spent, and how long ago Aegis last survived a chaos drill. See [docs/RECEIPT.md](./docs/RECEIPT.md).

## The differentiator: L4 catches what others miss

```
[2026-05-10 02:18:32]  user → Aegis → TF Virtual Model "claude-with-fallback"
[Aegis L0]             hedge fired (p95 = 1.5s exceeded)
[TF L1/L2]             anthropic/claude-sonnet-4.5 → 400 credit_balance_too_low
[TF L3]                fallback codes [401,403,...,503] don't include 400 → pass-through
[Aegis L4]             error.type=invalid_request_error + message="credit balance"
                       → reclassified as fallback-eligible
                       → routed to openai/gpt-4.1
[OpenAI]               200 OK, 320ms TTFT
[Aegis L0]             cancel hedge (cost saved: ~$0.0001)
[Aegis Receipt]        attached to response
```

This single error class (`credit_balance_too_low`) is what brings down most LLM apps the moment a credit card expires. Aegis is the first agent runtime to handle it.

## Demo scenarios (5/23-25 recording)

| # | Failure injected | Layers that fire | Visible UX |
|---|---|---|---|
| A | hedge race (p95 spike) | L0 only | "Hedge canceled in 80ms" annotation |
| B | Anthropic `credit_balance_too_low` 400 | L4 catches, routes to OpenAI | "Provider switched" + Receipt |
| C | MCP server (search) returns 30% errors | L0 MCP hedge (READ_HEDGE) wins | Slight latency, no error |
| D | TF Gateway itself returns 503 | TF SPOF bypass → direct provider | Receipt shows `tf_used: false` |
| E | All providers fail | L5 graceful contract + apologetic UX | Honest "I can't right now, but here's why" |
| F | Shadow chaos | L6 background drill | Receipt: `last_chaos_survival: 47s ago` |

All scenarios use [Toxiproxy](https://github.com/Shopify/toxiproxy) to inject *real* network failures, not mocked errors.

## Quick start

```bash
bun install
cp .env.example .env.local
# fill in TRUEFOUNDRY_API_KEY from https://aegis-hackathon.truefoundry.cloud/

bun run dev
# server: http://localhost:3000
# health: http://localhost:3000/health
# chat:   POST /v1/chat/completions  (OpenAI-compatible)
```

The `/v1/chat/completions` endpoint is OpenAI SDK-compatible. Drop-in for any code already using the OpenAI SDK — just point `base_url` at Aegis instead of `api.openai.com`.

## Tech stack

- **Runtime**: [Bun](https://bun.sh) (≥1.3) + TypeScript (strict)
- **Server**: [Hono](https://hono.dev/) (with `streamSSE` for token streaming)
- **LLM**: OpenAI SDK pointed at TrueFoundry AI Gateway base URL
- **Agents**: [OpenAI Agents SDK (TypeScript)](https://openai.github.io/openai-agents-js/) for tool orchestration
- **MCP**: [TrueFoundry MCP Gateway](https://www.truefoundry.com/mcp-gateway) for tool servers
- **Chaos**: [Toxiproxy](https://github.com/Shopify/toxiproxy) for real network failure injection
- **Observability**: TrueFoundry AI Monitoring (OTel-compatible) feeding the Aegis Receipt
- **Lint/format**: [Biome](https://biomejs.dev/)

## Docs

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — full 7-layer design, invariants, and degraded behaviors
- [docs/RECEIPT.md](./docs/RECEIPT.md) — Aegis Receipt JSON schema
- [AGENTS.md](./AGENTS.md) — coding-agent contract (conventions, no-go list, test commands)
- [docs/DEMO-SCRIPT.md](./docs/DEMO-SCRIPT.md) — 3-minute submission video plan (to be filled)

## Hackathon submission

| Field | Detail |
|---|---|
| Hackathon | [DevNetwork AI + ML Hackathon 2026](https://devnetwork-ai-ml-hack-2026.devpost.com/) |
| Challenge | TrueFoundry "Resilient Agents" ($1,500 + $500/$200 sponsor prize) |
| Submission deadline | 2026-05-28 PDT 10am |
| Team | Solo (Hokuto Torigoe) |

## Acknowledgments

TrueFoundry for sponsoring the challenge and Sai Krishna (TF DevRel) for clarifying that direct Gateway integration is Criteria #1. The [LiteLLM issue #24320 thread](https://github.com/BerriAI/litellm/issues/24320) for documenting the industry-wide `credit_balance_too_low` gap that Aegis L4 closes.

## License

MIT — see [LICENSE](./LICENSE).
