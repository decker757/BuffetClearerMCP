import { z } from "zod";
import { MoneySchema, ProductSchema } from "./product.js";

/** The §12 phase strip. Finer than the lifecycle: `shopping` spans the first four. */
export const SessionStepSchema = z.enum([
  "preferences",
  "browse",
  "recommend",
  "select",
  "billing",
  "approve",
  "settle",
]);
export type SessionStep = z.infer<typeof SessionStepSchema>;

/** Lifecycle per CLAUDE.md §15.6. */
export const SessionPhaseSchema = z.enum([
  "started",
  "shopping",
  "checkout",
  "approved",
  "settling",
  "done",
  "aborted",
  "expired",
]);
export type SessionPhase = z.infer<typeof SessionPhaseSchema>;

/** A candidate as shown in the decision table; flagged ones carry the agent's reason. */
export const CandidateSchema = z.object({
  product: ProductSchema,
  outcome: z.enum(["recommended", "rejected"]),
  reason: z.string().max(500).optional(),
  evidence: z.record(z.union([z.string(), z.number()])).optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const OrderLineSchema = z.object({
  line_id: z.string().min(1),
  product_id: z.string().min(1),
  shop_id: z.string().min(1),
  product_name: z.string(),
  price: MoneySchema,
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const QuoteSchema = z.object({
  quote_id: z.string().min(1),
  lines: z.array(OrderLineSchema).min(1),
  items_total: MoneySchema,
  fee: MoneySchema,
  total: MoneySchema,
  /**
   * sha256 over canonical JSON of
   * {session_id, quote_id, lines, items_total, fee, total, expires_at}.
   * Session-bound so an approval record can never match across sessions.
   */
  quote_hash: z.string().length(64),
  expires_at: z.string().datetime(),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const LedgerSchema = z.object({
  approved_total: MoneySchema.optional(),
  funded: MoneySchema,
  settled: MoneySchema,
  in_flight: MoneySchema,
  fee: MoneySchema,
});
export type Ledger = z.infer<typeof LedgerSchema>;

/** What the widget gets on init. Never includes billing content. */
export const SessionSnapshotSchema = z.object({
  session_id: z.string(),
  objective: z.string(),
  phase: SessionPhaseSchema,
  step: SessionStepSchema,
  price_range: z.object({ min: MoneySchema, max: MoneySchema }).optional(),
  ledger: LedgerSchema,
  candidates: z.array(CandidateSchema),
  selections: z.array(OrderLineSchema),
  billing_present: z.boolean(),
  pending_quote: QuoteSchema.optional(),
  head_seq: z.number().int().min(0),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
