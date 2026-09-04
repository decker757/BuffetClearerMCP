import { describe, expect, it } from "vitest";
import { checkRequirements } from "./policy.js";
import { PolicyError } from "./types.js";
import { RLUSD, SHOP_A } from "./testkit.js";

const line = { line_id: "l_1", product_id: "p_1", shop_id: "shop_a", product_name: "x", price: "899.00" };
const ctx = { line, shop: SHOP_A, rlusd: RLUSD, network: "xrpl:1" };
const good = () => ({
  scheme: "exact",
  network: "xrpl:1",
  asset: RLUSD.currencyHex,
  payTo: SHOP_A.payTo,
  amount: "899.00",
  maxTimeoutSeconds: 600,
  extra: { issuer: RLUSD.issuer, invoiceId: "q:l:hash" },
});

function ruleOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof PolicyError) return e.rule;
    throw e;
  }
  return "no_error";
}

describe("policy: quoted == demanded, payTo == registered", () => {
  it("accepts a 402 that matches the approved line and the registry exactly", () => {
    expect(checkRequirements([good()], ctx)).toMatchObject({ amount: "899.00", payTo: SHOP_A.payTo });
  });
  it("accepts equal amounts written differently (899 vs 899.00)", () => {
    expect(checkRequirements([{ ...good(), amount: "899" }], ctx).amount).toBe("899");
  });
  it("refuses when the shop demands more than the quote", () => {
    expect(ruleOf(() => checkRequirements([{ ...good(), amount: "4000.00" }], ctx))).toBe("quoted_ne_demanded");
  });
  it("refuses when the shop demands less than the quote (a mismatch is a mismatch)", () => {
    expect(ruleOf(() => checkRequirements([{ ...good(), amount: "1.00" }], ctx))).toBe("quoted_ne_demanded");
  });
  it("refuses a payTo that is not the registered shop address", () => {
    expect(ruleOf(() => checkRequirements([{ ...good(), payTo: "rATTACKERxxxxxxxxxxxxxxxxxxxxxxx" }], ctx))).toBe("payto_not_registered");
  });
  it("refuses a different issuer even with the right currency code", () => {
    expect(ruleOf(() => checkRequirements([{ ...good(), extra: { ...good().extra, issuer: "rFAKEISSUERxxxxxxxxxxxxxxxxxxxxx" } }], ctx))).toBe("issuer_mismatch");
  });
  it("refuses XRP or another network outright", () => {
    expect(ruleOf(() => checkRequirements([{ ...good(), asset: "XRP", amount: "1000000" }], ctx))).toBe("asset_or_network_mismatch");
    expect(ruleOf(() => checkRequirements([{ ...good(), network: "xrpl:0" }], ctx))).toBe("asset_or_network_mismatch");
  });
  it("picks the RLUSD option when several are offered, then verifies it", () => {
    const xrp = { ...good(), asset: "XRP", amount: "1000000" };
    expect(checkRequirements([xrp, good()], ctx).asset).toBe(RLUSD.currencyHex);
  });
  it("refuses a 402 without an invoice id or with cross-currency enabled", () => {
    expect(ruleOf(() => checkRequirements([{ ...good(), extra: { issuer: RLUSD.issuer } }], ctx))).toBe("missing_invoice");
    expect(ruleOf(() => checkRequirements([{ ...good(), extra: { ...good().extra, crossCurrency: true } }], ctx))).toBe("cross_currency_refused");
  });
  it("refuses amounts with whitespace, leading zeros, or exponent form even when numerically equal", () => {
    expect(ruleOf(() => checkRequirements([{ ...good(), amount: " 899.00" }], ctx))).toBe("amount_not_canonical");
    expect(ruleOf(() => checkRequirements([{ ...good(), amount: "0899.00" }], ctx))).toBe("amount_not_canonical");
    expect(ruleOf(() => checkRequirements([{ ...good(), amount: "8.99e2" }], ctx))).toBe("amount_not_canonical");
    expect(ruleOf(() => checkRequirements([{ ...good(), amount: "899.000" }], ctx))).toBe("amount_not_canonical");
  });
  it("refuses the SDK's top-level issuer / invoiceId override shape", () => {
    expect(ruleOf(() => checkRequirements([{ ...good(), issuer: "rFAKEISSUERxxxxxxxxxxxxxxxxxxxxx" }], ctx))).toBe("noncanonical_402");
    expect(ruleOf(() => checkRequirements([{ ...good(), invoiceId: "other" }], ctx))).toBe("noncanonical_402");
  });
  it("encodes the rule in the message so the SDK's reason string carries it", () => {
    const e = new PolicyError("quoted_ne_demanded", "shop demands 4000.00");
    expect(e.message).toBe("policy:quoted_ne_demanded:shop demands 4000.00");
  });
});
