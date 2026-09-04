# CLAUDE.md

Project guide for humans and coding agents. Read this before writing code.

> **TODO before first commit:** pick a product name. Confirm the demo vertical
> (proposed: laptop; contrast run: USB-C cable). Replace `PRODUCT_NAME` and
> `VERTICAL` throughout.

> **Do in the first 15 minutes:** install the builder feedback hook (§14). It is
> 10% of the score, it is project-scoped, and every one of us does it.

> **The rubric lives in `ripple/`** (git submodule of
> github.com/Singhacks-2026/ripple). `README.md` there is the judging source of
> truth: criteria, features checklist, submission format, governance questions.
> `resources.md` is the tooling list. Check every product or pitch decision
> against that README before §14 here. Run `git submodule update --init` after
> cloning.

> **4 Sep team decisions are in §15 and are authoritative.** The flow is: free
> browse → 5 recommendations → user selects in the widget → billing in the widget
> → card charged for the exact total → session wallet funded to that total → x402
> purchase per shop → receipt. No paid data lookups in this build. Risk flags come
> from the agent's own reasoning, not a server rule engine. §15.5 sizes the wallet
> pool; §15.6 is how sessions are tracked.

---

## 1. What we're building

**One line:** A control plane that lets an AI agent shop and buy on your behalf,
where every step it takes is visible, the purchase needs your approval, and the
money it can move is exactly the total you approved.

**Surface:** An MCP server plus an MCP Apps widget that renders inline in the
conversation. Claude first; any MCP host in principle. The widget is the product
surface. A thin fallback page over the same event stream exists as demo insurance
(§5, step 1), not as a product.

### The problem — start here

**Shopping asks you to do the boring work and then makes the important decision at
the worst possible moment.**

You have already decided you need the thing. Everything after that is logistics:
which of these nine are actually in stock, is this price good or does it just say
"was $499", is this seller real, does this one fit with what I already have. None
of that is judgment. It is lookup. But it is what eats the hour.

Then at the end, tired and eight tabs deep, you make the actual choice. The part
that needed you, you do worst.

This is true for towels. It is much more true for a laptop, a mattress, or a used
car, where you are spending real money on something you buy once every five years
and have no way to know whether you chose well.

**The obvious fix is the one you won't accept.** An agent could do that hour in
ninety seconds. But letting it buy means handing your card to software that makes
decisions you never see, from sources you cannot check, for reasons it will not
show you. So you don't. You go back to the tabs.

### Where the line goes

The agent takes **lookup**: verification, filtering, price checking, stock,
compatibility, seller legitimacy. The human keeps **intent** at the start and
**judgment** at the end.

We are not removing the person from the journey. We are moving them to the part
that is theirs.

This is why the monitor is not a bolt-on safety feature. You can only hand off the
boring work if you can see it was done properly. Visibility is what makes the
delegation acceptable at all.

### Vision, wedge, product

- **Vision:** LLMs absorb the parts of the e-commerce journey that never needed a
  human, across the whole category.
- **Wedge:** start where the current journey fails hardest — expensive, infrequent
  purchases where the buyer is by definition not an expert.
- **Product:** the supervision layer that makes agent-led buying trustable enough
  for either.

Convenience gets the nod. Supervision is why it's ours and not Amazon's. Lead with
the first, pivot to the second within a sentence.

### Why XRPL, and what is roadmap

**In this build** the chain does two jobs. It is the rail the purchase settles on
(RLUSD to each shop, from a session wallet that holds exactly the approved
total), and it is the record: the manifest hash of the session's event log goes
into the payment memo, so what the agent did and why is anchored somewhere
neither we nor the shop can rewrite.

**Roadmap, not built:** per-query micropayments for comparison data (price
history, spec databases, review verification) at fractions of a cent, which no
card or subscription can price. The team decided on 4 Sep that this is
over-engineering for the demo. Keep it to one sentence on the roadmap slide and
do not build any of it. If a judge asks "why not just a card", the answer is the
session wallet and the record, not micropayments.

### Who pays whom

This is the commercial loop. Judges will ask for it by name.

| Who | Pays | To | For | Rail |
|---|---|---|---|---|
| Customer | item total + flat service fee | PRODUCT_NAME | a supervised purchase, at an approved total | card (fiat) |
| PRODUCT_NAME, as the customer's agent | item price | each shop | the item(s) | RLUSD on XRPL (x402) |

- **Flat fee, not a take rate.** The team message proposed 1.5%. Decision: flat
  (§11). A percentage is a take rate and reads as one to a judge; "tax" is the
  wrong word on stage in any case. If the team reopens this, disclose it on the
  receipt as a service fee.
- **The fee absorbs XRP network costs.** The customer-facing ledger is RLUSD only,
  so it balances to the cent (§2, invariant 6).
- **We are the merchant of record.** The customer pays us in fiat for a service
  with a price cap. The on-chain spend is our treasury paying our suppliers. The
  customer never holds RLUSD and never holds a balance with us. §13 has the
  reasoning and the language rules that keep it true.

### The loop

1. User says what they want to buy. `start_session` opens the widget. No money
   moves yet.
2. Agent asks for preferences, budget first. Budget is a price range and is
   mandatory: the browse endpoint rejects a request without one (§15.1).
3. Agent browses our inventory (free), picks 5, and flags anything suspicious in
   its own reasoning. Flags are shown struck through with the agent's stated
   reason (§8).
4. User selects one in the widget. If there are more items on the list, back to
   2. Otherwise the agent asks whether there is anything else.
5. User enters name, email, address in the widget. Never in chat.
6. Agent calls `checkout`. Server computes the total: item prices plus the flat
   fee. **That total is the ceiling.** Widget shows the approval card.
7. User approves in the widget. Approval is recorded server-side; `purchase`
   refuses without it.
8. `purchase`: the card is authorised for the total (mocked by default; real
   Stripe test-mode last, §5 step 11). A session wallet is drawn from the pool and
   funded from treasury to exactly the item total, in RLUSD. Each shop is paid
   over x402. The last payment carries the manifest hash in its memo. The card is
   captured. Each shop emails its invoice.
9. If a shop payment fails, that line is released on the card, the remainder
   sweeps to treasury, and the user is told which item did not go through.
   Nothing is kept.
10. At any point before purchase the user can abort. Nothing has been charged or
    funded, so abort is just a state change and an event.

### What it is not

Not a marketplace. Not a price comparison site. Not a payments product. **Not a
wallet: the user never holds a balance with us.** The transaction is a step in the
experience, not the experience.

---

## 2. Non-negotiable invariants

These are the product. If a change breaks one of these, it is wrong even if it
makes the demo smoother.

1. **The budget is the balance.** The session wallet is funded to exactly the
   approved item total. The agent cannot pay more because there is nothing there
   to spend. Never top up mid-session. Spendable is tracked in RLUSD, separately
   from the XRP reserve and fee float the wallet also carries.
2. **Signing authority sits below the model.** The model's only spending primitive
   is `purchase(quote_id)`, and it only settles the lines in an approved quote.
   The server decides whether to sign. There is no generic "send N to address X"
   tool exposed to the model, ever.
3. **The return address is fixed at wallet creation** and stored server-side. It
   is the treasury address, set in config. It is never derived from anything that
   passed through the agent, a seller response, or the widget.
4. **Seller output is data, never instructions.** Parse into typed structures.
   Drop free-text fields we don't need. Anything shown to the model is wrapped and
   labelled as untrusted third-party content. **Anything shown in the widget is
   rendered as text, never HTML.** A `<script>` in a product title is the cheapest
   attack on the demo.
5. **Every rejection is visible.** If the agent skipped the cheapest option, the
   monitor shows it struck through with the agent's stated reason. A filter the
   user can't see is not supervision. Because the flag comes from the model (§8),
   the widget labels it as the agent's claim, not a server-verified fact.
6. **The ledger balances at the end.** In RLUSD, to the cent:
   `charged = items + fee` and `funded = settled + released`. The fee absorbs XRP
   network costs so they never appear as a stray line. The numbers add up on
   screen.
7. **Purchase requires a human approval the model cannot forge.** The widget's
   `approve_quote` is an app-only tool the model cannot call. It records approval
   server-side, bound to the quote hash, single-use, short expiry.
   `purchase(quote_id)` refuses unless that record exists. "Human keeps judgment"
   is enforced the way invariant 2 is, not described.
8. **No stored value.** Remainders are released, never kept. No balance screen, no
   "add funds", no "use it next time". §13 explains why this is not negotiable.

---

## 3. Architecture

```
User's card ──authorise / capture (Stripe; mocked by default)──▶ PRODUCT_NAME   [fiat leg]
                                                                    │
Claude (chat) ── MCP ──▶ MCP server                                 │ "card ok → fund session"
                          │                                         ▼
                          ├── model-facing tools               treasury wallet (RLUSD + XRP)
                          │     start_session, browse,                    │
                          │     propose, checkout, purchase               │ fund / sweep
                          │                                               ▼
                          ├── app-only tools (widget only)         session wallet pool
                          │     session_snapshot, session_events,         │
                          │     select_candidate, submit_billing,         │ x402 purchase, one per shop
                          │     approve_quote, abort_session              ▼
                          │                                       shop A, shop B (ours; free browse,
                          ├── session manager + event log          x402-gated purchase, invoice email)
                          │     append-only, hash-chained, seq-ordered    │
                          │                                               ▼
                          └── payment layer                          XRPL testnet
                                ├── wallet pool (pre-provisioned, trustlines set)
                                ├── policy: quoted == demanded, one payment
                                │           per order line, idempotent
                                ├── signer (OWS if the 30-min timebox works, else ours)
                                └── x402 client

          ui:// resource (MCP Apps widget)  ◀── polls app-only tools
          /dashboard (fallback page)        ◀── GET /sessions/{id}, /events?after=N
                                                (same event log, same shapes)
```

### Two rails, one bridge

Stripe never touches the ledger. The treasury holds RLUSD — faucet on testnet; an
exchange or Ripple distribution partner on mainnet, as a periodic treasury
operation, not a per-user conversion. The only link between the legs is server
code: card authorised → fund session; all lines settled → capture. Say it on
stage: *"Fiat in via card, stablecoin out via XRPL, the server is the bridge, and
that's deliberate."*

### Rail split

The merchant purchase settles on whatever the merchant accepts. For the demo the
shops are ours and accept RLUSD over x402. In production, one-time issued cards
are the adapter for reaching existing commerce; that is the stated production
path, not something we build.

### Tool surface

Model-facing — the agent may call these:

| Tool | Does | Spends? |
|---|---|---|
| `start_session(objective, reason)` | creates the session record, returns `session_id`, opens the widget | no |
| `browse(query, min_price, max_price, reason)` | free GET to our inventory gateway; **400 without a price range**; returns typed product objects, never raw seller text | no |
| `propose(recommended[], rejected[], reason)` | up to 5 recommended ids, plus any ids the agent flagged with a reason and the numbers it cites; emits `candidate.*` events; widget shows the decision table | no |
| `checkout(reason)` | totals the selected lines plus the flat fee, emits `quote.ready`; refuses if billing is missing | no |
| `purchase(quote_id)` | refuses without a server-side approval record (invariant 7); authorises the card, funds the session wallet to the item total, pays each shop over x402, captures, emits the receipt | yes |

App-only — the widget calls these, the model never sees them: `session_snapshot`,
`session_events`, `select_candidate(candidate_id)`,
`submit_billing(name, email, address)`, `approve_quote(quote_id)`,
`abort_session(session_id)`. Billing details never pass through the model; the
server holds them per session (§15.6).

Every model-facing tool takes a `reason`. The server turns it into an
`agent.intent` event. There is no separate "think" tool; the model would forget to
call it.

**Decision taken here: the model does not choose URLs.** `browse` hits our
inventory gateway only. There is no `fetch_paid_resource` and no provider
discovery in this build (§1 roadmap).

---

## 4. Repo layout

```
/mcp-server        MCP server, tool surface, session manager, event log, HTTP read endpoints
/widget            MCP Apps view (ui:// resource)
/dashboard         thin fallback page over the same event stream (demo insurance)
/payments          treasury, wallet pool, policy, signer, x402 client
/shops             inventory gateway (free browse), x402-gated purchase, invoice email; two shops, one process
/data              seeded catalog (JSON/SQLite), including the planted bad listing
/scripts           provisioning, faucet funding, trustline setup, pool sizing
/tests             the refusal tests live here from day one
```

---

## 5. Build order

Ordered by risk, not by dependency. Steps 1 and 3 can kill the project, so they
go first.

| # | Task | Why it's here | Cuttable |
|---|---|---|---|
| 0 | Feedback hook installed by all four, project-scoped (`.claude/settings.json` points at `ripple/hook/agents/claude-code/stop-hook.mjs`; each person runs `TEAM_NAME=… HACKER_NAME=… node ripple/hook/setup.mjs --non-interactive` once). `/xrpl-agentic-resources` loaded; run its `refresh.sh` once to vendor the t54 and XRPL repos. Install the XRPL Payments and Agent Wallet skills (§6) | 10% of the score, 15 minutes | No |
| 1 | Hello-world MCP App that renders a box. **Timebox: 2 hours.** If it fails, `/dashboard` is the demo surface and the widget becomes a stretch goal | If Claude shows the text fallback instead of the iframe, we need to know in hour one, not hour twenty | No |
| 2 | Name confirmed, vertical confirmed | Blocks the demo script and every README | No |
| 3 | Shop A: seeded catalog, free `browse` that 400s without a price range, x402-gated `purchase` with a real 402 and real RLUSD settlement | Proves the payment leg end to end | No |
| 4 | Treasury + wallet pool (§15.5) + policy: quoted == demanded, idempotent per order line | The core product claim | No |
| 5 | MCP server: tool surface in §3, session manager (§15.6), hash-chained event log, app-only tools, approval record | The spine | No |
| 6 | Monitor widget: phase strip, budget bar, event feed, decision table, selection, billing form, approval card, receipt (§12) | The visible product | No |
| 7 | Planted too-good-to-be-true listing in seed data; `propose` accepts agent flags and emits `candidate.rejected`; widget strikes them through | Best demo moment we have | No — it is a seed row and one event type |
| 8 | Manifest hash in the last purchase payment's memo | Zero extra transactions; closes the "why a ledger" argument | No |
| 9 | Refusal tests: `purchase` without an approval record is refused; a quote whose lines exceed the funded amount is refused; a browse without a range is a 400. Each emits an event | "Testing and safeguards" is in the Technical Depth criterion. One test beats a ninth feature | No |
| 10 | Shop B (same code, second seed and wallet) + invoice email on `purchase.settled` | Two shops is the acceptance criterion; email is one call | Email yes; shop B no |
| 11 | Real Stripe test-mode authorise + capture (PaymentIntent, manual capture, 4242 card) | Makes "your card was charged $912.25" real on screen | Yes — mocked by default |
| 12 | Backup demo video | Live MCP plus live testnet is two things that can fail on stage | No. Record it tonight |

### Workstream split

Four tracks, four people. Every track has a named owner from hour one.

- **Payments** — steps 3, 4, 10, 11. Owns `/payments`, `/shops`, `/scripts`.
  Deliverable: `purchase` that settles each approved line or refuses, with every
  attempt logged as an event. **Pay the shops in parallel** when there is more
  than one; XRPL settles in ~4s each.
- **Server** — steps 5, 8, 9. Owns `/mcp-server`, `/tests`. Deliverable: a session
  that runs end to end with fake data, plus the HTTP read endpoints.
- **Frontend** — steps 1, 6, and `/dashboard`. Owns `/widget`. Deliverable: a view
  that renders the event stream and can push a selection, billing details and an
  approval back.
- **Data and demo** — step 7 plus `/data`, the demo script, the video. Owns
  `/data`. Deliverable: two seeded shops, one planted listing, the agent's
  instructions for flagging it (§8), and the recording.

Integrate at the event stream. The schema is in §12; mock against it from hour one
so the tracks don't block each other.

---

## 6. XRPL notes

Read these before touching `/payments` or `/scripts`.

- Accounts carry a **base reserve** that is locked and unspendable. Holding a
  token needs a **trustline**, which adds an owner reserve on top. Pull current
  values from `/xrpl-agentic-resources`; they change by validator vote.
- **Fund reserve + budget, track spendable separately.** A wallet funded with
  exactly the budget fails its last payment. The monitor shows *spendable*
  balance, in RLUSD. If the bar counts the reserve, the bar lies.
- **Pre-provision and recycle wallets.** Creating an account and setting a
  trustline is three transactions and several seconds of dead air. Provision a
  pool at startup, grab an idle wallet at purchase time, sweep and return it
  after settlement. Sizing is §15.5.
- **Shop accounts need trustlines too.** A destination without one cannot
  receive the token and the payment fails. Provision them alongside the pool.
- **Payments must be idempotent.** A retry after a timeout otherwise pays twice.
  This covers *our* retries; seller misbehaviour is §7.
- **Sessions expire and sweep automatically.** Otherwise funds strand in wallets
  nobody remembers.
- **The sweep goes to treasury and carries the manifest hash as a memo.** One
  transaction, two jobs.
- **Mainnet onboarding cost is a Feasibility question.** Put the per-wallet
  reserve number on the slide, from live values, not from memory.

### XRPL AI Starter Kit — use it and say so

The README in `ripple/` recommends it and asks for an explanation of the
integration in the submission. It is four things, and we use three:

- **XRPL Payments skill** and **XRPL Agent Wallet skill** (from
  `XRPLF/xrpl-dev-portal`). Install into this repo with
  `npx skills add <url> --agent claude-code` (URLs in the getting-started page
  listed in `resources/xrpl-llms.txt`). They are coding-time context for
  trustlines, RLUSD payments and error handling, not runtime dependencies.
- **x402 via t54** — the `x402-xrpl` SDK and hosted facilitator (§7). This is
  the runtime piece.
- **XRPL Docs MCP server** — optional, for the coding agents, not the product.

Write one paragraph in the README on which parts we used and how.

### Verified values (2026-09-05, from the Starter Kit docs)

- RLUSD testnet issuer: `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`. Currency code as
  40-hex: `524C555344000000000000000000000000000000`.
- **Getting testnet RLUSD: do not use the web faucet.** tryrlusd.com needs a
  GitHub login plus a browser wallet extension and caps at 10 RLUSD per day.
  Testnet has an XRP/RLUSD AMM (~700k XRP / ~250k RLUSD, about 2.8 XRP per
  RLUSD). `npm run fund:treasury -- <amount>` pulls XRP from the XRP faucet
  and swaps through the AMM with a cross-currency self-payment. Verified
  5 Sep: 92 XRP → 32.66 RLUSD in one tx.
- Testnet WebSocket: `wss://s.altnet.rippletest.net:51233`.
- Reserves from `ripple/skills/xrpl-agentic-resources/resources/xrpl-fee-settings.json`:
  base 1 XRP, owner 0.2 XRP per object, base fee 10 drops. Re-run `refresh.sh`
  before putting them on a slide.
- Agent transaction conventions (xrpl.org "Track and Measure Agent Behavior"):
  a `SourceTag` on every agent payment and a hex JSON memo with
  `agent_id`, `session_id`, `action`, `task_id`. `x402-xrpl` stamps SourceTag
  `804681468` by default; keep it so the payments show up in XRPL's own agent
  analytics, and put our session id in the memo. That is free Technical Depth.

### OpenWallet (Open Wallet Standard)

A local, policy-gated signing library with XRPL support. Keys stay encrypted at
rest and are decrypted only inside the signing path, after a pre-signing policy
engine evaluates the agent's API-key operation (chain allowlists, expiry, custom
executables). The API never returns raw keys. In our terms it is invariant 2 as a
library: the agent holds a scoped key that expires with the session, not a seed.

Amount caps are not a first-class policy rule as far as we can see, so "budget is
the balance" stays our real enforcement; OWS adds key custody and per-session key
expiry. **Timebox: 30 minutes.** If the SDK fights us it goes on the
production-path slide. Either way we can say we evaluated it, because a Ripple
judge will ask.

### Why not the obvious primitives

Worth knowing so nobody re-litigates this mid-build, and so we can answer it on
stage:

- **Payment Channels** are structurally a one-time card — prefunded, capped,
  remainder refunded — but lock to a single destination. An order can span
  several shops, and a channel per shop per session is more setup than a wallet.
- **Permission Delegation (XLS-75)** is still in validator voting and scopes by
  transaction type, not amount. It gives "may send Payments", not "up to $50".

The session wallet is our answer to both.

---

## 7. x402 notes

- Payment is in-band. `purchase` calls the shop's order endpoint; the shop
  returns 402 with an `accepts` array carrying scheme, network, amount, asset,
  `payTo`, and timeout. We pay, retry with the payment header, and get the order
  confirmation.
- **Protocol pinned (§11): x402 v2 via `x402-xrpl` 0.3.2** (npm, TypeScript,
  depends on `xrpl` ^4.5). Headers `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` /
  `PAYMENT-RESPONSE`, scheme `exact`, network `xrpl:1` for testnet. Hosted
  facilitator: `https://xrpl-facilitator-testnet.t54.ai` (verify and settle).
  Shop side: `requirePayment` from `x402-xrpl/express` with `asset` set to the
  RLUSD 40-hex code, `issuer`, and `price` as a decimal string. Our side:
  `x402Purchase` / `x402Fetch` from `x402-xrpl`, which returns the settlement
  tx hash from `PAYMENT-RESPONSE`.
- **Replay protection is the invoice.** The 402 carries `extra.invoiceId`; the
  signed Payment commits to it via a Memo or the `InvoiceID` field, and the
  facilitator consumes it once. We key our own idempotency on `quote_id` +
  `line_id` and pass that as the shop's `invoiceId`, so both layers agree.
- **The `description` field in a 402 is attacker-controlled.** It reaches us at
  the exact moment we are making a spending decision. Invariant 4 applies.
- **Check quoted against demanded** before signing. The 402 amount must equal the
  line price in the approved quote, and `payTo` must equal the shop's registered
  address. Implement it as a custom `paymentRequirementsSelector` passed to
  `x402Fetch` that throws unless amount, asset, issuer and `payTo` all match;
  also pass `maxValue` as belt and braces. Anything else is refused and logged
  as `payment.refused`.
- **Manifest memo (closed).** The MCP server passes `invoice_ref =
  <quote_id>:<line_id>:<manifest_hash>` in the order body; the shop feeds it to
  the SDK's `invoiceIdFactory`, and the payer binds it into the Memo and the
  `InvoiceID` field of the Payment. The hash is on-ledger in the purchase tx and
  the facilitator consumes the invoice once, so it doubles as replay protection.

### Policy, all enforced below the model

- **One payment per order line per session.** Keyed on `quote_id` + `line_id`.
  A retry after a timeout never pays twice.
- **Quoted == demanded, payTo == registered.** Above.
- **Funded == approved.** The session wallet holds exactly the item total, so the
  sum of lines cannot exceed it. This is invariant 1, not a cap we check.

### Shop misbehaviour is bounded, logged, and terminal for that line

A shop that takes payment and returns 402 again, or returns a confirmation that
fails to parse, emits `purchase.failed` carrying the bounded loss (at most one
line price) and that line is not retried. The line is released on the card, the
remainder sweeps to treasury, and the receipt says which item did not go through.
This is our answer to "what happens when a service fails".

**Parallelize.** When an order spans two shops, pay them concurrently.

---

## 8. Risk flags

**Decision, 4 Sep: flags come from the agent's own reasoning, not a server rule
engine.** When the agent browses and sees a listing that looks wrong, it says so
and leaves it out of its 5, passing it to `propose` in `rejected[]` with a short
reason and the numbers it is citing from the product object.

What that looks like in the tool call:

```json
{ "rejected": [ { "id": "p_777",
    "reason": "price 61% below the median of the other results; 4.9 rating on 3 sales",
    "evidence": { "price": "349.00", "median_price": "899.00", "product_rating": 4.9, "quantity_sold": 3 } } ] }
```

The server records it as `candidate.rejected` with `source: agent`. The widget
strikes the row through, shows the reason as a chip, and labels it as the agent's
claim — the same italic-plus-badge treatment every model-authored row gets (§12).
Invariant 5 holds: the user sees what was skipped and why.

**What the agent is told to look for**, in its instructions, in this order:
price far below the others for the same product; a high rating on very few sales;
a shop rating far below the other shop; stock or description contradicting the
price. Numbers only. It should flag rarely; if everything is flagged, users stop
reading flags within about three sessions.

**Seed data carries one deliberately planted too-good-to-be-true listing** so the
rejection moment is guaranteed rather than hoped for. Make it obvious on two
signals at once (price and sales count) so any model catches it.

**What we do not claim.** This is not a deterministic gate; a different model run
could miss a listing. Say that plainly if asked, and say that the planted listing
plus the visible flag is the demo of the mechanism, while server-side rules are
the production path. A rule engine over the same fields is an afternoon if a
track finishes early.

---

## 9. Demo script

Two runs on the same server, to show it isn't hardcoded to one category. Under
three minutes total. **One item per run.** Mention the multi-item loop in one
sentence; do not demo it. Have billing details ready to paste.

1. **The main run.** High-stakes purchase in VERTICAL. Say what you want. Agent
   asks for a budget; give a range. Show the 5 recommendations and the planted
   listing struck through with the agent's reason and the numbers. Select one in
   the widget. Enter billing in the widget, not in chat, and say why. Approval
   card: item, shop, total, fee. Approve. Show the funding, the x402 payment with
   its explorer link, the manifest memo, and the receipt: charged, item, fee,
   card captured.
2. **The contrast run.** A trivial purchase. Same server, same monitor, same
   flow, done in seconds. Then one line: same control plane, any price point.

Say "testnet" out loud rather than hoping nobody notices, and follow it with what
changes on mainnet.

### Lines to have ready

Opening, consumer-first — not a system tour:

> "You don't need help deciding you want a laptop. You need help with the ninety
> minutes between that and buying one."

> "We're not replacing the shopper. We're taking the tab management."

Then pivot to the product within a sentence: *and the only reason you'd let it do
that is if you could see what it did.*

For "why a ledger":

> "We are not claiming shopping needs a blockchain. We are claiming that when
> software spends money on your behalf, the record of what it spent and why should
> not be rewritable by the software or the vendor."

For "are you custodial":

> "No. We're the merchant of record. You pay us in fiat for a service with a price
> cap; the on-chain spend is our treasury paying our suppliers. You never hold
> stablecoin and we never hold a balance for you."

For "what if a shop takes the money and doesn't deliver":

> "We lose at most that line, it's logged, that item is released on your card,
> and the receipt tells you."

For the rails:

> "Fiat in via card, stablecoin out via XRPL, the server is the bridge, and that's
> deliberate."

For "what about paid data" (roadmap, only if asked):

> "Next step. The same wallet and the same log can pay a price-history API a
> third of a cent per query. We kept it out of this build on purpose."

### Hard questions, one line each

- *Why not just give the agent a card with a limit?* A card limit is the issuer's
  and per-transaction. Ours is the wallet balance, below the model, plus a record
  neither we nor the vendor can rewrite.
- *Why does the wallet exist if it only holds the total?* Because the model
  cannot sign anything the wallet cannot cover, and the memo on that payment is
  the audit trail. Enforcement and record in one primitive.
- *What does this cost on mainnet?* Reserve per wallet (live number), a fraction
  of a cent per transaction. The flat fee covers it.
- *Why not OpenWallet?* Evaluated; see §6. Either we use it or we say why not.
- *Why not payment channels?* Single destination. See §6.
- *What can the agent do alone?* Browse and recommend. It cannot select, cannot
  see billing, cannot approve, and cannot pay more than the approved total.
- *Is the risk flag reliable?* It is the model's judgment, labelled as such on
  screen. Deterministic rules are the production path (§8).

---

## 10. Conventions

- Server-side state only. Widgets get destroyed and recreated; the view reloads
  from the server on init.
- Every payment attempt emits an event, including refusals. The event stream is
  the source of truth for the monitor and for the manifest.
- The event log is append-only and hash-chained. The manifest hash is the last
  event's hash.
- Every model-facing tool takes a `reason`. The server logs it as model-authored.
  The UI labels model-authored and server-verified events differently, always.
  Risk flags are model-authored (§8).
- Billing details live in the session record only. Never in an event payload,
  never in a tool result the model sees, never in logs.
- Log latency per span from day one. A waterfall view is a filter over data we
  already have.
- Seller-derived strings are rendered as text, never HTML, everywhere.
- **Language.** "Ceiling", "hold", "released". Never "your wallet", "your
  balance", "fund", "top up", "add funds" — in the UI, the README, or the pitch.
  §13 explains why the words matter.
- Secrets in `.env`, never in logs, tool responses, events, the manifest, or
  anything the model or the widget can see.
- Testnet everywhere. No mainnet keys in the repo, not even commented out.

---

## 11. Open decisions

| Decision | Status | Owner | Deadline |
|---|---|---|---|
| Product name | open | | before first commit |
| Demo vertical | proposed: laptop, contrast USB-C cable — confirm | | before first commit |
| x402 protocol version | **closed, 5 Sep** — v2, `x402-xrpl` 0.3.2, hosted testnet facilitator (§7) | | closed |
| Manifest memo mechanism | **closed, 5 Sep** — folded into `invoiceId` as `<quote_id>:<line_id>:<manifest_hash>`. The shop's order endpoint takes it as `invoice_ref`, feeds it to the SDK's invoice id factory, and the SDK binds it into both the Memo and the `InvoiceID` field. Verified on-ledger in tx 467D1799…BC32 | | closed |
| XRP or RLUSD | **RLUSD.** Dollars on the budget bar mean something; reserves are XRP regardless. Flip only if trustline setup blocks step 3 | | closed |
| Event schema | **closed** — §12 | | closed |
| Tool surface | **closed** — §3: browse / propose / checkout / purchase. The model does not choose URLs | | closed |
| Widget host | **closed, 5 Sep** — Claude Desktop, local stdio server in `claude_desktop_config.json`. Hello-world MCP App rendered inline on the first attempt (§5 step 1 passed). Tunnel + custom connector is the fallback only | | closed |
| OpenWallet | 30-minute timebox during step 4 | | step 4 |
| Stripe | mocked; real only after everything else is green | | step 11 |
| Fee amount | flat, placeholder $0.25. Team message proposed +1.5%; that is a take rate, and "tax" is the wrong word. Reopen only with a receipt line that says "service fee" | | step 6 |
| Payment model | **closed, 4 Sep** — card authorised for the exact total at checkout, session wallet funded to the item total, x402 per shop, capture after settlement. No top-up, no per-user wallet, no balance (§13, §15.4) | | closed |
| Paid data lookups | **closed, 4 Sep — not in this build.** Browse is free. x402 is the purchase only. Roadmap slide (§1) | | closed |
| Risk flags | **closed, 4 Sep** — agent-side, in its reasoning, surfaced through `propose.rejected[]` and labelled as the agent's claim (§8). Planted listing stays | | closed |
| Ceiling | **closed, 4 Sep** — the ceiling is the checkout total. The price range is a browse filter, not a hold (§15.1) | | closed |
| Budget range enforced server-side | **closed, 4 Sep — implement.** `browse` returns 400 without `min_price` and `max_price` | | step 3 |
| Multi-item cart loop | **adopted** as conversation flow (§15.1). Demo runs one item per run | | closed |
| Billing details | **adopted:** collected in the widget via `submit_billing`, never in chat (§15.1, §15.6) | | closed |
| Catalog store | team message: Postgres (Docker / RDS). Recommendation: SQLite or JSON seed for the demo, Postgres only if someone has spare hours (§15.3) | | step 3 |
| Pool size | **5 wallets for the demo** (§15.5). Revisit only if two sessions must run at once | | closed |

---

## 12. Events, endpoints, widget

Two things can be traced, one can't. We do not see Claude's reasoning; MCP gives
us tool calls. So we trace what the agent *said* it was doing (its `reason`
arguments and its risk flags) and what the server *verified* it did (402 quotes,
policy decisions, settlements), and we label them differently. "Agent's stated
reason" is a claim; "settled, tx 4F2A…" is a fact.

### Event shape

Every event is also a span, so the feed can render as a waterfall.

```json
{
  "session_id": "s_8f1", "seq": 31, "ts": "2026-09-05T03:12:44Z",
  "span_id": "pay_01", "parent_span_id": "purchase_01",
  "type": "purchase.settled", "source": "server",
  "duration_ms": 3840,
  "payload": {
    "line_id": "l_1", "shop_id": "shop_a", "product_id": "p_123",
    "quoted": "899.00", "demanded": "899.00", "asset": "RLUSD",
    "tx_hash": "4F2A…",
    "explorer": "https://testnet.xrpl.org/transactions/4F2A…",
    "spendable_after": "0.00"
  },
  "prev_hash": "…", "hash": "…"
}
```

`source` is `agent` (from a `reason` argument or a flag) or `server`. `hash` is
over the event plus `prev_hash`. **No event payload ever carries billing
details.** `billing.submitted` carries only a boolean and a hash.

### Event types

- Session: `session.started`, `session.aborted`, `session.expired`
- Agent: `agent.intent` — one per model-facing tool call, model-authored
- Browse: `browse.requested` (query and range), `browse.returned` (count only),
  `browse.refused` (no range)
- Candidates: `candidate.found`, `candidate.rejected` (agent flag: reason and
  evidence numbers, `source: agent`), `candidate.ranked`, `candidate.selected`
  (from the widget, `source: server`)
- Checkout: `billing.submitted`, `quote.ready`, `approval.granted`,
  `approval.refused` (purchase attempted without a record)
- Money: `card.authorised`, `session.funded`, `payment.quoted` (402 received),
  `payment.refused` (policy said no, with rule), `payment.submitted`,
  `purchase.settled`, `purchase.failed` (bounded loss), `session.swept`,
  `card.captured`, `card.released`, `manifest.anchored`, `invoice.sent`

Failures are first-class events, not exceptions.

### Endpoints

Two reads, exposed twice.

- `session_snapshot(session_id)` → phase, ledger (approved total / funded /
  settled / in-flight / fee), candidates with outcomes, selections, whether
  billing is present (never its content), pending quote, `head_seq`. The widget
  calls this on every init.
- `session_events(session_id, after_seq)` → events with `seq > after_seq`. Poll
  every second; the response is empty most of the time.

Exposed as app-only MCP tools (the widget's path inside Claude) and as
`GET /sessions/{id}` and `GET /sessions/{id}/events?after=N` over HTTP (the
fallback dashboard, and something a judge can curl). SSE with `Last-Event-ID` =
seq is a spare-hour upgrade, not a requirement.

Writes are `select_candidate`, `submit_billing`, `approve_quote` and
`abort_session`, all app-only. The `session_id` reaches the widget through the
structured result of `start_session`.

### Widget layout, top to bottom

- **Phase strip.** Preferences → Browse → Recommend → Select → Billing → Approve →
  Settle. Current one lit.
- **Budget bar.** Appears at checkout: approved total, funded, settled,
  in-flight, fee. RLUSD only. Before checkout it shows the price range as a
  label, not a bar; nothing is funded yet and the bar must not pretend otherwise.
- **Live feed.** One row per event: icon by type, one-line summary, duration on
  the right. Model-authored rows carry an "agent" badge and italic text; server
  rows carry a check mark and, for settlements, the explorer link. Rows expand to
  the payload. A payment in flight shows a live timer — without a visible
  in-flight state, four seconds of XRPL finality looks like a hang.
- **Decision table.** The 5 recommendations with price, shop, ratings, sales.
  Flagged rows struck through with the agent's reason as a chip and the "agent"
  badge; expanding shows the evidence numbers. A select button per row
  (invariant 7's mechanism, applied to selection). Invariant 5 on screen.
- **Billing form.** Name, email, address. Submitted through `submit_billing`.
  Shown once per session, before checkout.
- **Approval card.** Appears on `quote.ready`: items, shops, item total, fee,
  total to be charged, the approve button (invariant 7), the abort button.
- **Receipt.** On `card.captured`: `charged = items + fee`, one line per item with
  its explorer link, manifest link, "invoice sent to" with the email masked.

---

## 13. Compliance posture

Not legal advice; the shape of the argument for a judge. Get a real opinion before
mainnet.

**Why "top-up" doesn't get us out.** Under Singapore's Payment Services Act,
e-money is electronically stored monetary value pegged to a fiat currency, and
operating an e-wallet is a listed payment service. Money sitting in an account we
control that the user can spend later *is* stored value, however briefly we hold
it. The closed-loop exemption is for value usable only on the issuer's own goods,
which we are not.

**What does get us out: merchant of record.** The user does not deposit anything.
They buy a service from us at a capped price. A card hold for the ceiling, capture
for the actual spend, the rest released. Then:

- No stored value, so no e-money and no account issuance.
- The session wallet is ours. RLUSD in it is our treasury paying our suppliers. A
  business using stablecoin for its own operations is not providing a payment
  service to anyone. (For a Ripple judge: under the PSA a digital payment token is
  defined as not pegged to any currency, so a USD stablecoin sits in a different
  bucket from XRP — but for us the distinction is moot. Handling it *for users* is
  regulated either way; using it *for ourselves* is not.)
- The final purchase is us buying from the merchant as the user's agent, via a
  card programme or our own account. That is a concierge, not a payment
  institution.

What remains: clear pricing, the fee disclosed, a refund policy, our own
accounting, and our partners' licences (Stripe's, the card issuer's). That is a
normal startup compliance surface.

**Substance over form.** The regulator looks at what actually happens. Three
things pull us straight back into e-money territory, which is why they are
invariant 8 and a convention in §10:

1. Keeping remainders as a balance. Release the hold at sweep, always.
2. UI language. Keep the monitor; change the words. "Ceiling" and "hold", never
   "your wallet" or "your balance".
3. Bring-your-own-wallet. The moment a user's own RLUSD flows through us, we are
   transferring their tokens for them. Roadmap slide only.

**The line for the judge** is in §9 under "are you custodial". The follow-up:
*"The day we let users keep a balance or bring their own wallet, we'd need a PSA
licence or a licensed partner — and we know which one."*

---

## 14. Submission and judging map

### Checklist

- [ ] Feedback hook installed, project-scoped, by all four (step 0). Final Google
      form submitted at the end.
- [ ] Public GitHub repo with setup instructions and product overview.
- [ ] Architecture diagram (§3, drawn properly).
- [ ] Tx hashes and explorer links: funding, one purchase per shop, one refusal
      event, the payment carrying the manifest memo, one sweep from a failed-line
      run. The widget's event feed already has them; copy them into the README.
- [ ] Explanation of the payment flow (§1 loop + §3 two rails) and of the x402
      flow specifically (the README in `ripple/` asks for it by name).
- [ ] One paragraph on the XRPL AI Starter Kit integration: which skills we
      installed, that x402 runs through `x402-xrpl` and the t54 facilitator (§6).
- [ ] Backup demo video (step 12).

### What earns what

| Criterion | Weight | Where we earn it |
|---|---|---|
| Reachability (adoption, interop, compliance readiness) | 20% | consumer shopping is the market; MCP is host-agnostic and x402 is a standard; §13 is the compliance answer |
| Creativity | 20% | lead with the control plane — the session wallet as physical enforcement, selection and approval the model cannot forge, every rejection visible — not with "a shopping agent" |
| Feasibility (cost, performance, reliability, ops) | 20% | per-session cost is one payment per shop plus reserves, parallel shop payments, idempotency, expiry sweeps, bounded shop failure (§7), reserve costs on the slide |
| Technical Depth (XRPL + agent integration, security, safeguards, testing) | 20% | invariants 2, 7, 8; quoted == demanded; hash-chained log; manifest in memo; the refusal tests (step 9) |
| UX (how clearly agent actions, payments and txs are communicated) | 10% | the widget: reason per payment, explorer link per settlement, struck-through rejections, receipt |
| Builder Feedback | 10% | step 0 |

### Governance checklist judges will ask about

| Question | Answer lives in |
|---|---|
| Transparency — can users see what the agent did and why | §12 feed, invariant 5 |
| Authorisation scope — what it may do alone | §3 tool surface: browse and recommend; selection, billing, approval and the amount are all outside its reach |
| Spending limits | invariant 1, §7 policy |
| Key security | server-side custody, OWS evaluation, secrets convention |
| Traceability | hash-chained log, manifest in sweep memo, explorer links |
| Failure handling | §7 shop misbehaviour, idempotency, expiry sweep, abort |
| Safeguards against unintended transactions | invariants 2, 4, 7; quoted == demanded |

---

## 15. Team flow decisions (4 Sep)

Source: team message, 4 Sep 2026, plus the follow-up decisions the same evening.
This section is authoritative. §1 through §12 have been edited to match; if
something there still contradicts this, this wins and the other section is the
bug.

### 15.1 Conversation flow — adopted

The agent does **no retrieval until it has the user's preferences.** Budget is
mandatory.

1. User says what they want to buy. One item or a list. `start_session` opens
   the widget. Nothing is charged or funded.
2. Agent asks for preferences, budget first. Budget is a **price range**. If the
   user gives none, the agent keeps asking; nothing is fetched until it has one.
   **Enforced below the model:** `browse` returns 400 without `min_price` and
   `max_price`, and the refusal is a `browse.refused` event.
3. Agent calls `browse`, picks **5 recommendations**, ranked by quantity sold,
   product rating, shop rating (v1; richer ranking is a later iteration). Anything
   it finds suspicious goes in `rejected[]` with a reason (§8). The widget shows
   the 5 and the flagged rows struck through.
4. User selects one in the widget, through `select_candidate`. The selection is a
   server record the model cannot forge.
5. If the initial list has more items, go to 2 for the next one. Otherwise the
   agent asks whether there is anything else. Yes loops to 2. No continues.
6. **Billing details** (name, email, address) are collected **in the widget**
   through `submit_billing`, never typed into the chat, so they never enter the
   model's context. The server stores them against the session only (§15.6).
7. Agent calls `checkout`. The server totals the selected lines plus the flat
   fee. **That total is the ceiling.** There is no separate hold on the price
   range; the range is a filter, the total is the money. Widget shows the
   approval card.
8. User approves through `approve_quote`. Agent calls `purchase`: card
   authorised for the total, session wallet funded to the item total, one x402
   payment per shop, capture, receipt. Each shop emails its invoice.
9. Confirmation in chat and in the widget: which items, which shops, what was
   charged, where the invoice went.

**EC1 — nothing in range.** Say so. Show the few items closest to the budget
bound. Ask whether to proceed with one of those or change the range. Never
widen the range silently. Implementation: `browse` returns an empty list plus a
`nearest[]` array of up to 3 items just outside the range, so the agent does not
need a second call.

**What to guide the user to include** beyond budget: two or three
vertical-specific preferences at most (for a laptop: use case, screen size,
OS). Do not interrogate; the point is fewer questions than the tabs.

### 15.2 Shop contract — adopted

Two shops. Seeded catalog. Shape of a product:

```json
{
  "id": "p_123", "shop_id": "shop_a",
  "product_name": "…", "description": "…",
  "price": "899.00", "currency": "RLUSD",
  "product_rating": 4.6, "shop_rating": 4.8,
  "quantity_sold": 1240, "stock": 7
}
```

`id`, `shop_id`, `stock`, `currency` were not in the message but the flow needs
them. `description` is seller text: invariant 4 applies (typed, wrapped,
rendered as text).

Endpoints, per shop, behind one gateway:

- **Browse.** `GET /products?q=<name>&min_price=&max_price=` → product objects
  within the range, plus `nearest[]` when the list is empty. **400 without both
  bounds.** Free. The agent picks 5 from this.
- **Purchase.** `POST /orders` with `line_id`, `product_id`, `quantity`,
  delivery details. x402-gated: 402 with the line price in RLUSD and the shop's
  `payTo`; settle; retry with the payment header; 200 with an order id. On
  settlement the shop emails the invoice to the billing email.

Acceptance: real 402 on purchase; settlement on XRPL testnet; purchase idempotent
per `quote_id` + `line_id`; browse without a range is a 400; a product title
containing `<script>` renders as text in the widget.

### 15.3 Merchant-side services — a mock, not the product

**Where the line is.** The product is the MCP server, the widget, and the two
connections: card on one side, XRPL over x402 on the other. Everything the
message lists under "backend" (inventory with a DB, x402 payments, email,
gateway, broker for settlement → confirmation email) is the **merchant side**.
It exists because real shops that accept x402 do not exist yet, so we build two
to demo against. In production it is someone else's backend with one header
added. Say that on stage and draw it that way: one box labelled "merchant
(mocked for demo)", not five services on our side of the diagram.

**Build it as one process** under `/shops`, with the five as modules and an
in-process event bus; the broker is a handler that sends the invoice email when
an order settles. Split into containers only if a track finishes early. Catalog
store: SQLite or a JSON seed; Postgres on Docker is fine if someone wants it,
RDS is not worth the hour.

**"Visibility for everything, as a graph"** is the §12 event feed on *our* side.
Every tool call and every request the server makes to a shop is already a span
with `parent_span_id`, so the waterfall view is a filter over data we have. The
mock merchant needs no tracing of its own; a judge is watching the control plane,
not the shop.

### 15.4 Payment model — closed

The message proposed a Stripe top-up credited to a per-user wallet, reused
across sessions. **Not adopted**, because a balance the user paid in and can
spend later is stored value under §13, and "do you have a previous wallet" is
the first thing that makes it so. What is built instead, and it looks the same
to the user:

1. `checkout` produces a total: items plus flat fee.
2. `purchase` authorises the user's card for that total (Stripe PaymentIntent,
   manual capture; mocked by default).
3. A session wallet is drawn from the pool and funded from **our** treasury to
   exactly the item total in RLUSD. This is our money paying our suppliers.
4. One x402 payment per shop. The last carries the manifest hash in its memo.
5. All lines settled → capture the card for the total. A line failed → release
   that line on the card, sweep the unspent RLUSD to treasury, say so on the
   receipt.
6. The wallet returns to the pool holding only its XRP reserve. Nothing is kept
   for the user, nothing is remembered about their wallet, because they never
   had one.

Words: "charge", "authorised", "captured", "released". Never "top up", "your
wallet", "your balance", "credit".

### 15.5 Wallet pool sizing

A wallet is tied to a session only from funding to sweep, a window of a few
seconds to a minute. So the pool size is **peak concurrent purchases**, not
users, plus a buffer for wallets whose sweep failed and need a human.

- **Demo: 5 wallets.** Two runs on stage, one at a time, plus rehearsals. Five
  means the pool is never the thing that fails.
- **Cost per wallet** is the XRP base reserve plus one owner reserve for the
  RLUSD trustline. That XRP is locked, not spent, and comes back if the account
  is deleted. Put the live number on the feasibility slide, from
  `/xrpl-agentic-resources`, not from memory.
- **Provisioning** (`/scripts`): create N accounts from the faucet, set an RLUSD
  trustline on each, store address and encrypted seed server-side, mark `idle`.
  Do this once at startup, never during a session.
- **Pool states:** `idle` → `funded` → `paying` → `sweeping` → `idle`. A wallet
  stuck in `sweeping` past a timeout is marked `attention` and skipped; it is
  never handed to a session.
- **Empty pool:** `purchase` refuses with a clear error and a `payment.refused`
  event with rule `pool_exhausted`. It does not create a wallet on the spot;
  that is three transactions and several seconds of dead air, and the user has
  already approved a total that is now waiting.
- **Expiry:** a session funded but not settled within the timeout sweeps
  automatically and releases the card. Otherwise funds strand in wallets nobody
  remembers (§6).
- **Mainnet:** size from observed peak concurrency, grow as a treasury
  operation the same way RLUSD is refilled. Say that in one line if asked.

### 15.6 Session tracking

**There is no user account.** No login, no history, no balance. That is
deliberate and follows from §13: an account with a balance is what turns us into
an e-money issuer. The conversation is the session, and Claude carries the
`session_id` between tool calls.

A session is a server-side record, created by `start_session`, keyed by
`session_id`, holding:

- objective; the list of items still to shop for; the current one
- the price range for the current item
- phase (§12 phase strip)
- candidates from the last `propose`, with the agent's flags
- selections: one line per chosen item (`line_id`, `product_id`, `shop_id`,
  price at selection)
- billing details, stored here and nowhere else; never in an event, a tool
  result, or a log
- the pending quote and, if granted, the approval record (quote hash, single
  use, short expiry)
- the card authorisation id, the assigned wallet, per-line settlement state
- the head of its hash-chained event log

Everything the widget shows comes from `session_snapshot` and `session_events`
on that id. If Claude destroys and recreates the widget, it reloads from the
server; nothing lives in the iframe.

**One session, many items.** The cart loop in §15.1 runs inside one session: one
checkout, one authorisation, one wallet, several lines, one receipt. This keeps
one wallet per session and the ledger balances.

**Lifecycle:** `started` → `shopping` → `checkout` → `approved` → `settling` →
`done` | `aborted` | `expired`. Abort before `settling` is a state change and an
event. Abort during `settling` is refused; the lines are already in flight and
will either settle or fail on their own, and the receipt reports which.

**Retention:** billing details are deleted when the session reaches a terminal
state and the invoice has been sent. The event log and the manifest hash are
kept; they contain no personal data.

**If we later want "your past orders":** key on a Stripe customer id, keep the
receipts and manifest hashes, still no balance, still no wallet per user. That
is the whole change, and it stays on the roadmap slide.
