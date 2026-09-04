import { describe, expect, it } from "vitest";
import { iouToMoney, stripZeros } from "./ledger.js";

describe("ledger value conversions", () => {
  it("truncates IOU balances to cents, never rounds up", () => {
    expect(iouToMoney("32.6558247834")).toBe("32.65");
    expect(iouToMoney("899")).toBe("899.00");
    expect(iouToMoney("0.999")).toBe("0.99");
    expect(iouToMoney("1501.41")).toBe("1501.41");
  });
  it("treats negatives (issuer-side view) and exponent forms safely", () => {
    expect(iouToMoney("-5")).toBe("0.00");
    expect(iouToMoney("1e-9")).toBe("0.00");
    expect(iouToMoney("1.5e2")).toBe("150.00");
    expect(iouToMoney("garbage")).toBe("0.00");
  });
  it("strips trailing zeros for tx bodies", () => {
    expect(stripZeros("12.90")).toBe("12.9");
    expect(stripZeros("100.00")).toBe("100");
    expect(stripZeros("0.10")).toBe("0.1");
    expect(stripZeros("7")).toBe("7");
  });
});
