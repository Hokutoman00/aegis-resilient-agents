# Aegis — 3 Minute Demo Script

Submission video for the TrueFoundry Resilient Agents Challenge. Recording window 2026-05-23 to 2026-05-25. Final cut targets **2:45–3:00**.

## Format

- **Container**: MP4 H.264 + AAC, 1920×1080, 30fps
- **Narration**: TTS (msedge-tts en-US-AriaNeural) — see `.claude/video/scripts/tts-to-file.mjs`
- **Capture**: ffmpeg gdigrab via `.claude/video/scripts/record-screen.mjs`
- **Assembly**: ffmpeg concat via `.claude/video/scripts/concat.mjs`
- **Upload**: YouTube unlisted, link in Devpost submission

## Spine

```
[0:00 – 0:25]  HOOK            — recent outages + the industry-wide gap
[0:25 – 0:50]  THESIS          — hedge first / fallback second / verify continuously
[0:50 – 2:30]  4 LIVE SCENES   — A hedge / B L4 / C MCP / D L5
[2:30 – 3:00]  CALL TO ACTION  — same OpenAI SDK, drop-in, GitHub link
```

## 0:00–0:25 — Hook

**Visual**: Cold open on a montage of public status-page screenshots:

| Date | Provider | Severity |
|---|---|---|
| 2025-06 | OpenAI | 15+ hour API outage |
| 2025-11-18 | Cloudflare | Cascaded into ChatGPT + Sora |
| 2026-02-11 | Anthropic | Claude elevated error rates |
| 2026-03-02 / 03 | Anthropic | Claude down twice in 24 hours |
| 2026-04-20 | OpenAI | ChatGPT + Codex + API platform |

Then cut to a terminal showing `curl` against LiteLLM, Portkey, OpenRouter, and TF Virtual Model — each receiving Anthropic's `400 credit_balance_too_low` and failing without fallback.

**Narration**:
> "Every major LLM provider went down at least once in the past year. The four leading AI gateways — LiteLLM, Portkey, OpenRouter, TrueFoundry — share a common blind spot: when Anthropic says 'credit balance too low,' none of them trigger fallback. It's a 4xx error, so the gateway treats it as a client problem. The result: an agent that goes silent the moment a credit card expires. This is Aegis."

## 0:25–0:50 — Thesis

**Visual**: Architecture diagram from `docs/ARCHITECTURE.md` zoomed to the 7-layer stack. Cursor traces L0 down to L6 as each is named.

**Narration**:
> "Aegis is a resilient AI agent runtime built on TrueFoundry. Seven layers, each watching one runtime invariant, each with a degraded mode for when the invariant breaks. Hedge first — race two providers, take whichever wins. Fallback second — semantic error inspection routes around any provider gap, including the credit-balance class. And continuously chaos-verified — every response carries a receipt with how long ago Aegis last survived an injected failure."

## 0:50–2:30 — Live scenes

Each scene is **~25 seconds**. The screen is split: terminal on the left running `curl` against `http://localhost:3000/v1/chat/completions`, Receipt JSON formatter on the right.

### Scene A — Hedge in flight (~25s)

**Request**: hedged completion with `x-aegis-hedge: { hedge_after_ms: 500 }`.

**Highlight in Receipt**:
- `layers_fired: ["L0", "L1"]`
- `l0_hedge: { fired: true, canceled_at_ms: 80, extra_cost_usd: 0.0000009 }`

**Narration**:
> "Layer zero. After 500 milliseconds with no first token, Aegis fires a duplicate to the alternate. The faster reply wins; the slower one cancels in 80 milliseconds. Net extra cost: one-tenth of a cent. The Receipt records every number."

### Scene B — L4 catches credit_balance_too_low (~25s)

**Request**: standard non-streaming chat. TF returns `400 invalid_request_error / credit balance too low`.

**Highlight in Receipt**:
- `providers_tried`: 3 attempts visible (claude → gpt → claude-haiku)
- `layers_fired: ["L4", "L5"]`
- `l4_semantic: { matched_rule: "anthropic.400.credit_balance.regex", action_taken: "fallback_provider", message_class: "credit_balance_too_low" }`

**Narration**:
> "The exact error LiteLLM and Portkey both pass straight through. Aegis inspects the message — not just the status code — recognizes 'credit balance too low,' and re-routes to OpenAI without the client knowing anything went wrong."

### Scene C — MCP server fails mid-tool-call (~25s)

**Request**: an agentic completion that calls `search_web`. The `search_web` MCP server is wrapped in a Toxiproxy proxy injected with `down=true` mid-call.

**Highlight in Receipt**:
- `mcp_calls[0]`: `classification: "READ_HEDGE"`, `servers_raced: ["primary", "backup"]`, `winner: "backup"`
- The classification trace shows the name-pattern match (`search_`).

**Narration**:
> "MCP tool resilience. `search_web` is read-only, so Aegis races two MCP servers from the start. We just took the primary down with Toxiproxy mid-call. The backup completes; the user never sees a stall."

### Scene D — Everything fails, L5 graceful (~25s)

**Request**: all configured providers are credit-exhausted (which is the *actual* state of our TF tenant — this scene is real, not staged).

**Highlight in Receipt**:
- `layers_fired: ["L4", "L5"]`
- `l5_contract: { honored: true, degraded: true, degradation_reason: "all_providers_failed (credit_balance_too_low|insufficient_quota)" }`
- Response is **HTTP 200** with an honest assistant message naming the failure classes.

**Narration**:
> "Worst case. Every provider is exhausted. Most agents would crash with a 5xx. Aegis returns a normal 200 chat completion with an assistant message that explains, in plain words, exactly what went wrong and what the user can do about it. The Receipt is attached for the operator. The client app never has to ship a special error branch."

## 2:30–3:00 — Call to action

**Visual**: GitHub repo URL onscreen. Below, a one-liner showing the OpenAI SDK pointed at Aegis.

```ts
const client = new OpenAI({
  apiKey: process.env.TRUEFOUNDRY_API_KEY,
  baseURL: 'http://localhost:3000/v1',
});
```

**Narration**:
> "Drop-in compatible with the OpenAI SDK. Seven layers of resilience, one observable artifact, 44 unit tests, two thousand lines of TypeScript. The same call you already write — but it doesn't go quiet when the world breaks."

## Recording checklist

- [ ] Windows 集中モード ON (no notification overlays in capture)
- [ ] Terminal font size 16+ (Cascadia Mono)
- [ ] JSON formatter side pane (Receipt viewer)
- [ ] Toxiproxy installed (Docker container or standalone binary)
- [ ] A real working LLM provider key for Scene A and C success paths (TF tenant providers are exhausted by design — for those scenes use a fresh OpenAI key, or call `gemini-1.5-flash` via Google AI Studio free tier)
- [ ] Pre-record each scene as a take of the right length; assemble in CapCut / ffmpeg
- [ ] Title card + outro card via `.claude/video/scripts/title-card.mjs`
- [ ] Audio normalized to -16 LUFS (loudnorm filter)
