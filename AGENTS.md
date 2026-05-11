# AGENTS.md — coding-agent contract

Single source of truth for any coding agent (Claude Code, Codex, Cursor, etc.) working in this repo. Read this first, every session.

## Mission

Build the most resilient AI agent runtime for the [DevNetwork AI/ML Hackathon 2026 — TrueFoundry Resilient Agents Challenge](https://devnetwork-ai-ml-hack-2026.devpost.com/). Submission deadline **2026-05-28 PDT 10am**.

The thesis is **"hedge first, fallback second, continuously chaos-verified"** — see [README.md](./README.md). All design decisions defer to this thesis.

## Architectural invariants (load-bearing — do not break)

1. **TF Gateway is Criteria #1.** All LLM traffic flows through TrueFoundry's AI Gateway by default. Direct-provider calls only happen via L3 SPOF bypass when TF itself is unreachable.
2. **OpenAI SDK is the only LLM client.** Do not introduce `@anthropic-ai/sdk`, `@google/generative-ai`, etc. TF proxies all providers via the OpenAI-compatible API.
3. **Every response carries an Aegis Receipt.** No "raw" response leaves the server. Receipt schema: [docs/RECEIPT.md](./docs/RECEIPT.md).
4. **MCP tool calls are classified before execution.** READ_HEDGE / WRITE_TIED / UNKNOWN_TIED. Never hedge a write tool. See L0 in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).
5. **L6 chaos is shadow-only by default.** Real users are 100% on the clean path. Chaos lives in the shadow request copy. Enable real-traffic chaos only with explicit env flag in staging.
6. **No secrets in code.** Read from `process.env`. The `.env.local` is gitignored. The `.env.example` shows the contract. Anything matching `sk-`, `AKIA`, `ghp_`, or `Authorization:` headers in code is a bug.

## Commands

```bash
bun install              # one-time
bun run dev              # local server on $PORT (default 3000)
bun run test             # bun test (unit + integration)
bun run lint             # biome check .
bun run format           # biome format --write .
bun run typecheck        # tsc --noEmit
bun run chaos:demo       # walk through demo scenarios A-F locally
```

CI must run: `lint`, `typecheck`, `test`. Do not commit if any fail.

## Conventions

- **TypeScript strict.** No `any`, no `as unknown as`. Use Zod for boundary validation.
- **Bun-native imports.** Use explicit `.js` extensions on local ESM imports (`./foo.js` not `./foo`). Bun enforces this.
- **Hono streamSSE must be wrapped in try/catch.** Unhandled throws inside the stream callback crash the whole server ([Hono issue #2164](https://github.com/honojs/hono/issues/2164)).
- **No console.log in production code.** Use a structured logger (pino-style key/value).
- **Errors are typed.** Define error classes per layer (`L0HedgeError`, `L4SemanticError`, etc.). Never throw raw strings.
- **Receipt is appended last.** When streaming, the Receipt arrives as the final SSE event with `event: aegis.receipt`.

## Directory map

```
src/
├── server/          # Hono app, routes, SSE plumbing
├── aegis/           # Layer implementations
│   ├── l0-hedge.ts
│   ├── l1-retry.ts
│   ├── l4-semantic.ts
│   ├── l5-contract.ts
│   └── l6-chaos.ts
├── mcp/             # MCP client + tool classifier (READ_HEDGE / WRITE_TIED)
├── chaos/           # Toxiproxy driver + demo scenarios
└── receipt/         # Receipt builder, signer, validator

tests/
├── unit/
├── integration/     # hits TF tenant (requires .env.local)
└── chaos/           # Toxiproxy-backed scenarios A-F

docs/                # ARCHITECTURE.md, RECEIPT.md, DEMO-SCRIPT.md
demo/                # video sources (recordings/ is gitignored)
```

## Do-not list (regression guardrails)

- ❌ Bypass TF for "convenience" without invoking the SPOF detector
- ❌ Hedge a tool call without classifying it first (could double-write to DB / send 2 emails)
- ❌ Catch and swallow errors silently — every caught error must be recorded in the Receipt
- ❌ Add a 3rd-party SDK that gives you the same thing the OpenAI SDK already does
- ❌ Run L6 chaos at >0% real-user rate without explicit `CHAOS_REAL_RATE` env flag (default 0)
- ❌ Commit `.env.local`, `*.api-key`, recorded demo footage, or any file containing a token
- ❌ Make the Receipt optional — every response endpoint emits one

## Open questions (5/11+)

- TF MCP Gateway registration UX for 2-3 demo MCP servers (search, filesystem, browser)
- Cost of running L0 hedge at hackathon free-tier limits (token bucket cap = ?)
- Whether `x-aegis-idempotent` annotation should be proposed upstream to the MCP spec

## When in doubt

Defer to [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) over this file, and the thesis in [README.md](./README.md) over both. If still ambiguous, ask in PR description rather than guessing.
