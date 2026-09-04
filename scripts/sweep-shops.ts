/**
 * Demo ops: move the mock shops' RLUSD back to the treasury so test purchases can be
 * repeated all day without draining it. The shops are ours (CLAUDE.md §15.3), so this
 * is a treasury operation, not a refund.
 *
 *   npx tsx scripts/sweep-shops.ts
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet, convertStringToHex, type Payment } from "xrpl";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
const WS = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";
const RLUSD = {
  currency: process.env.RLUSD_CURRENCY_HEX ?? "524C555344000000000000000000000000000000",
  issuer: process.env.RLUSD_ISSUER ?? "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
};

function treasuryAddress(): string {
  const seed = process.env.TREASURY_SEED || (JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/spike.json"), "utf8")) as { treasury: string }).treasury;
  return Wallet.fromSeed(seed).address;
}

async function main(): Promise<void> {
  const c = new Client(WS);
  await c.connect();
  try {
    const to = treasuryAddress();
    const shops = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/shops.json"), "utf8")) as Record<string, { seed: string; address: string }>;
    for (const [id, e] of Object.entries(shops)) {
      const lines = await c.request({ command: "account_lines", account: e.address, peer: RLUSD.issuer });
      const bal = lines.result.lines.find((l) => l.currency === RLUSD.currency)?.balance ?? "0";
      if (Number(bal) <= 0) {
        console.log(`${id}: nothing to sweep`);
        continue;
      }
      const tx: Payment = {
        TransactionType: "Payment",
        Account: e.address,
        Destination: to,
        Amount: { currency: RLUSD.currency, issuer: RLUSD.issuer, value: bal },
        Memos: [{ Memo: { MemoType: convertStringToHex("buffet/ops"), MemoData: convertStringToHex("sweep-shops") } }],
      };
      const res = await c.submitAndWait(tx, { autofill: true, wallet: Wallet.fromSeed(e.seed) });
      const m = res.result.meta;
      console.log(`${id}: swept ${bal} RLUSD -> treasury: ${typeof m === "object" && m ? m.TransactionResult : "?"} ${res.result.hash}`);
    }
    const t = await c.request({ command: "account_lines", account: to, peer: RLUSD.issuer });
    console.log(`treasury now ${t.result.lines.find((l) => l.currency === RLUSD.currency)?.balance ?? "0"} RLUSD`);
  } finally {
    await c.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
