#!/usr/bin/env bash
# Aegis demo runner — exercises every layer end-to-end against a running
# Aegis server (default http://localhost:3000). Use this to reproduce the
# scenes documented in docs/DEMO-SCRIPT.md without needing the recording
# pipeline.
#
# Usage:
#   bun run dev                 # in one shell
#   bash examples/demo.sh       # in another
#
# Or against a non-default host:
#   AEGIS_BASE=http://aegis.example.com bash examples/demo.sh

set -u
AEGIS_BASE="${AEGIS_BASE:-http://localhost:3000}"

hr() { printf '\n\033[1;36m── %s ─────────────────────────────────────\033[0m\n' "$1"; }
post() {
  local path="$1"
  local body="$2"
  curl -sS -X POST "${AEGIS_BASE}${path}" \
    -H 'Content-Type: application/json' \
    -d "$body"
}

hr "Sanity — /health"
curl -sS "${AEGIS_BASE}/health"
echo

hr "Scene A — L0 hedge (race primary + alternate)"
post /v1/chat/completions '{
  "messages": [{"role": "user", "content": "Hi"}],
  "max_tokens": 15,
  "x-aegis-hedge": { "hedge_after_ms": 500, "hedge_model": "openai/gpt-4.1-mini" }
}'
echo

hr "Scene B — L4 catches credit_balance_too_low / quota and routes"
post /v1/chat/completions '{
  "messages": [{"role": "user", "content": "Hi"}],
  "max_tokens": 15
}'
echo

hr "Scene C — MCP READ_HEDGE: primary down → backup wins"
post /v1/mcp/call '{
  "tool":      { "name": "search_web" },
  "args":      { "q": "aegis hackathon" },
  "primary":   { "name": "scrapeless",   "latency_ms": 50, "fixed_failure": "primary down" },
  "secondary": { "name": "brave-search", "latency_ms": 120 }
}'
echo

hr "Scene C variant — MCP WRITE_TIED with fallback + idempotency key"
post /v1/mcp/call '{
  "tool":      { "name": "create_record" },
  "args":      { "name": "demo" },
  "primary":   { "name": "primary-db", "latency_ms": 30, "fixed_failure": "db down" },
  "secondary": { "name": "replica",    "latency_ms": 30 },
  "tied_timeout_ms": 500
}'
echo

hr "Scene D — Streaming (everything fails → aegis.error + aegis.receipt + [DONE])"
curl -sS --no-buffer -N -X POST "${AEGIS_BASE}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hi"}],"max_tokens":15,"stream":true}'
echo

hr "L6 self-chaos status"
curl -sS "${AEGIS_BASE}/v1/chaos/status"
echo

hr "MCP classifier probes"
echo "search_web:"
post /v1/mcp/classify '{"name":"search_web"}'
echo
echo
echo "send_email:"
post /v1/mcp/classify '{"name":"send_email"}'
echo
echo
echo "delete_idempotent (with x-aegis-idempotent:true):"
post /v1/mcp/classify '{"name":"delete_idempotent","x-aegis-idempotent":true}'
echo

hr "Done. Every response above carries an _aegis_receipt (chat) or record (mcp) field with the full layer trace."
