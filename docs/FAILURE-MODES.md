# Failure modes

What breaks, what the user sees, and where the money ends up. One row per failure,
each with the test that proves it.

The rubric asks "what happens if a transaction, service, or agent action fails?"
This is the answer, and it is the same answer every time:

> **The ledger is the truth.** The card is captured on what actually left the
> session wallet, never on what a shop said. Anything unspent sweeps back to
> treasury. Nothing is kept (invariant 8).

Three outcomes are possible, and which one you get is the whole design:

| Outcome | Meaning | What the user can do |
|---|---|---|
| **Refused** | Nothing moved. The session goes back to `checkout`. | Approve again, or abort. |
| **Failed (bounded)** | At most one order line's worth of RLUSD is at risk, logged with its tx hash. The rest sweeps back and the card is captured only for what settled. | Read the receipt: it names the line that did not go through. |
| **Held** | Money moved and we cannot reconcile it automatically. The session stays in `settling`; both `approve` and `purchase` are refused. | Nothing — deliberately. An operator reconciles; the user is told plainly. |

A **held** session is the rarest and the most important: retrying it would fund a
second wallet from treasury while the first still holds RLUSD, which breaks
invariant 6 twice (REVIEW-LOG phase 4).

---

## 1. Before any money moves

Every one of these is a **refusal**: no card hold, no RLUSD, session back to
`checkout`, and the user may approve again.

| Failure | Trigger | RLUSD | Card hold | Widget shows | Model is told | Events | Test |
|---|---|---|---|---|---|---|---|
| Treasury underfunded | Treasury RLUSD < the order's item total (every test purchase drains it — CLAUDE.md §9) | untouched | never authorised | ⛔ `refused: treasury_underfunded`; approval card returns | "Purchase refused: treasury holds X, the order needs Y … Nothing was charged. Ask the user to approve again." | `payment.refused{rule:"treasury_underfunded", treasury, needed}` | `chaos.test.ts` "refused before the wallet is taken or the card is touched" |
| Pool exhausted | Every pool wallet is busy or parked (§15.5) | untouched | never authorised | ⛔ `refused: pool_exhausted` with the pool counts | "Purchase refused … Nothing was charged." | `payment.refused{rule:"pool_exhausted", counts}` | `purchase.test.ts`, `tools.test.ts` "returns the session to checkout" |
| **Card declined** | The card authorisation fails (the ordinary failure once Stripe is live, §5 step 11) | untouched | not held | ⛔ `refused: card_declined`; approval card returns | "Purchase refused … Nothing was charged. Ask the user to approve again." | `payment.refused{rule:"card_declined"}` | `chaos.test.ts` "refused as a policy failure, so the user can approve again" |
| Quote tampered | The approved quote hash no longer matches the pending quote | untouched | never authorised | ⛔ `approval refused: quote_tampered` | "quote_tampered: quote changed after approval" | `approval.refused{rule:"quote_tampered"}` | `session.test.ts` "approval is bound to the quote hash and expires" |
| Approval expired | More than 5 minutes between approving and purchasing | untouched | never authorised | phase drops back to `approve`; the approval card returns | "approval_expired: ask the user to approve again in the widget" | `approval.refused{rule:"approval_expired"}` | `session.test.ts` (same test) |
| No approval at all | The model calls `purchase` without the widget's record (invariant 7) | untouched | never authorised | ⛔ `approval refused: not_approved` | "not_approved: the user has not approved this quote in the widget" | `approval.refused{rule:"not_approved"}` | `session.test.ts`, `tools.test.ts`, `00-guardrails.eval.ts` |

**Quote tampering is defence in depth, not a reachable path.** Any re-checkout
deletes the approval record, so the hash mismatch cannot be produced through the
public tool surface; the test mutates the record directly to prove the guard
fires. Said plainly here so nobody claims more than it does.

---

## 2. The shop never takes the money

The session wallet was funded, the shop failed before settling, everything sweeps
back. **Bounded loss: zero.** The card hold is released in full.

| Failure | Trigger | RLUSD | Card hold | Widget shows | Model is told | Events | Test |
|---|---|---|---|---|---|---|---|
| Shop 500 | The shop's order endpoint errors | funded, then swept back to treasury | released — one `card.released{reason:"nothing_settled"}` for the whole total | ✖ `failed: shop_error`; receipt says **Not settled** with the line and rule | "Partial: 0 of 1 settled. Card charged 0.00." plus the per-line rule | `session.funded` → `purchase.failed{rule:"shop_error", bounded_loss}` → `session.swept` → `card.released` | `chaos.test.ts` "nothing signed, the funded RLUSD sweeps back" |
| Shop unreachable | DNS/connection failure reaching the shop | funded, swept back | released in full | ✖ `failed: shop_unreachable` | same shape, rule `shop_unreachable` | `purchase.failed{rule:"shop_unreachable"}` | `chaos.test.ts` "same outcome, and the rule says which it was" |
| Facilitator unreachable, or the connection dies **before** the payment goes out | The SDK fails before anything is signed (t54 facilitator down, socket dropped early) | funded, swept back — the shop never saw a payment header | released in full | ✖ `failed: sdk_failed` | same shape, rule `sdk_failed` | `payment.quoted` → `purchase.failed{rule:"sdk_failed"}` → `session.swept` → `card.released` | `chaos.test.ts` "dies BEFORE the payment goes out" |
| Shop 402s again, having moved nothing | The shop takes the payment header and refuses to settle | funded, swept back | released in full | ✖ `failed: shop_re_402` | same shape, rule `shop_re_402` | `purchase.failed{rule:"shop_re_402"}` | `chaos.test.ts` "bounded loss is zero, the card is released" |
| Policy refusal (quoted ≠ demanded, wrong `payTo`, wrong issuer, wrong network) | The 402 does not match the approved line (§7) | funded, swept back — **nothing is signed** | released in full | ⛔ `refused: quoted_ne_demanded` (or the rule that fired) | "Partial: 0 of 1 settled" with the rule | `payment.quoted` → `payment.refused{rule}` → `session.swept` → `card.released` | `policy.test.ts` (12 tests), `purchase.test.ts`, `tools.test.ts` |
| Line exceeds the funded balance | Should be impossible: the wallet holds exactly the item total (invariant 1) | untouched for that line | on a single-line order the whole hold is released; on a multi-line order the rest is captured and this line comes back via partial capture | ⛔ `refused: insufficient_funded` | per-line rule | `payment.refused{rule:"insufficient_funded", spendable, needed}` | `purchase.test.ts` "a line the wallet cannot cover is refused" |

---

## 3. The shop takes the money

The dangerous half. The rule is REVIEW-LOG #1 and #3: **a failure after a payment
header was sent is "unknown", not "unpaid"** — ask the shop, then the ledger,
before deciding anything.

| Failure | Trigger | RLUSD | Card hold | Widget shows | Model is told | Events | Test |
|---|---|---|---|---|---|---|---|
| Response body unreadable, order recoverable | The shop settles but answers with a body carrying no order | left the wallet to the shop | captured for that line + fee | ✔ `settled` (recovered) with the explorer link | "Settled 1 item(s). Card charged …" | `payment.submitted` → `purchase.settled{recovered:true, after:"order_unparseable"}` → `card.captured` | `chaos.test.ts` "recovery reads the order back and the line counts as settled" |
| Response unreadable **and** the shop forgets the ref | The shop settles, answers with no order, and cannot find the ref afterwards | left the wallet: **bounded loss, one line**, tx hash recorded | captured on the ledger delta (the money did leave) | ✖ `failed: order_unparseable`; receipt shows **Not settled** | "Partial: 0 of 1 settled" with the rule | `purchase.failed{rule:"order_unparseable", bounded_loss, tx_hash}` + `purchase.failed{rule:"unreconciled"}` | `chaos.test.ts` "bounded loss is one line, recorded with its tx hash" |
| Shop takes the RLUSD and denies the order | The worst case: money moved, no confirmation | left the wallet to the shop's **registered** address | **captured** for what left the wallet, plus the fee | ✖ `failed: shop_re_402` and ✖ `failed: unreconciled` | "Partial: 0 of 1 settled. Card charged 899.25." | `purchase.failed{rule:"shop_re_402"}` → `purchase.failed{rule:"unreconciled", ledger_spent, lines_settled}` → `card.captured` | `chaos.test.ts` "the card is captured on what LEFT the wallet, and the mismatch is logged" |
| The connection dies **after** the payment lands | The shop settles; the response is lost on the way back | left the wallet to the shop | captured for that line + fee | ✔ `settled` (recovered) | "Settled 1 item(s). Card charged …" | `purchase.settled{recovered:true, after:"sdk_failed"}` → `card.captured` | `chaos.test.ts` "dies AFTER the payment lands" |
| Shop lies: claims a settlement that never happened | A dishonest shop answers "already settled" with a made-up tx hash | untouched | released in full | ✖ `failed: unverified_settlement_claim` | "Partial: 0 of 1 settled" | `purchase.failed{rule:"unverified_settlement_claim"}` | `purchase.test.ts` "a shop that lies about settlement is not believed" |

**Why we capture when a shop takes the money and denies the order.** The RLUSD
left our wallet to that shop's registered address; it is gone. Releasing the hold
would mean the customer keeps their money and we absorb the loss silently — and
worse, the alternative of sweeping the "unspent" remainder while releasing the
card is how you end up holding customer funds, which §13 says we must never do.
So we capture what the **ledger** says moved, emit `unreconciled`, and a human
chases the shop. CLAUDE.md §7's one-liner ("that line is released on the card")
describes the *clean* failure in section 2 above; this row is the other case.

---

## 4. After the shops are paid

| Failure | Trigger | RLUSD | Card hold | Widget shows | Model is told | Events | Test |
|---|---|---|---|---|---|---|---|
| Funding tx times out but validated | XRPL accepted the payment, the response was lost | confirmed by reading the balance; the run continues | normal | ⬇ `session funded` with `tx_hash: null` and a note | nothing unusual | `session.funded{tx_hash:null, note:"confirmed by balance after submit error"}` | `purchase.test.ts` "funding 'failure' that actually validated" |
| Funding genuinely failed | The treasury payment did not land | nothing moved | released in full | ⛔ refused; approval card returns | "Purchase refused … Nothing was charged." | `card.released{reason:"funding_failed"}` | `purchase.test.ts` "wallet goes to attention, card released" |
| Ledger drops after funding | The XRPL socket dies once RLUSD is in the wallet | **stays in the wallet**; the wallet is parked `attention` | left open | ✖ `failed: unexpected_after_funding`; **no receipt** (the session never reaches `done`) | "Purchase hit an unexpected error after it started. Nothing more will be charged automatically; the session is held for an operator." | `purchase.failed{rule:"unexpected_after_funding"}` | `tools.test.ts` "holds the session in settling: no second authorisation, no re-fund" |
| Sweep fails | The socket dies during the sweep back to treasury | settled lines are paid; the remainder is **stuck in the wallet**, parked `attention` | captured for what settled; the rest released via partial capture | ✖ `failed: sweep_failed`, plus the normal receipt | the receipt, with the failed line named | `purchase.settled` → `purchase.failed{rule:"sweep_failed"}` → `card.captured` + `card.released{via:"partial_capture"}` | `chaos.test.ts` "the wallet is parked for an operator" |
| Ledger unreadable at the end | The balance read after the payments fails, so we never learn what left the wallet | settled lines are paid; the remainder is stuck in the wallet, parked `attention` | captured on the **shops' confirmations**, which is the one place we do not have the ledger's word for it | ✖ `failed: ledger_unreadable` | the receipt, marked partial | `purchase.failed{rule:"ledger_unreadable", capturing_on:"shop_confirmations"}`, and the run is never `reconciled` | `chaos.test.ts` "the balance read fails" |
| Card capture fails | Stripe errors after the RLUSD has moved | already spent correctly | **not captured**; `card_error` on the result | the settlement rows are all still there | the receipt, with the settled lines and their tx links | `purchase.failed{rule:"card_error"}` | `purchase.test.ts` "card capture error never loses the result" |
| Retry after any of the above | `purchase` is called again for the same quote | settled lines are **recognised on-ledger and not paid again**; only the remainder is funded | a **fresh** authorisation each run — the mock card will capture twice, which Stripe would refuse (REVIEW-LOG "decided not to fix") | the earlier settlements re-appear as `recovered` | the receipt | `purchase.settled{recovered:true}` | `purchase.test.ts` "idempotent retry: settled lines are recovered on-ledger" |

---

## 5. The session and the process

| Failure | Trigger | RLUSD | Card hold | Widget shows | Model is told | Events | Test |
|---|---|---|---|---|---|---|---|
| User aborts before settling | The abort button in the widget | nothing has moved | none | phase `aborted`; billing cleared | "aborted" | `session.aborted` | `session.test.ts`, `tools.test.ts` |
| User aborts **during** settling | The abort button while lines are in flight | unaffected — the lines settle or fail on their own | unaffected | the abort is refused; the feed keeps running | "settling: lines are in flight; abort is refused, the receipt will say what settled" | none (refusal) | `session.test.ts` "refused while settling" |
| Session abandoned | No activity for 30 minutes | nothing funded before `purchase`, so nothing to sweep | none | phase `expired` | "unknown_session" on the next call | `session.expired` | `session.test.ts` "expireStale … but never a settling one" |
| Server restarts mid-session | Claude Desktop relaunches the server, or it crashes | nothing moved if `purchase` had not run | none | the dashboard still renders the whole session **from the log** | "unknown_session: no session s_…" — the approval is gone and cannot be spent against | none; the existing chain is intact and still verifies | `projection.test.ts` "a restart after approval loses the approval, keeps the record, and cannot spend" |
| Two server instances at once | Claude Desktop launches the stdio server more than once (REVIEW-LOG phase 6) | the pool file is locked per mutation: **two processes never hand out the same wallet** | — | whichever instance owns port 3001 serves every session, projected from the shared log | unaffected | — | `pool.test.ts` "two processes on one file never hand out the same wallet"; `projection.test.ts` cross-process tests |
| Invoice email fails | Resend is down or the key is missing | unaffected — the purchase already settled | unaffected | the receipt shows the settlement; `invoice_sent_to` reads `(failed)` | the receipt | order recorded first, mail attempted in a `try/catch` | **none** — the `(failed)` path is code (`shops/app.ts`), not a test |

---

## Open: what is *not* automatic

Two gaps, stated rather than hidden. Both are in REVIEW-LOG phase 7 as open findings.

1. **A funded wallet is not swept automatically.** §15.5 promises that a session
   funded but not settled within the timeout sweeps and releases the card.
   `pool.stale()` exists and is tested as a finder, but **nothing calls it**;
   `expireStale` only expires sessions and never touches one in `settling`. In
   practice a wallet parked `attention` is recovered by an operator running
   `npm run provision -- repair`, which refuses to touch a wallet still holding
   RLUSD. That is safe but manual. The automatic sweeper is a background job that
   moves money on a timer, and we were not willing to add one the day before a
   demo without a decision.
2. **The mandatory budget is not attributable.** `browse` refuses a missing or
   inverted range, but cannot tell a range the user gave from one the agent
   invented. Scenario 3 of the agent evals measures whether the model respects it.

## Running the chaos tests

```bash
npm test                                        # the whole suite, including the matrix above
npx vitest run packages/payments/src/chaos.test.ts   # just the failure modes
```

Every row above is a unit test against the fakes: a shop that speaks real x402 on
a real HTTP port, and an in-memory ledger. No testnet, no network, ~150ms. The
live equivalents are in the README's transaction table, where the funding, the
purchase and the sweep of a real run are on-ledger with explorer links.
