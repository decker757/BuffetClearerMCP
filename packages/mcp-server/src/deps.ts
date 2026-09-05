import type { CardAuthoriser, Ledger, RegisteredShop, RlusdAsset, WalletPool } from "@aishop4u/payments";
import type { PaymentHeaderFactory } from "x402-xrpl";
import type { SessionManager } from "./session.js";

/**
 * Everything the tool surface needs, injected so tests can swap the shop, the
 * ledger and the signer without touching the tools.
 */
export interface Deps {
  manager: SessionManager;
  shopsUrl: string;
  fetchImpl: typeof fetch;
  ledger: Ledger;
  pool: WalletPool;
  card: CardAuthoriser;
  treasury: { seed: string; address: string };
  rlusd: RlusdAsset;
  network: "xrpl:0" | "xrpl:1" | "xrpl:2";
  loadRegistry: () => Promise<Record<string, RegisteredShop>>;
  /** absolute path of the built widget html */
  widgetHtml: string;
  /** test seams */
  paymentHeaderFactory?: PaymentHeaderFactory;
  wsUrl?: string;
}
