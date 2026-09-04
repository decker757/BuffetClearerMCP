import { randomBytes } from "node:crypto";
import { eq, lte, type Money } from "@buffet/shared";

/**
 * The fiat leg (CLAUDE.md §15.4): authorise for the approved total, capture what
 * settled, release the rest. Mocked by default; a Stripe implementation is step 11.
 * Nothing here touches the ledger. The server is the only bridge between the legs.
 */
export interface CardAuthoriser {
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
