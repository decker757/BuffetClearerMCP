import { eq, normalize, type Money } from "@aishop4u/shared";
import { Client, Wallet, convertStringToHex, type Payment } from "xrpl";
import { createHash } from "node:crypto";
import type { Ledger, PaymentCheck, RlusdAsset } from "./types.js";

/** Real XRPL ledger access. One client, reconnected lazily. */
export class XrplLedger implements Ledger {
  private client: Client | undefined;

  constructor(
    private readonly wsUrl: string,
    private readonly rlusd: RlusdAsset,
  ) {}

  private async conn(): Promise<Client> {
    if (this.client?.isConnected()) return this.client;
    this.client = new Client(this.wsUrl);
    await this.client.connect();
    return this.client;
  }

  async close(): Promise<void> {
    if (this.client?.isConnected()) await this.client.disconnect();
  }

  async rlusdBalance(address: string): Promise<Money> {
    const c = await this.conn();
    const r = await c.request({ command: "account_lines", account: address, peer: this.rlusd.issuer });
    const bal = r.result.lines.find((l) => l.currency.toUpperCase() === this.rlusd.currencyHex.toUpperCase())?.balance ?? "0";
    return iouToMoney(bal);
  }

  async payRlusd(p: { fromSeed: string; to: string; value: Money; memo?: { type: string; data: string } }): Promise<string> {
    const c = await this.conn();
    const wallet = Wallet.fromSeed(p.fromSeed);
    const tx: Payment = {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: p.to,
      Amount: { currency: this.rlusd.currencyHex, issuer: this.rlusd.issuer, value: stripZeros(p.value) },
      ...(p.memo ? { Memos: [{ Memo: { MemoType: convertStringToHex(p.memo.type), MemoData: convertStringToHex(p.memo.data) } }] } : {}),
    };
    // No retry here, ever: a timeout after submit may still validate, and a retry would pay twice.
    const res = await c.submitAndWait(tx, { autofill: true, wallet });
    const meta = res.result.meta;
    const code = typeof meta === "object" && meta ? meta.TransactionResult : "unknown";
    if (code !== "tesSUCCESS") throw new Error(`payment_failed:${code}`);
    return res.result.hash;
  }

  async verifyPayment(p: PaymentCheck): Promise<boolean> {
    if (!/^[0-9A-F]{64}$/i.test(p.hash)) return false;
    const c = await this.conn();
    let r: Awaited<ReturnType<typeof c.request<{ command: "tx"; transaction: string }>>>;
    try {
      r = await c.request({ command: "tx", transaction: p.hash });
    } catch {
      return false;
    }
    const res = r.result as unknown as {
      validated?: boolean;
      meta?: { TransactionResult?: string; delivered_amount?: unknown } | string;
      tx_json?: Record<string, unknown>;
    } & Record<string, unknown>;
    const tx = (res.tx_json ?? res) as Record<string, unknown>;
    const meta = typeof res.meta === "object" ? res.meta : undefined;
    if (res.validated !== true || meta?.TransactionResult !== "tesSUCCESS") return false;
    if (tx.TransactionType !== "Payment") return false;
    if (!p.from.includes(String(tx.Account))) return false;
    if (tx.Destination !== p.to) return false;
    const delivered = meta?.delivered_amount as { currency?: string; issuer?: string; value?: string } | string | undefined;
    if (!delivered || typeof delivered === "string") return false; // XRP, not RLUSD
    if (String(delivered.currency).toUpperCase() !== this.rlusd.currencyHex.toUpperCase() || delivered.issuer !== this.rlusd.issuer) return false;
    if (!eq(iouToMoney(String(delivered.value)), p.value)) return false;
    // Invoice binding: Memo carrying the ref, or InvoiceID = sha256(ref) (x402-xrpl "both" mode sets both).
    const memos = (tx.Memos as Array<{ Memo?: { MemoData?: string } }> | undefined) ?? [];
    const memoHit = memos.some((m) => {
      try {
        return Buffer.from(m.Memo?.MemoData ?? "", "hex").toString("utf8") === p.invoiceRef;
      } catch {
        return false;
      }
    });
    const invoiceIdHit = typeof tx.InvoiceID === "string" && tx.InvoiceID.toUpperCase() === createHash("sha256").update(p.invoiceRef).digest("hex").toUpperCase();
    return memoHit || invoiceIdHit;
  }
}

/**
 * XRPL IOU values can have up to 15 significant digits and may come back in exponent
 * form. Our ledger is cents: truncate, never round up; negatives (issuer-side view) are 0.
 */
export function iouToMoney(iou: string): Money {
  const n = Number(iou);
  if (!Number.isFinite(n) || n <= 0) return "0.00";
  const cents = Math.floor(n * 100 + 1e-9);
  return normalize(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);
}

/** "12.90" -> "12.9", "100.00" -> "100": canonical IOU value strings for tx bodies. */
export function stripZeros(m: Money): string {
  return m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
}
