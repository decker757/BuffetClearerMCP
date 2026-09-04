import { describe, expect, it } from "vitest";
import { add, eq, fromCents, lt, normalize, sub, toCents } from "./money.js";

describe("money", () => {
  it("parses and formats two-decimal strings exactly", () => {
    expect(toCents("899.00")).toBe(89900n);
    expect(toCents("0.25")).toBe(25n);
    expect(toCents("12")).toBe(1200n);
    expect(toCents("12.5")).toBe(1250n);
    expect(fromCents(89925n)).toBe("899.25");
    expect(normalize("7.5")).toBe("7.50");
  });

  it("adds without float drift", () => {
    expect(add("0.10", "0.20")).toBe("0.30");
    expect(add("899.00", "0.25", "1299.99")).toBe("2199.24");
  });

  it("rejects malformed and negative values", () => {
    expect(() => toCents("-1.00")).toThrow();
    expect(() => toCents("1.234")).toThrow();
    expect(() => toCents("abc")).toThrow();
    expect(() => sub("1.00", "2.00")).toThrow();
  });

  it("compares", () => {
    expect(eq("1.5", "1.50")).toBe(true);
    expect(lt("0.99", "1.00")).toBe(true);
  });
});
