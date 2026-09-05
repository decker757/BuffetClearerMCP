import type { EventSource, EventType, Money, OrderLine } from "@aishop4u/shared";

/**
 * The payments layer never owns the event log; it reports through this sink so the
 * MCP server can chain, sequence and hash every event (CLAUDE.md §10, §12).
 * Every payment attempt, including refusals, goes through here.
 */
export interface EventSink {
  emit(e: {
    type: EventType;
    source: EventSource;
    span_id: string;
    parent_span_id?: string;
    duration_ms?: number;
    payload: Record<string, unknown>;
  }): void;
}

export const nullSink: EventSink = { emit: () => undefined };

/** RLUSD on XRPL, as the shop advertises it and as we verify it. */
export interface RlusdAsset {
  currencyHex: string;
  issuer: string;
}

/** What the shop registry (`GET /shops`) says about a shop. Policy trusts this, not the 402. */
export interface RegisteredShop {
  shop_id: string;
  name: string;
  payTo: string;
  asset: string;
  issuer: string;
  network: string;
}

/** Delivery details go server -> shop only. Never into an event or a tool result. */
export interface Delivery {
  name: string;
  email: string;
  address: string;
}

export type Line = OrderLine;

export interface PaymentCheck {
  hash: string;
  /** any of these may be the payer (a retry may use a different pool wallet) */
  from: string[];
  to: string;
  value: Money;
  invoiceRef: string;
}

/** Minimal ledger surface so orchestration is testable without XRPL. */
export interface Ledger {
  rlusdBalance(address: string): Promise<Money>;
  /** Pays RLUSD; resolves with the validated tx hash. Rejects on tem/expiry; tec codes reject too (nothing moved). */
  payRlusd(p: { fromSeed: string; to: string; value: Money; memo?: { type: string; data: string } }): Promise<string>;
  /**
   * True only if `hash` is a validated, successful RLUSD Payment from one of `from`
   * to `to` for exactly `value`, bound to `invoiceRef` via Memo or InvoiceID.
   * This is how a shop's "already settled" claim is checked against the ledger.
   */
  verifyPayment(p: PaymentCheck): Promise<boolean>;
}

/**
 * A refusal below the model. The message is `policy:<rule>:<text>` because the
 * x402 SDK forwards a selector's error *message* as the refusal reason, and the
 * client recovers the rule from it.
 */
export class PolicyError extends Error {
  constructor(
    public readonly rule: string,
    public readonly text: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(`policy:${rule}:${text}`);
    this.name = "PolicyError";
  }
}

export const EXPLORER_TX = "https://testnet.xrpl.org/transactions/";
