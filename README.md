# Buffet

**A control plane that lets an AI agent shop and buy on your behalf, where every step it takes is visible, the purchase needs your approval, and the money it can move is exactly the total you approved.**

Built for the Ripple challenge at Singhacks 2026: an AI-native business on XRPL with x402 agentic payments. Claude is the shopping agent. Buffet is the MCP server and the inline widget between Claude and the money.

> Product name is a working title. Team: BuffetClearers.

---

## The problem

Shopping asks you to do the boring work and then make the important decision at the worst moment. You already know you want a laptop. Everything after that is lookup: which of these nine are in stock, is this price real, is this seller real. Then, tired and eight tabs deep, you make the actual choice.

An agent could do the lookup in ninety seconds. Nobody lets one *buy*, because that means handing your card to software that makes decisions you never see, for reasons it will not show you.

Buffet moves the line. The agent takes the lookup. The human keeps intent at the start and judgment at the end. And the reason you can hand over the boring part is that you can see it was done properly.

## What happens in a session

1. You tell Claude what you want. Claude calls `start_session`; the Buffet monitor opens inline in the chat.
2. Claude asks for a **price range**. It cannot browse without one: the inventory endpoint refuses, below the model.
3. Claude browses Buffet's inventory (the only products that can be bought), picks up to five, and **flags anything suspicious** with the numbers it is citing. Flagged rows are struck through in the widget and labelled as the agent's claim, never hidden.
4. **You select in the widget.** Not in chat. The selection is a server record the model cannot forge.
5. **You enter billing in the widget.** It never enters the model's context; the server holds it for the session and deletes it after the invoice is sent.
6. Claude calls `checkout`. The approval card shows items, the flat fee, and the total. **You approve in the widget.** The approval is single-use, bound to the quote hash, and expires in five minutes.
7. Claude calls `purchase`. The server authorises your card for the total, draws a session wallet from a pre-provisioned pool, funds it from Buffet's treasury with **exactly the item total in RLUSD**, pays each shop over **x402**, and captures the card for what the ledger says left the wallet. The last payment carries the session's manifest hash in its memo.
8. The receipt shows what settled, the explorer links, what was charged, and the manifest. Nothing is kept: no balance, no wallet of yours, no stored value.

Two runs on the same server show it is not hardcoded to one category: a laptop, then a USB-C cable.

## Why XRPL

Two jobs. It is the rail the purchase settles on, RLUSD from a session wallet that physically cannot hold more than the approved total, and it is the record: the hash of the session's append-only event log rides in the payment memo, so what the agent did and why is anchored somewhere neither we nor the shop can rewrite.

The session wallet is our answer to "why not just give the agent a card with a limit". A card limit is the issuer's and per-transaction. Ours is the wallet balance, below the model, plus a record that cannot be rewritten. Payment Channels lock to one destination; Permission Delegation (XLS-75) scopes by transaction type, not amount. A funded-to-the-cent wallet does both.

## Architecture

```
User's card ──authorise / capture (mocked; Stripe test mode is the next step)──▶ Buffet   [fiat leg]
                                                                                  │
Claude (chat) ── MCP ──▶ Buffet MCP server                                        │ "card ok → fund session"
                          │                                                       ▼
                          ├── model-facing tools                   treasury wallet (RLUSD + XRP)
                          │     start_session, browse,                        │
                          │     propose, checkout, purchase                   │ fund / sweep
                          │                                                   ▼
                          ├── app-only tools (widget only)          session wallet pool
                          │     session_snapshot, session_events,             │
                          │     select_candidate, submit_billing,             │ x402 purchase, one per shop
                          │     approve_quote, abort_session                  ▼
                          │                                         merchant (mocked for the demo)
                          ├── session manager + event log            two shops, free browse,
                          │     append-only, hash-chained            x402-gated orders, invoice email
                          │                                                   │
                          └── payment layer                                   ▼
                                ├── wallet pool (pre-provisioned)        XRPL testnet
                                ├── policy: quoted == demanded,          t54 x402 facilitator
                                │   payTo == registered, RLUSD only
                                ├── signer, x402 client (x402-xrpl)
                                └── ledger verifier (recovery is checked on-chain)

          ui:// resource (MCP Apps widget)   ◀── polls app-only tools
          /dashboard?session=<id>            ◀── same bundle, read-only, over HTTP
```

**Two rails, one bridge.** The card never touches the ledger. The treasury holds RLUSD; on testnet it is bought from the XRP/RLUSD AMM. The only link between the legs is server code: card authorised, therefore fund the session; lines settled, therefore capture. Buffet is the merchant of record: you pay in fiat for a service with a price cap, and the on-chain spend is our treasury paying our suppliers. You never hold stablecoin and we never hold a balance for you.

### The x402 flow

- The shop's order endpoint is gated by `requireX402` from the `x402-xrpl` SDK (one middleware instance per product, since the SDK fixes the price per instance). A request without payment gets a **402** with `PAYMENT-REQUIRED`: scheme `exact`, network `xrpl:1`, asset RLUSD (40-hex code) with issuer, `payTo`, amount, and an invoice id.
- Buffet's client fetches the 402 first so the terms become an event, then pays through `x402Purchase` with **our policy as the requirement selector**: the demanded amount must equal the approved line, `payTo` must be the registered shop address, the issuer must be the RLUSD issuer, amounts must be canonical. A mismatch is refused before anything is signed and logged as `payment.refused`.
- The signed Payment carries the invoice id, which is `<quote_id>:<line_id>:<manifest_hash>`, in the Memo and `InvoiceID` field. The hosted t54 facilitator verifies and settles; the shop then creates the order and emails the invoice. The facilitator consumes the invoice once, and the shop is idempotent on the same reference, so a retry never pays twice.
- Anything uncertain after a payment header was sent is resolved by asking the shop for the order by reference and **verifying the transaction on-ledger** (payer, destination, exact amount, invoice binding) before the card is captured. The card is captured on what the ledger says left the wallet, never on what a response body claimed.

### XRPL AI Starter Kit

We used three of its four parts. The **XRPL Payments** and **Agent Wallet** skills from `XRPLF/xrpl-dev-portal` were coding-time context for trustlines, RLUSD payments and agent transaction conventions (our payments carry the x402 `SourceTag` and a session memo, per the "track agent behaviour" guide). **x402 via t54** is the runtime piece: the `x402-xrpl` SDK on both the shop and the client, and the hosted testnet facilitator. The XRPL Docs MCP server was used by the coding agents, not the product. We also vendored the challenge repo's `xrpl-agentic-resources` skill for live reserve and amendment values.

## Governance, in one table

| Question | Answer |
|---|---|
| What can the agent do alone | Browse and recommend. Selection, billing, approval and the amount are all outside its reach |
| Spending limit | The session wallet holds exactly the approved item total; there is nothing else to spend |
| Approval it cannot forge | `approve_quote` is an app-only tool the model never sees; single-use, bound to the quote hash, five-minute expiry |
| Transparency | Every tool call and payment is an event; model-stated reasons are labelled "agent", server facts "server"; every rejection is shown struck through with the reason |
| Traceability | Hash-chained log per session; manifest hash in the purchase memo; `GET /sessions/:id/verify` re-hashes the chain from genesis |
| Failure handling | Policy refusals before signing; bounded loss per line; ledger-verified recovery; sweep and card release; parked wallets need a human |
| Untrusted input | Seller text is data, never instructions: typed, clipped, rendered as text; the 402 is checked field by field against what we already know |

## Transactions on XRPL testnet

From the first end-to-end run driven by a human inside Claude Desktop (session `s_27aac348d068e8fd`, 5 Sep 2026):

| Step | Hash |
|---|---|
| Treasury funds the session wallet, 849.00 RLUSD | [FA30FF15…4F21D9](https://testnet.xrpl.org/transactions/FA30FF15AC81D469BD9D526336A4D1C1E1EE58FD71940EB4605552226C4F21D9) |
| Session wallet pays shop B over x402, manifest in the memo | [88ABD099…247BB7](https://testnet.xrpl.org/transactions/88ABD099BB5C264EB8474C4C6322E558F219BF976AF9F98F5042A529AC247BB7) |

Earlier verified transactions:

| Step | Hash |
|---|---|
| RLUSD trustline, treasury | [ECE0BB7F…E6F33](https://testnet.xrpl.org/transactions/ECE0BB7F9252CE5D9C7E6015B061FE929B5640261E8A6F656F5C6FD82EDE6F33) |
| RLUSD trustline, shop A | [C9E061BC…99BC](https://testnet.xrpl.org/transactions/C9E061BC517566862B50587F996BDAC08AFF6B96A20F9B987FD3F22E123A99BC) |
| Treasury buys RLUSD from the testnet AMM, 92 XRP → 32.66 RLUSD | [6470DC87…0DB26](https://testnet.xrpl.org/transactions/6470DC879B908F52E1F7697AC190CC77DB99D1E401B270B36497B5441820DB26) |
| First x402 purchase, 3.90 RLUSD | [467D1799…BC32](https://testnet.xrpl.org/transactions/467D17997DE13C9E057A67CE30BE075AFB92C7599BB2B24C9D8CED9EE531BC32) |
| Full fund / pay / capture through the payments layer, 16.90 RLUSD | [EB6874C6…3824](https://testnet.xrpl.org/transactions/EB6874C697E4DF35D3D1DC45DA6B4011C2B8BAAC29C0DC07398716537FF13824), [7D8953A5…0434](https://testnet.xrpl.org/transactions/7D8953A50AD651A2A42AEC1D140B88D470FB6E7016C6EAC48CA8A2F48DE0B434) |

Refusal events are first-class: every session in `.sessions/` from the driver runs contains an `approval.refused` event where purchase was attempted before approval, and the unit suite covers `payment.refused` for a 402 that demands the wrong amount or the wrong destination. The judge-facing endpoints:

```
curl localhost:3001/sessions/<id>          # snapshot, never billing content
curl localhost:3001/sessions/<id>/events   # the chain
curl localhost:3001/sessions/<id>/verify   # re-hash from genesis
```

## Setup

Requirements: Node 22, npm 10, Claude Desktop. Testnet only; no mainnet keys anywhere.

```bash
git clone --recurse-submodules https://github.com/decker757/BuffetClearerMCP.git
cd BuffetClearerMCP
npm install
cp .env.example .env            # defaults are fine for testnet

npm run spike:xrpl              # creates .wallets/spike.json: treasury + a shop wallet, sets RLUSD trustlines
npm run fund:treasury -- 1500   # buys RLUSD from the testnet XRP/RLUSD AMM (no web faucet needed)
npm run provision -- shops      # two shop wallets with trustlines -> .wallets/shops.json
npm run provision -- pool 2     # session wallet pool -> .wallets/pool.json

npm run build                   # all packages, including the widget bundle
npm test                        # 90 tests: money math, hash chain, shops, policy, settlement, session, tools, projection
```

Run the mock merchant, then register the MCP server in Claude Desktop:

```bash
npm run dev -w @buffet/shops    # http://localhost:4002
```

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "buffet": {
      "command": "node",
      "args": ["<absolute path>/packages/mcp-server/dist/main.js", "--stdio"]
    }
  }
}
```

Quit Claude Desktop from the tray and reopen. In a new chat with web search off: **"Use Buffet: I want to buy a laptop."** Give a range like 300 to 1300 so the planted too-good-to-be-true listing is in range.

Without Claude, the whole loop can be driven by script against the real shops and testnet:

```bash
npm run dev:mcp                          # http://localhost:3001 (MCP over HTTP + read endpoints + /dashboard)
npx tsx scripts/mcp-smoke.ts "laptop" 500 1300
```

Before a demo: `npm run sweep:shops` (the mock shops hand their RLUSD back to the treasury), `npm run provision -- repair`, then `curl localhost:3001/health`.

## Repository

```
packages/shared      money math (integer cents), canonical JSON + hash chain, zod schemas
packages/payments    policy, wallet pool, mock card, XRPL ledger + verifier, x402 client, settlement
packages/shops       the mock merchant: seeded catalog, free browse, x402-gated orders, invoice stub
packages/mcp-server  event log, session manager, tool surface, HTTP reads, dashboard route
packages/widget      the MCP Apps monitor (single-file bundle), also the read-only dashboard
scripts/             provisioning, funding, sweeping, drivers
data/catalog.json    16 products across two shops, one planted bad listing
docs/REVIEW-LOG.md   every mistake the phase reviews caught, why it mattered, and the test that guards it
CLAUDE.md            the full design: invariants, build order, decisions, demo script, compliance posture
```

## Testnet, and what changes on mainnet

Everything above runs on XRPL testnet with the hosted t54 testnet facilitator. On mainnet: the treasury is topped up from an exchange as a periodic operation rather than from the AMM; each pool wallet locks the base reserve plus one owner reserve for the trustline (live values are vendored under `ripple/skills/.../xrpl-fee-settings.json`); the card leg becomes Stripe with manual capture; seeds move from files to a KMS; and the merchant is a real shop that added one header.

## Roadmap, not built

Per-query micropayments for comparison data (price history, spec databases) at fractions of a cent, from the same wallet and into the same log. Kept out of this build on purpose.
