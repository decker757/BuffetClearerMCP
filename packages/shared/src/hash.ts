import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  // Round-trip first so Dates, Buffers and anything with toJSON hash the same
  // way live as they do after being served over HTTP and parsed back.
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value))));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash of an event for the append-only chain: sha256 over the canonical JSON of
 * the event body (everything except `hash`) which already includes `prev_hash`.
 */
export function chainHash(body: Record<string, unknown>): string {
  const { hash: _ignored, ...rest } = body;
  return sha256Hex(canonicalJson(rest));
}

export const GENESIS_HASH = "0".repeat(64);
