import fs from "node:fs";
import path from "node:path";

/**
 * Invoice email, stubbed for the demo: written to .outbox/<order_id>.json and
 * logged with the address masked. Swap the `send` body for Resend/SMTP later;
 * nothing else changes. Never log the full email address.
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

export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  const head = user.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

export class InvoiceMailer {
  constructor(private readonly outbox: string) {
    fs.mkdirSync(outbox, { recursive: true });
  }

  async send(inv: Invoice): Promise<{ delivered: boolean; to_masked: string }> {
    const file = path.join(this.outbox, `${inv.order_id}.json`);
    fs.writeFileSync(file, JSON.stringify(inv, null, 2));
    const to_masked = maskEmail(inv.to.email);
    console.log(`[email] invoice ${inv.order_id} for ${inv.product_name} sent to ${to_masked}`);
    return { delivered: true, to_masked };
  }
}
