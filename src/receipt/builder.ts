// Aegis Receipt builder. See docs/RECEIPT.md for the full schema.
// v0: providers_tried only. Subsequent commits will add l0_hedge / l4_semantic /
// l5_contract / tf_health / mcp_calls / l6_chaos.

import { ulid } from 'ulid';
import type { LayerFired, ProviderTry } from '../aegis/types.js';

export interface ReceiptV0 {
  version: 'aegis-v3.0';
  request_id: string;
  started_at: string;
  duration_ms: number;
  providers_tried: ProviderTry[];
  layers_fired: LayerFired[];
  cost_usd_total: number;
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

  getRequestId(): string {
    return this.request_id;
  }

  build(): ReceiptV0 {
    return {
      version: 'aegis-v3.0',
      request_id: this.request_id,
      started_at: this.started_at.toISOString(),
      duration_ms: Date.now() - this.started_at.getTime(),
      providers_tried: [...this.providers_tried],
      layers_fired: [...this.layers_fired],
      cost_usd_total: Math.round(this.cost_usd_total * 1e6) / 1e6,
    };
  }
}
