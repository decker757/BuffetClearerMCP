# Pitch review, 5 Sep 2026

Written on branch `vendor` after an independent review of the **pitch**, not the code.
No code changed. Everything here is framing plus one optional feature that sits below a
cut line.

**This document changes no invariant and overrides no §15 decision.** Where it proposes
a build (item 7), that build is explicitly optional and last.

**For coding agents:** read this before writing pitch copy, slide text, README marketing
prose, or any tool description the model sees. If a change you are about to make
contradicts the "What not to say" section, stop and flag it.

---

## One line

The build is in better shape than the pitch. That is a good problem, and it is fixable in
an afternoon. **Do not pivot. Do not rewrite anything.**

---

## 1. The problem

The challenge's north star, from `ripple/README.md`:

> Build something where removing the AI agent or removing autonomous payments would
> fundamentally weaken the product.

Run that on us. Strip XRPL out and have the server place orders by card. We lose the
on-chain receipt. We keep the recommendations, the selection, the approval, the event log
and the spending cap. **The product mostly survives.** That is the tell, and a judge will
find it.

Three related soft spots:

| # | Soft spot | Why it matters |
|---|---|---|
| 1 | **Our cap claim is looser than CLAUDE.md makes it sound.** Invariant 1 says "the budget is the balance, the agent cannot pay more because there is nothing there to spend." But `packages/payments/src/purchase.ts` funds the wallet from the treasury seed, server-side. The cap is **server-enforced and ledger-witnessed**, not physically enforced | Say the precise version on stage. The loose version invites the puncture, and a Ripple judge will find it in thirty seconds |
| 2 | **Every merchant in the demo is code we wrote.** No real shop accepts RLUSD over x402 yet | Reachability is 20% and names adoption and interoperability |
| 3 | **"An agent that shops for you" is a crowded lane.** OpenAI's ACP, Google's AP2, Mastercard Agent Pay and Visa Intelligent Commerce all shipped in the last year | If that is our headline we are the fifth entry on that slide |

---

## 2. What we are underplaying

Our Technical Depth evidence is genuinely rare and it is buried in the code instead of
being in the pitch:

- **We do not trust the shop's confirmation — we read the ledger.** The card capture is
  `spent = funded - remaining`, read from XRPL, not from what the shop claimed. There is
  a lying-shop test for exactly this (`packages/payments/src/purchase.test.ts`).
- 90 tests. Refusal tests as first-class. Bounded loss per line. Recovery after a lost
  HTTP response. Cross-process pool locking.
- `GET /sessions/:id/verify` — a judge can curl our hash chain.
- The §13 compliance answer: merchant of record, no stored value. Reachability names
  "compliance readiness" explicitly. Most teams will not have this at all.

Twenty seconds on these beats any amount of "trust is the product" rhetoric.

---

## 3. The fix

### 3.1 Free — do this regardless

**Reframe the headline** from "an agent that shops for you" to **"the control plane that
lets an agent spend at all."** Every network shipped a spec; none of them answers what
stops the agent overspending and who can verify what it did.

Then name the primitive as general: **a spend-control plane with two ports, one to a
merchant, one to a data provider.** The laptop is one instantiation. The market is
wherever delegated spend with hard caps and an audit trail is already blocked —
small-business procurement is the obvious one, because finance teams will not let agents
buy when there is no cap and no audit trail.

This earns Reachability credit without claiming to have built a platform. Slides only,
zero code.

**Add one slide showing the merchant side as code** — the ten lines of `requireX402` a
shop adds (`packages/shops/src/app.ts`), with the sentence "this is what a shop adds."
It answers "who would use this tomorrow" without pretending we have merchants.

### 3.2 Optional — only above 4 hours of real headroom

**Pay for the evidence behind the strike-through.**

Today the flagged listing is the model's opinion, and §8 admits it is not a deterministic
gate. Instead: when the agent wants to flag a listing, it pays **one** call (~$0.003) to
an x402-gated `GET /verify/:product_id` and gets a fact back — registered 6 days ago,
3 lifetime sales, 61% below median. The strike-through becomes verified, with an explorer
link next to it.

That single call is our north-star answer:

> No human approves a third of a cent to check one listing. Only an agent does, and only a
> rail that clears sub-cent can carry it.

Cards genuinely cannot do that. It upgrades our best existing demo moment instead of
adding a new one.

**Scope.** One endpoint on the shops server (`requireX402` is already wired in `app.ts`),
one treasury-paid client call reusing `packages/payments/src/x402client.ts`, one event
type, one widget chip. Roughly 3 hours if nothing surprises us. Phase review and
`docs/REVIEW-LOG.md` entry as usual before the commit.

**Two constraints that are not negotiable if this gets built:**

1. **One call, not twelve.** Payments settle sequentially — one XRPL account, one sequence
   stream, 6–9 s each through the facilitator (§7). Twelve lookups is 80–100 seconds of
   dead air in a three-minute demo.
2. **Paid from treasury, never from the session wallet.** Browse happens before checkout,
   so the session wallet does not exist yet, and invariant 1 says it is funded to exactly
   the approved item total. This is our operating cost, covered by the flat fee. The
   widget must not render it as the user's money.

---

## 4. What not to say on stage

1. **"Agents cannot get cards, issuers refuse them."** False. Visa Intelligent Commerce
   and Mastercard Agent Pay exist to do exactly that. Say instead: *a card credential is
   permission to pull, revocable and disputable after the fact, with the limit held by the
   issuer. A funded wallet is a balance, and the limit is arithmetic.*
2. **Do not quote the Ripple challenge deck unless you have opened it yourself.**
   `ripple/Singhacks-challenge-statement.pdf` is image-only with no recoverable text
   layer, so nothing in it has been verified. Misquoting the organiser's own deck in front
   of the organiser is a bad way to lose a point.
3. **Do not say the agent "cannot" overspend because the wallet is empty.** See §1, soft
   spot 1. Say server-enforced and ledger-witnessed.

---

## 5. Priority order

This supersedes the ordering in `docs/STATUS.md` for the remaining time.

| # | Task | Notes |
|---|---|---|
| 1 | Rehearse the main run in Claude Desktop | laptop, range **300–1300** so the planted listing is in range and gets flagged |
| 2 | Rehearse the contrast run | USB-C cable, range 5–30 |
| 3 | Record the backup video | live MCP plus live testnet on stage is two things that can fail |
| 4 | Slides, with the reframe in §3.1 | architecture diagram, who-pays-whom table, compliance line, live reserve numbers |
| 5 | Final builder feedback Google form | 10% of the score — https://forms.gle/FZckiEAMU8oWXVbX7 |
| 6 | OpenWallet: the 30-minute evaluation in §6 was never done | a Ripple judge **will** ask. Either try it or write the reasoning for the production-path slide |
| 7 | Product name | still "AIShop4U" as a working title; `@aishop4u/*` is a find-and-replace |

**— CUT LINE. Only cross it if 1–7 are actually done. —**

| # | Task |
|---|---|
| 8 | The paid verification call (§3.2) |

**Never:** twelve lookups per browse, an "ecosystem" deck, or a pivot. We have hours, not
days, and the compliance posture in §13 is a moat we would be throwing away.

---

## 6. Before any demo run

```bash
npm run sweep:shops            # mock shops hand their RLUSD back
npm run provision -- repair    # parked pool wallets back to idle
curl localhost:3001/health     # check the pool counts
```

Every test purchase drains the treasury. The first Claude Desktop approval of the night
failed on exactly this.
