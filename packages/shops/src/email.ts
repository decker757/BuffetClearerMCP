import fs from "node:fs";
import path from "node:path";

/**
 * Invoice email. The .outbox/<order_id>.json file is always written first as the
 * durable record; the invoice is additionally delivered via Resend when a key is
 * configured (see MailerOptions). A mail failure never fails a paid order — the
 * record stays in the outbox and the caller sees via="outbox". Never log the full
 * email address (§10, §15.6). Seller-derived strings (shop and product names) and
 * user-entered billing fields are HTML-escaped in the body — invariant 4, rendered
 * as text, never markup.
 */
export interface Invoice {
  order_id: string;
  shop_name: string;
  product_name: string;
  price: string;
  currency: "RLUSD";
  tx_hash: string;
  explorer: string;
  to: { name: string; email: string; address: string };
  issued_at: string;
}

export interface MailerOptions {
  /** Resend API key. Absent → outbox only, no network call. */
  apiKey?: string;
  /**
   * Sender address. Resend needs a verified domain to send from your own address;
   * otherwise use onboarding@resend.dev, which can only deliver to the email of the
   * Resend account that owns the key. Defaults to onboarding@resend.dev.
   */
  from?: string;
}

export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  const head = user.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!);
}

function invoiceText(inv: Invoice): string {
  return [
    `Thanks, ${inv.to.name}. Your order is confirmed and paid.`,
    ``,
    `${inv.shop_name} — invoice ${inv.order_id}`,
    `${inv.product_name}: ${inv.price} ${inv.currency}`,
    ``,
    `Settled on XRPL testnet`,
    `Tx ${inv.tx_hash}`,
    inv.explorer,
    ``,
    `Ship to: ${inv.to.address}`,
    `Issued ${inv.issued_at}`,
  ].join("\n");
}

function invoiceHtml(inv: Invoice): string {
  const e = escapeHtml;
  return `<div style="font-family:system-ui,'Segoe UI',Arial,sans-serif;max-width:520px;margin:auto;color:#111;line-height:1.5">
  <h2 style="margin:0 0 2px">${e(inv.shop_name)}</h2>
  <p style="color:#666;margin:0 0 16px">Invoice ${e(inv.order_id)}</p>
  <p>Thanks, ${e(inv.to.name)}. Your order is confirmed and paid.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0">
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee">${e(inv.product_name)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${e(inv.price)} ${e(inv.currency)}</td></tr>
    <tr><td style="padding:8px 0;font-weight:600">Total</td>
        <td style="padding:8px 0;text-align:right;font-weight:600">${e(inv.price)} ${e(inv.currency)}</td></tr>
  </table>
  <p style="margin:0 0 4px;color:#666">Settled on XRPL testnet</p>
  <p style="margin:0 0 16px"><a href="${e(inv.explorer)}">${e(inv.tx_hash)}</a></p>
  <p style="color:#666;font-size:13px">Ship to: ${e(inv.to.address)}<br>Issued ${e(inv.issued_at)}</p>
</div>`;
}

export class InvoiceMailer {
  private readonly apiKey?: string;
  private readonly from: string;

  constructor(private readonly outbox: string, opts?: MailerOptions) {
    fs.mkdirSync(outbox, { recursive: true });
    this.apiKey = opts?.apiKey?.trim() || undefined;
    this.from = opts?.from?.trim() || "onboarding@resend.dev";
  }

  async send(inv: Invoice): Promise<{ delivered: boolean; to_masked: string; via: "resend" | "outbox" }> {
    // Durable record first, so a delivery failure loses nothing.
    fs.writeFileSync(path.join(this.outbox, `${inv.order_id}.json`), JSON.stringify(inv, null, 2));
    const to_masked = maskEmail(inv.to.email);

    if (!this.apiKey) {
      console.log(`[email] invoice ${inv.order_id} filed for ${to_masked} (no RESEND_API_KEY; outbox only)`);
      return { delivered: false, to_masked, via: "outbox" };
    }

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: this.from,
          to: [inv.to.email],
          subject: `${inv.shop_name} — invoice ${inv.order_id}`,
          text: invoiceText(inv),
          html: invoiceHtml(inv),
        }),
      });
      if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      console.log(`[email] invoice ${inv.order_id} delivered to ${to_masked} via Resend`);
      return { delivered: true, to_masked, via: "resend" };
    } catch (e) {
      // Never fail a paid order over email; the record is already in the outbox.
      console.error(`[email] Resend failed for ${inv.order_id}, kept in outbox: ${e instanceof Error ? e.message : String(e)}`);
      return { delivered: false, to_masked, via: "outbox" };
    }
  }
}
