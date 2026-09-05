import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { eq, lte, toCents, type Money } from "@aishop4u/shared";

/**
 * The fiat leg (CLAUDE.md §15.4): authorise for the approved total, capture what
 * settled, release the rest. Mocked by default; StripeCardAuthoriser is the real
 * test-mode implementation (step 11), selected when STRIPE_SECRET_KEY is set.
 * Nothing here touches the ledger. The server is the only bridge between the legs.
 */
export interface CardAuthoriser {
  /** false only for the real Stripe path; the event feed labels the charge accordingly. */
  readonly mocked: boolean;
  authorise(p: { session_id: string; amount: Money; currency: "USD" }): Promise<{ auth_id: string }>;
  capture(p: { auth_id: string; amount: Money }): Promise<{ capture_id: string }>;
  release(p: { auth_id: string }): Promise<void>;
}

interface Auth {
  session_id: string;
  amount: Money;
  captured?: Money;
  released: boolean;
}

export class MockCardAuthoriser implements CardAuthoriser {
  readonly mocked = true;
  readonly auths = new Map<string, Auth>();

  async authorise(p: { session_id: string; amount: Money; currency: "USD" }): Promise<{ auth_id: string }> {
    const auth_id = `auth_mock_${randomBytes(6).toString("hex")}`;
    this.auths.set(auth_id, { session_id: p.session_id, amount: p.amount, released: false });
    return { auth_id };
  }

  async capture(p: { auth_id: string; amount: Money }): Promise<{ capture_id: string }> {
    const a = this.auths.get(p.auth_id);
    if (!a) throw new Error("unknown_auth");
    if (a.released) throw new Error("auth_released");
    if (a.captured !== undefined) {
      if (eq(a.captured, p.amount)) return { capture_id: `cap_${p.auth_id}` };
      throw new Error("already_captured");
    }
    if (!lte(p.amount, a.amount)) throw new Error("capture_exceeds_authorisation");
    a.captured = p.amount;
    return { capture_id: `cap_${p.auth_id}` };
  }

  async release(p: { auth_id: string }): Promise<void> {
    const a = this.auths.get(p.auth_id);
    if (!a) throw new Error("unknown_auth");
    a.released = true;
  }
}

/**
 * Real Stripe test-mode authoriser (CLAUDE.md §5 step 11). A PaymentIntent with
 * `capture_method: manual` is the card hold for the approved total; capturing for
 * less than the hold releases the remainder automatically (invariant 6, §15.4
 * step 5). No frontend and no webhook: we confirm server-side with a Stripe test
 * PaymentMethod, so nothing collects card details. Test mode only — never a live key.
 *
 * Idempotency keys make a retried authorise/capture return the first result rather
 * than double-charging (the mock is idempotent the same way).
 */
export class StripeCardAuthoriser implements CardAuthoriser {
  readonly mocked = false;
  private readonly stripe: Stripe;
  private readonly paymentMethod: string;

  constructor(apiKey: string, opts?: { paymentMethod?: string }) {
    if (!apiKey.startsWith("sk_test_")) {
      throw new Error("StripeCardAuthoriser refuses a non-test key; use an sk_test_ key (testnet everywhere, §10)");
    }
    this.stripe = new Stripe(apiKey);
    // Stripe's built-in test Visa that authorises without a 3DS redirect.
    this.paymentMethod = opts?.paymentMethod ?? "pm_card_visa";
  }

  async authorise(p: { session_id: string; amount: Money; currency: "USD" }): Promise<{ auth_id: string }> {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: Number(toCents(p.amount)),
        currency: "usd",
        capture_method: "manual",
        confirm: true,
        payment_method: this.paymentMethod,
        payment_method_types: ["card"],
        metadata: { session_id: p.session_id },
      },
      { idempotencyKey: `authorise:${p.session_id}:${toCents(p.amount)}` },
    );
    if (pi.status !== "requires_capture") {
      throw new Error(`stripe: authorisation status ${pi.status} (expected requires_capture)`);
    }
    return { auth_id: pi.id };
  }

  async capture(p: { auth_id: string; amount: Money }): Promise<{ capture_id: string }> {
    // A partial amount_to_capture captures that much and releases the rest of the hold.
    const pi = await this.stripe.paymentIntents.capture(
      p.auth_id,
      { amount_to_capture: Number(toCents(p.amount)) },
      { idempotencyKey: `capture:${p.auth_id}:${toCents(p.amount)}` },
    );
    const capture_id = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.id;
    return { capture_id };
  }

  async release(p: { auth_id: string }): Promise<void> {
    // Called only when nothing was captured. Cancelling an already-settled PI throws;
    // treat that as already-released rather than failing the run.
    try {
      await this.stripe.paymentIntents.cancel(p.auth_id);
    } catch (e) {
      if (e instanceof Stripe.errors.StripeInvalidRequestError) return;
      throw e;
    }
  }
}
