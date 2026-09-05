/**
 * Phase 1 spike B (CLAUDE.md §5 step 3, first half): prove the XRPL leg.
 *
 *   1. Create two testnet accounts from the XRP faucet (treasury, shop).
 *   2. Set an RLUSD trustline on both.
 *   3. If the treasury holds RLUSD (fund it at https://tryrlusd.com), send 1 RLUSD
 *      treasury -> shop with a memo, and print the tx hash + explorer link.
 *      Otherwise send 1 XRP the same way so the path is still proven end to end.
 *
 * Wallet seeds are written to .wallets/spike.json (gitignored). Testnet only.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet, convertStringToHex, xrpToDrops, type Payment, type TrustSet } from "xrpl";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const WS = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";
const RLUSD_ISSUER = process.env.RLUSD_ISSUER ?? "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD_HEX = process.env.RLUSD_CURRENCY_HEX ?? "524C555344000000000000000000000000000000";
const EXPLORER = "https://testnet.xrpl.org/transactions/";
const STATE_FILE = path.join(ROOT, ".wallets/spike.json");

type Saved = { treasury: string; shop: string };

function loadOrCreate(client: Client): Promise<{ treasury: Wallet; shop: Wallet }> {
  return (async () => {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Saved;
      console.log("reusing wallets from", STATE_FILE);
      // TREASURY_SEED in .env wins, so the funded treasury can be shared across scripts.
      const treasury = Wallet.fromSeed(process.env.TREASURY_SEED || saved.treasury);
      return { treasury, shop: Wallet.fromSeed(saved.shop) };
    }
    console.log("funding two accounts from the XRP testnet faucet...");
    const [{ wallet: treasury }, { wallet: shop }] = await Promise.all([client.fundWallet(), client.fundWallet()]);
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ treasury: treasury.seed, shop: shop.seed }, null, 2));
    console.log("saved seeds to", STATE_FILE);
    return { treasury, shop };
  })();
}

async function hasTrustline(client: Client, account: string): Promise<boolean> {
  const lines = await client.request({ command: "account_lines", account, peer: RLUSD_ISSUER });
  return lines.result.lines.some((l) => l.currency === RLUSD_HEX);
}

async function ensureTrustline(client: Client, wallet: Wallet): Promise<void> {
  if (await hasTrustline(client, wallet.address)) {
    console.log(`trustline already set for ${wallet.address}`);
    return;
  }
  const tx: TrustSet = {
    TransactionType: "TrustSet",
    Account: wallet.address,
    LimitAmount: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: "1000000" },
  };
  const t0 = Date.now();
  const res = await client.submitAndWait(tx, { autofill: true, wallet });
  const meta = res.result.meta;
  const code = typeof meta === "object" && meta ? meta.TransactionResult : "?";
  console.log(`TrustSet ${wallet.address}: ${code} in ${Date.now() - t0}ms  ${EXPLORER}${res.result.hash}`);
}

async function rlusdBalance(client: Client, account: string): Promise<string> {
  const lines = await client.request({ command: "account_lines", account, peer: RLUSD_ISSUER });
  return lines.result.lines.find((l) => l.currency === RLUSD_HEX)?.balance ?? "0";
}

async function main(): Promise<void> {
  const client = new Client(WS);
  await client.connect();
  try {
    const { treasury, shop } = await loadOrCreate(client);
    console.log("treasury", treasury.address);
    console.log("shop    ", shop.address);

    await ensureTrustline(client, treasury);
    await ensureTrustline(client, shop);

    const bal = await rlusdBalance(client, treasury.address);
    console.log(`treasury RLUSD balance: ${bal}`);

    const memo = {
      Memo: {
        MemoType: convertStringToHex("aishop4u/spike"),
        MemoData: convertStringToHex(JSON.stringify({ session_id: "s_spike", action: "purchase.settled" })),
      },
    };

    let payment: Payment;
    if (Number(bal) >= 1) {
      payment = {
        TransactionType: "Payment",
        Account: treasury.address,
        Destination: shop.address,
        Amount: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: "1" },
        Memos: [memo],
      };
      console.log("sending 1 RLUSD treasury -> shop ...");
    } else {
      payment = {
        TransactionType: "Payment",
        Account: treasury.address,
        Destination: shop.address,
        Amount: xrpToDrops("1"),
        Memos: [memo],
      };
      console.log("no RLUSD yet: fund the treasury at https://tryrlusd.com then rerun. Sending 1 XRP instead ...");
    }
    const t0 = Date.now();
    const res = await client.submitAndWait(payment, { autofill: true, wallet: treasury });
    const meta = res.result.meta;
    const code = typeof meta === "object" && meta ? meta.TransactionResult : "?";
    console.log(`Payment: ${code} in ${Date.now() - t0}ms`);
    console.log(`tx ${res.result.hash}`);
    console.log(`explorer ${EXPLORER}${res.result.hash}`);
    console.log(`shop RLUSD balance now: ${await rlusdBalance(client, shop.address)}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
