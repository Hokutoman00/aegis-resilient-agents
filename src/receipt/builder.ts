// Aegis Receipt builder. See docs/RECEIPT.md for the full schema.
// v0: providers_tried only. Subsequent commits will add l0_hedge / l4_semantic /
// l5_contract / tf_health / mcp_calls / l6_chaos.

import { ulid } from 'ulid';
import type { HedgeRecord } from '../aegis/l0-hedge.js';
import type { L4Match } from '../aegis/l4-semantic.js';
import type { L5ContractRecord } from '../aegis/l5-contract.js';
import type { L6ChaosRecord } from '../aegis/l6-chaos.js';
import type { LayerFired, ProviderTry, TFHealthRecord } from '../aegis/types.js';

export interface ReceiptV0 {
  version: 'aegis-v3.0';
  request_id: string;
  started_at: string;
  duration_ms: number;
  providers_tried: ProviderTry[];
  layers_fired: LayerFired[];
  cost_usd_total: number;
  l0_hedge?: HedgeRecord;
  l4_semantic?: L4Match;
  l5_contract?: L5ContractRecord;
  l6_chaos?: L6ChaosRecord;
  tf_health?: TFHealthRecord;
}

export interface ReceiptDraft {
  request_id?: string;
  started_at?: Date;
  providers_tried?: ProviderTry[];
  layers_fired?: LayerFired[];
  cost_usd_total?: number;
}

export class ReceiptBuilder {
  private readonly request_id: string;
  private readonly started_at: Date;
  private readonly providers_tried: ProviderTry[] = [];
  private readonly layers_fired: Set<LayerFired> = new Set();
  private cost_usd_total = 0;
  private l0_hedge: HedgeRecord | undefined;
  private l4_semantic: L4Match | undefined;
  private l5_contract: L5ContractRecord | undefined;
  private l6_chaos: L6ChaosRecord | undefined;
  private tf_health: TFHealthRecord = { reachable: true, bypass_used: false };

  constructor(draft: ReceiptDraft = {}) {
    this.request_id = draft.request_id ?? ulid();
    this.started_at = draft.started_at ?? new Date();
    if (draft.providers_tried) this.providers_tried.push(...draft.providers_tried);
    if (draft.layers_fired) for (const l of draft.layers_fired) this.layers_fired.add(l);
    if (draft.cost_usd_total) this.cost_usd_total = draft.cost_usd_total;
  }

  recordProvider(p: ProviderTry): void {
    this.providers_tried.push(p);
  }

  fired(layer: LayerFired): void {
    this.layers_fired.add(layer);
  }

  addCost(usd: number): void {
    this.cost_usd_total += usd;
  }

  setL0Hedge(record: HedgeRecord): void {
    this.l0_hedge = record;
    if (record.fired) {
      this.layers_fired.add('L0');
      this.cost_usd_total += record.extra_cost_usd;
    }
  }

  setL4Match(match: L4Match): void {
    this.l4_semantic = match;
    this.layers_fired.add('L4');
    // Backfill message_class on the most recently recorded provider error so
    // downstream layers (e.g. L5) can synthesize a meaningful explanation.
    const last = this.providers_tried.at(-1);
    if (last?.error) last.error.message_class = match.message_class;
  }

  setL5Contract(record: L5ContractRecord): void {
    this.l5_contract = record;
    this.layers_fired.add('L5');
  }

  setL6Chaos(record: L6ChaosRecord): void {
    this.l6_chaos = record;
    // L6 fires on every response (read-only attachment); we don't add it to
    // layers_fired unless chaos was actually injected into this request.
    if (record.shadow_injected_this_request) this.layers_fired.add('L6');
  }

  setTFHealth(record: TFHealthRecord): void {
    this.tf_health = record;
    // Bypass means L3 fall-through fired — surface it as a layer.
    if (record.bypass_used) this.layers_fired.add('L3');
  }

  getStartedAt(): Date {
    return this.started_at;
  }

  getProviders(): ProviderTry[] {
    return [...this.providers_tried];
  }

  getRequestId(): string {
    return this.request_id;
  }

  build(): ReceiptV0 {
    const out: ReceiptV0 = {
      version: 'aegis-v3.0',
      request_id: this.request_id,
      started_at: this.started_at.toISOString(),
      duration_ms: Date.now() - this.started_at.getTime(),
      providers_tried: [...this.providers_tried],
      layers_fired: [...this.layers_fired],
      cost_usd_total: Math.round(this.cost_usd_total * 1e6) / 1e6,
    };
    if (this.l0_hedge) out.l0_hedge = this.l0_hedge;
    if (this.l4_semantic) out.l4_semantic = this.l4_semantic;
    if (this.l5_contract) out.l5_contract = this.l5_contract;
    if (this.l6_chaos) out.l6_chaos = this.l6_chaos;
    out.tf_health = this.tf_health;
    return out;
  }
}
