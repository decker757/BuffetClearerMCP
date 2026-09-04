/**
 * Fund the treasury with testnet RLUSD without the web faucet.
 *
 * tryrlusd.com needs a GitHub login plus a browser wallet and caps at 10 RLUSD/day,
 * but testnet has an XRP/RLUSD AMM pool with deep liquidity. So:
 *   1. pull XRP from the XRP faucet (100 XRP per new account) and sweep it to the treasury
 *   2. swap XRP -> RLUSD through the AMM with a cross-currency self-payment
 *
 * Usage:  npx tsx scripts/fund-treasury.ts [targetRlusd=100]
 * Treasury = TREASURY_SEED from .env, else .wallets/spike.json.  Testnet only.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Wallet, dropsToXrp, xrpToDrops, type Payment } from "xrpl";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const WS = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";
const RLUSD = {
  currency: process.env.RLUSD_CURRENCY_HEX ?? "524C555344000000000000000000000000000000",
  issuer: process.env.RLUSD_ISSUER ?? "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
};
const EXPLORER = "https://testnet.xrpl.org/transactions/";
const TARGET = Number(process.argv[2] ?? "100");
const FAUCET_KEEP_XRP = 2; // leave reserve + fees in each throwaway faucet account
const SWAP_CHUNK_XRP = 200; // per swap, keeps slippage small against a ~700k XRP pool
const XRP_FLOOR = 25; // never swap the treasury below this; it pays reserves and fees

function loadTreasury(): Wallet {
  if (process.env.TREASURY_SEED) return Wallet.fromSeed(process.env.TREASURY_SEED);
  const f = path.join(ROOT, ".wallets/spike.json");
  if (!fs.existsSync(f)) throw new Error("no TREASURY_SEED in .env and no .wallets/spike.json; run spike:xrpl first");
  return Wallet.fromSeed((JSON.parse(fs.readFileSync(f, "utf8")) as { treasury: string }).treasury);
}

async function xrpBalance(c: Client, a: string): Promise<number> {
  return Number(dropsToXrp(await c.getXrpBalance(a).then(String).then(xrpToDrops)));
}

async function rlusdBalance(c: Client, a: string): Promise<number> {
  const r = await c.request({ command: "account_lines", account: a, peer: RLUSD.issuer });
  return Number(r.result.lines.find((l) => l.currency === RLUSD.currency)?.balance ?? "0");
}

function resultCode(res: Awaited<ReturnType<Client["submitAndWait"]>>): string {
  const m = res.result.meta;
  return typeof m === "object" && m ? m.TransactionResult : "?";
}

async function pullFromFaucet(c: Client, treasury: string, wallets: number): Promise<void> {
  const funded = await Promise.all(Array.from({ length: wallets }, () => c.fundWallet()));
  await Promise.all(
    funded.map(async ({ wallet, balance }) => {
      const send = Math.max(0, Number(balance) - FAUCET_KEEP_XRP);
      const tx: Payment = { TransactionType: "Payment", Account: wallet.address, Destination: treasury, Amount: xrpToDrops(send) };
      const res = await c.submitAndWait(tx, { autofill: true, wallet });
      console.log(`  faucet ${wallet.address} -> treasury ${send} XRP: ${resultCode(res)}`);
    }),
  );
}

/** Cross-currency self-payment: deliver RLUSD to ourselves, paying with up to `sendMaxXrp`. */
async function swap(c: Client, treasury: Wallet, sendMaxXrp: number): Promise<number> {
  const before = await rlusdBalance(c, treasury.address);
  // Ask for a generous amount and allow partial payment: the AMM delivers whatever SendMax buys.
  const tx: Payment = {
    TransactionType: "Payment",
    Account: treasury.address,
    Destination: treasury.address,
    Amount: { ...RLUSD, value: String(sendMaxXrp) }, // upper bound, more than XRP can buy
    SendMax: xrpToDrops(sendMaxXrp),
    Flags: 0x00020000, // tfPartialPayment
  };
  const res = await c.submitAndWait(tx, { autofill: true, wallet: treasury });
  const after = await rlusdBalance(c, treasury.address);
  console.log(`  swap ${sendMaxXrp} XRP -> ${(after - before).toFixed(4)} RLUSD: ${resultCode(res)} ${EXPLORER}${res.result.hash}`);
  return after - before;
}

async function main(): Promise<void> {
  const c = new Client(WS);
  await c.connect();
  try {
    const treasury = loadTreasury();
    console.log("treasury", treasury.address);
    let rl = await rlusdBalance(c, treasury.address);
    let xrp = await xrpBalance(c, treasury.address);
    console.log(`start: ${xrp.toFixed(2)} XRP, ${rl.toFixed(2)} RLUSD, target ${TARGET} RLUSD`);

    let rate = 3; // XRP per RLUSD, refined after the first swap
    while (rl < TARGET) {
      const needRl = TARGET - rl;
      const needXrp = Math.min(SWAP_CHUNK_XRP, Math.ceil(needRl * rate * 1.02));
      if (xrp - XRP_FLOOR < needXrp) {
        const wallets = Math.min(10, Math.ceil((needXrp + XRP_FLOOR - xrp) / 95));
        console.log(`pulling ${wallets} faucet account(s) ...`);
        await pullFromFaucet(c, treasury.address, wallets);
        xrp = await xrpBalance(c, treasury.address);
        continue;
      }
      const got = await swap(c, treasury, needXrp);
      if (got <= 0) throw new Error("swap delivered nothing; check the AMM / trustline");
      rate = needXrp / got;
      rl = await rlusdBalance(c, treasury.address);
      xrp = await xrpBalance(c, treasury.address);
      console.log(`now: ${xrp.toFixed(2)} XRP, ${rl.toFixed(2)} RLUSD (rate ${rate.toFixed(3)} XRP/RLUSD)`);
    }
    console.log(`done: treasury holds ${rl.toFixed(2)} RLUSD and ${xrp.toFixed(2)} XRP`);
  } finally {
    await c.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
