/**
 * Provision XRPL testnet wallets with RLUSD trustlines (CLAUDE.md §6, §15.5).
 *
 *   npx tsx scripts/provision.ts shops          -> .wallets/shops.json  { shop_a: {seed,address}, shop_b: ... }
 *   npx tsx scripts/provision.ts pool [n=5]     -> .wallets/pool.json   [ {seed,address,state:"idle"}, ... ]
 *   npx tsx scripts/provision.ts repair         -> attention wallets holding no RLUSD go back to idle
 *
 * Idempotent: existing entries are kept, missing trustlines are set. Seeds are
 * plaintext on disk because this is testnet; the file is gitignored.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WalletPool } from "@aishop4u/payments";
import { Client, Wallet, type TrustSet } from "xrpl";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const WS = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";
const RLUSD_ISSUER = process.env.RLUSD_ISSUER ?? "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD_HEX = process.env.RLUSD_CURRENCY_HEX ?? "524C555344000000000000000000000000000000";
const EXPLORER = "https://testnet.xrpl.org/transactions/";

type Entry = { seed: string; address: string; state?: string };

async function ensureTrustline(c: Client, w: Wallet): Promise<void> {
  const lines = await c.request({ command: "account_lines", account: w.address, peer: RLUSD_ISSUER });
  if (lines.result.lines.some((l) => l.currency === RLUSD_HEX)) return;
  const tx: TrustSet = {
    TransactionType: "TrustSet",
    Account: w.address,
    LimitAmount: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: "1000000" },
  };
  const res = await c.submitAndWait(tx, { autofill: true, wallet: w });
  const m = res.result.meta;
  console.log(`  trustline ${w.address}: ${typeof m === "object" && m ? m.TransactionResult : "?"} ${EXPLORER}${res.result.hash}`);
}

async function newFunded(c: Client): Promise<Entry> {
  const { wallet } = await c.fundWallet();
  console.log(`  funded ${wallet.address}`);
  return { seed: wallet.seed!, address: wallet.address };
}

async function provisionShops(c: Client): Promise<void> {
  const file = path.join(ROOT, ".wallets/shops.json");
  const saved: Record<string, Entry> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  for (const id of ["shop_a", "shop_b"]) {
    if (!saved[id]) saved[id] = await newFunded(c);
    await ensureTrustline(c, Wallet.fromSeed(saved[id]!.seed));
    console.log(`${id}: ${saved[id]!.address}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
  console.log("wrote", file);
}

async function provisionPool(c: Client, n: number): Promise<void> {
  const file = path.join(ROOT, ".wallets/pool.json");
  const saved: Entry[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  while (saved.length < n) saved.push({ ...(await newFunded(c)), state: "idle" });
  for (const e of saved) await ensureTrustline(c, Wallet.fromSeed(e.seed));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
  console.log(`pool: ${saved.length} wallets ->`, file);
}

/** Operator action (§15.5): a parked wallet that holds no RLUSD is safe to hand out again. Goes through the pool's lock. */
async function repairPool(c: Client): Promise<void> {
  const pool = WalletPool.fromFile(path.join(ROOT, ".wallets/pool.json"));
  for (const e of pool.status()) {
    if (e.state !== "attention") continue;
    const lines = await c.request({ command: "account_lines", account: e.address, peer: RLUSD_ISSUER });
    const bal = lines.result.lines.find((l) => l.currency === RLUSD_HEX)?.balance ?? "0";
    if (Number(bal) > 0) {
      console.log(`${e.address}: attention, still holds ${bal} RLUSD; sweep it by hand before repairing`);
      continue;
    }
    pool.repair(e.address);
    console.log(`${e.address}: attention -> idle`);
  }
  console.log("pool:", pool.counts());
}

async function main(): Promise<void> {
  const kind = process.argv[2];
  const c = new Client(WS);
  await c.connect();
  try {
    if (kind === "shops") await provisionShops(c);
    else if (kind === "pool") await provisionPool(c, Number(process.argv[3] ?? "5"));
    else if (kind === "repair") await repairPool(c);
    else throw new Error("usage: provision.ts shops | pool [n] | repair");
  } finally {
    await c.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
