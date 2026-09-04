import { describe, expect, it } from "vitest";
import { canonicalJson, chainHash, sha256Hex } from "./hash.js";

describe("hash", () => {
  it("canonicalises key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("chain hash ignores an existing hash field and is stable", () => {
    const body = { seq: 1, type: "x", prev_hash: "00", payload: { a: 1 } };
    const h1 = chainHash(body);
    const h2 = chainHash({ ...body, hash: "garbage" });
    expect(h1).toBe(h2);
    expect(h1).toBe(sha256Hex(canonicalJson(body)));
    expect(h1).toHaveLength(64);
  });

  it("hashes the same live and after a JSON round-trip", () => {
    const ev = { seq: 1, prev_hash: "aa", payload: { ts: new Date("2026-09-05T00:00:00Z"), buf: Buffer.from("hi") } };
    expect(chainHash(ev)).toBe(chainHash(JSON.parse(JSON.stringify(ev))));
  });

  it("changes when prev_hash changes", () => {
    const a = chainHash({ seq: 1, prev_hash: "aa" });
    const b = chainHash({ seq: 1, prev_hash: "bb" });
    expect(a).not.toBe(b);
  });
});
