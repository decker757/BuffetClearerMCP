import { eq } from "@aishop4u/shared";
import type { PaymentRequirementsSelector } from "x402-xrpl";
import { PolicyError, type Line, type RegisteredShop, type RlusdAsset } from "./types.js";

/**
 * Policy, all enforced below the model (CLAUDE.md §7).
 *
 * The 402 is attacker-controlled input at the moment of a spending decision, so
 * nothing in it is trusted on its own. Every field is checked against what we
 * already know: the approved quote line, the shop registry, and the RLUSD config.
 * A mismatch throws a PolicyError; x402Purchase turns that into a refusal result
 * before anything is signed.
 */
export interface PolicyContext {
  line: Line;
  shop: RegisteredShop;
  rlusd: RlusdAsset;
  network: string;
}

/** Canonical or trailing-zero-free decimal: "899", "899.5", "899.00". No whitespace, no leading zeros, no exponent. */
const AMOUNT_RE = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/** The option the policy would examine, without throwing: used to log the quote faithfully. */
export function pickRlusdOption(accepts: Array<Record<string, unknown>>, ctx: Pick<PolicyContext, "rlusd" | "network">): Record<string, unknown> | undefined {
  return accepts.find(
    (a) => a.scheme === "exact" && a.network === ctx.network && String(a.asset).toUpperCase() === ctx.rlusd.currencyHex.toUpperCase(),
  );
}

export function checkRequirements(accepts: Array<Record<string, unknown>>, ctx: PolicyContext): Record<string, unknown> {
  if (accepts.length === 0) throw new PolicyError("no_accepts", "402 carried no payment options");
  const candidate = pickRlusdOption(accepts, ctx);
  if (!candidate) {
    throw new PolicyError("asset_or_network_mismatch", "no exact RLUSD option on our network", {
      offered: accepts.map((a) => ({ scheme: a.scheme, network: a.network, asset: a.asset })),
    });
  }
  // The SDK's wire parser lets top-level `issuer` / `invoiceId` override `extra`. We never accept that shape.
  if (candidate.issuer !== undefined || candidate.invoiceId !== undefined) {
    throw new PolicyError("noncanonical_402", "issuer/invoiceId must live under extra");
  }
  const extra = (candidate.extra ?? {}) as Record<string, unknown>;
  const demanded = candidate.amount;
  if (typeof demanded !== "string" || !AMOUNT_RE.test(demanded)) {
    throw new PolicyError("amount_not_canonical", `amount ${JSON.stringify(demanded)} is not a plain decimal`, { demanded });
  }
  if (!eq(demanded, ctx.line.price)) {
    throw new PolicyError("quoted_ne_demanded", `shop demands ${demanded}, quote line is ${ctx.line.price}`, {
      quoted: ctx.line.price,
      demanded,
    });
  }
  if (candidate.payTo !== ctx.shop.payTo) {
    throw new PolicyError("payto_not_registered", "402 payTo is not the registered shop address", {
      demanded_payTo: candidate.payTo,
      registered_payTo: ctx.shop.payTo,
    });
  }
  if (extra.issuer !== ctx.rlusd.issuer) {
    throw new PolicyError("issuer_mismatch", "402 issuer is not the RLUSD issuer", {
      demanded_issuer: extra.issuer,
      expected_issuer: ctx.rlusd.issuer,
    });
  }
  if (typeof extra.invoiceId !== "string" || extra.invoiceId.length === 0) {
    throw new PolicyError("missing_invoice", "402 has no invoiceId; nothing to bind the payment to");
  }
  if (extra.crossCurrency === true) {
    throw new PolicyError("cross_currency_refused", "we never fund a payment from a different asset");
  }
  return candidate;
}

/** Adapter for x402-xrpl: a selector that enforces the policy instead of picking the cheapest. */
export function policySelector(ctx: PolicyContext): PaymentRequirementsSelector {
  return (accepts) => checkRequirements(accepts, ctx);
}
