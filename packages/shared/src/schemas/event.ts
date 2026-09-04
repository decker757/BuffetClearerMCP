import { z } from "zod";

/** Event types per CLAUDE.md §12. Keep this list the single source of truth. */
export const EVENT_TYPES = [
  // session
  "session.started",
  "session.aborted",
  "session.expired",
  // agent
  "agent.intent",
  // browse
  "browse.requested",
  "browse.returned",
  "browse.refused",
  // candidates
  "candidate.found",
  "candidate.rejected",
  "candidate.ranked",
  "candidate.selected",
  // checkout
  "billing.submitted",
  "quote.ready",
  "approval.granted",
  "approval.refused",
  // money
  "card.authorised",
  "session.funded",
  "payment.quoted",
  "payment.refused",
  "payment.submitted",
  "purchase.settled",
  "purchase.failed",
  "session.swept",
  "card.captured",
  "card.released",
  "manifest.anchored",
  "invoice.sent",
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventSourceSchema = z.enum(["agent", "server"]);
export type EventSource = z.infer<typeof EventSourceSchema>;

/**
 * Every event is also a span (§12). `hash` is sha256 over the canonical JSON of
 * the rest of the event, which includes `prev_hash`. Payloads never carry
 * billing details.
 */
export const SessionEventSchema = z.object({
  session_id: z.string().min(1),
  seq: z.number().int().min(1),
  ts: z.string().datetime(),
  span_id: z.string().min(1),
  parent_span_id: z.string().min(1).optional(),
  type: EventTypeSchema,
  source: EventSourceSchema,
  duration_ms: z.number().int().min(0).optional(),
  payload: z.record(z.unknown()),
  prev_hash: z.string().length(64),
  hash: z.string().length(64),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/** What a producer supplies; the log fills in seq, ts, prev_hash, hash. */
export type NewEvent = Pick<SessionEvent, "session_id" | "span_id" | "type" | "source" | "payload"> &
  Partial<Pick<SessionEvent, "parent_span_id" | "duration_ms">>;
