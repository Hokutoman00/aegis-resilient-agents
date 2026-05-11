// L6 — continuous self-chaos (shadow drill).
//
// Aegis periodically tests its own resilience by simulating the failure modes
// it claims to handle, and records the outcome of each drill. The result is
// surfaced in every response Receipt as `last_chaos_survival`, giving any
// auditor a freshness signal: "Aegis last survived a chaos drill 47s ago."
//
// v0 — synthetic drills (no Toxiproxy yet). Each scenario constructs a
// representative error and verifies that classifyError() routes it. v1 will
// replace synthetic drills with Toxiproxy-injected real HTTP failures and
// run the full /v1/chat/completions path in a shadow request.

import { classifyError } from './l4-semantic.js';
import type { ProviderError } from './types.js';

export type ChaosOutcomeKind = 'survived' | 'degraded' | 'failed';

export interface ChaosOutcome {
  timestamp: string; // ISO 8601
  seconds_ago: number; // computed on read
  toxic: string;
  outcome: ChaosOutcomeKind;
  notes?: string;
}

interface DrillScenario {
  toxic: string;
  providerName: string;
  error: ProviderError;
}

const DRILL_SCENARIOS: DrillScenario[] = [
  {
    toxic: 'anthropic_400_credit_balance',
    providerName: 'anthropic/claude-sonnet-4-5',
    error: {
      status: 400,
      type: 'invalid_request_error',
      raw_message:
        'anthropic error: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.',
    },
  },
  {
    toxic: 'openai_429_quota',
    providerName: 'openai/gpt-4.1-mini',
    error: {
      status: 429,
      code: 'insufficient_quota',
      raw_message: 'openai error: You exceeded your current quota.',
    },
  },
  {
    toxic: 'context_overflow',
    providerName: 'anthropic/claude-haiku-4-5',
    error: { status: 400, raw_message: 'context length too long for this model' },
  },
  {
    toxic: 'model_deprecation',
    providerName: 'openai/legacy-gpt-3',
    error: { status: 404, raw_message: 'model has been deprecated and is no longer available' },
  },
];

// Module-level state. Singleton lifetime = process lifetime. Crash → reset.
const state = {
  last: undefined as ChaosOutcome | undefined,
  totalDrills: 0,
  survivedDrills: 0,
  intervalHandle: undefined as ReturnType<typeof setInterval> | undefined,
};

export function runDrill(): ChaosOutcome {
  const idx = state.totalDrills % DRILL_SCENARIOS.length;
  const scenario = DRILL_SCENARIOS[idx];
  if (!scenario) throw new Error('drill scenario list is empty');
  const match = classifyError(scenario.error, scenario.providerName);
  const outcome: ChaosOutcomeKind = match ? 'survived' : 'failed';
  const result: ChaosOutcome = {
    timestamp: new Date().toISOString(),
    seconds_ago: 0,
    toxic: scenario.toxic,
    outcome,
    notes: match
      ? `classified as ${match.message_class}, action=${match.action_taken}`
      : 'no L4 rule matched — would surface to L5 graceful degradation',
  };
  state.last = result;
  state.totalDrills += 1;
  if (outcome === 'survived') state.survivedDrills += 1;
  return result;
}

export function startChaosScheduler(intervalMs = 30_000): void {
  if (state.intervalHandle) return;
  runDrill(); // fire one immediately so first response has a fresh survival
  state.intervalHandle = setInterval(() => {
    try {
      runDrill();
    } catch (e) {
      console.error('[l6-chaos] drill failed:', e);
    }
  }, intervalMs);
}

export function stopChaosScheduler(): void {
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = undefined;
  }
}

export interface L6ChaosRecord {
  shadow_injected_this_request: boolean;
  last_chaos_survival: ChaosOutcome | null;
  total_drills: number;
  survival_rate: number; // 0..1
}

export function getChaosState(): L6ChaosRecord {
  const last = state.last;
  let lastWithDelta: ChaosOutcome | null = null;
  if (last) {
    const secondsAgo = Math.max(0, Math.floor((Date.now() - Date.parse(last.timestamp)) / 1000));
    lastWithDelta = { ...last, seconds_ago: secondsAgo };
  }
  return {
    shadow_injected_this_request: false, // v1 will set this true for the 1% shadow path
    last_chaos_survival: lastWithDelta,
    total_drills: state.totalDrills,
    survival_rate: state.totalDrills > 0 ? state.survivedDrills / state.totalDrills : 0,
  };
}
