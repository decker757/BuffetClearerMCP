# Status, 5 Sep 2026, 03:30

Written for whoever picks this up in the morning. Read this, then `CLAUDE.md` §9 (demo
script) and `docs/REVIEW-LOG.md` (every mistake we made and the test that guards it).

> **Read `docs/PITCH-REVIEW.md` first.** It is the 5 Sep review of the pitch and it
> **supersedes the priority order below**. Short version: the build is in better shape
> than the pitch, the reframe is free, and the only proposed code change sits below a cut
> line after the video and the slides.

## Where we are, in one paragraph

**The whole product works end to end inside Claude Desktop.** A human said "Use AIShop4U:
I want to buy a laptop", gave a range, selected in the widget, entered billing in the
widget, approved in the widget, and Claude settled a real 849 RLUSD purchase on XRPL
testnet through x402: session wallet funded to the cent from the treasury, shop paid via
the t54 facilitator, manifest hash in the payment memo, mock card captured for 849.25,
receipt with explorer links. 90 tests pass. The README, the architecture diagram and the
transaction table are done. What is left is demo polish, the backup video, the slides,
and the final feedback form.

## What is built and verified

| Piece | State | Proof |
|---|---|---|
| Mock merchant (`packages/shops`) | done | 20 tests; real x402 purchases settled via the hosted facilitator |
| Payments layer (`packages/payments`) | done | 34 tests incl. budget refusal, policy refusals, lying shop, cross-process pool |
| MCP server (`packages/mcp-server`) | done | 27 tests incl. scripted driver over MCP; live over stdio and HTTP |
| Widget + dashboard (`packages/widget`) | done | rendered in Claude Desktop; `/dashboard?session=<id>` read-only |
| Event log + manifest | done | hash chain verifies via `GET /sessions/:id/verify`; memo on-ledger |
| Treasury / wallets | done | treasury ~652 RLUSD, 2 pool wallets idle, 2 shop wallets; all in `.wallets/` (gitignored, testnet seeds) |
| README | done | overview, architecture, x402 flow, Starter Kit paragraph, tx table, setup |
| Architecture diagram | done | `docs/architecture.svg` (drop into the slide) |
| Review log | done | `docs/REVIEW-LOG.md`, phases 1-6 |

## What is left, in priority order

**P0, before the pitch**
1. **Rehearse the main run** in Claude Desktop with range **300 to 1300** so the planted Dell XPS
   (349, rating 4.9, 3 sales) is in range and gets flagged and struck through. Our one successful
   human run used 750-1100 and had no flagged row; that row is the best moment we have.
2. **Rehearse the contrast run**: "Use AIShop4U: I need a USB-C cable", range 5 to 30. Seconds.
3. **Record the backup video** of both runs (§5 step 12). Live MCP plus live testnet on stage is two
   things that can fail.
4. **Slides**: architecture diagram, the "who pays whom" table, the compliance line
   ("we are the merchant of record"), reserve numbers from
   `ripple/skills/xrpl-agentic-resources/resources/xrpl-fee-settings.json`.
5. **Product name.** Still "AIShop4U" as a working title; `@aishop4u/*` package scope is a
   find-and-replace.
6. **Final builder feedback Google form** (10% of the score). The hook has been posting all night;
   the form is the wrap-up: https://forms.gle/FZckiEAMU8oWXVbX7

**P1, worth doing if there is time**
- Stripe test-mode card (PaymentIntent, manual capture, 4242) replacing `MockCardAuthoriser`.
  The interface is three methods in `packages/payments/src/card.ts`. Makes "your card was
  charged 849.25" real on screen.
- Widget polish for a projector: bigger type, the flagged row's evidence more prominent, receipt
  first. `packages/widget/index.html` has the CSS; `render.ts` the layout.
- A drawn diagram in the team's slide tool if the SVG does not fit the deck's style.
- OpenWallet: the 30-minute evaluation from CLAUDE.md §6 was not done. Either try it or put the
  written reasoning on the production-path slide. A Ripple judge will ask.

**P2, roadmap / say on stage, do not build**
- Per-query paid data lookups (micropayments). Kept out on purpose; one sentence on the slide.
- Widget-held token for app-only tools (today the host enforces visibility).
- Encrypted seeds / KMS; mainnet treasury operations.

## Known quirks you will hit

- **After rebuilding the widget or the server, quit Claude Desktop from the tray and reopen.** It
  caches the widget resource per connection.
- **Claude Desktop launches the server twice** (chat + Cowork/Code pool). This is handled: a stdio
  instance never dies over the HTTP port, the reads project from the shared log, the pool file is
  locked per mutation. Do not "fix" it back.
- **Claude may skip the tool** if web search is on or memory pulls in old notes. Web search off,
  fresh chat, name the tool in the opening line: "Use AIShop4U: ...".
- **Every test purchase drains the treasury** into the mock shops. Before a demo:
  `npm run sweep:shops`, `npm run provision -- repair`, `curl localhost:3001/health`.
- Claude Desktop puts the widget's follow-up message **in the chat box**; the user presses Enter.
  That is by design now (no message after Select; one after billing; one after approve).
- The shops server must be running (`npm run dev -w @aishop4u/shops`). The MCP server is launched by
  Claude Desktop itself; do not also run `npm run dev:mcp` at the same time unless you want a
  second instance (it works, but it is confusing).

## How to run, from cold

```bash
git clone --recurse-submodules https://github.com/decker757/BuffetClearerMCP.git && cd BuffetClearerMCP
npm install && npm run build && npm test
# wallets: ask Ihsan for .wallets/ (testnet seeds, gitignored) or provision your own:
#   npm run spike:xrpl && npm run fund:treasury -- 1500 && npm run provision -- shops && npm run provision -- pool 2
npm run dev -w @aishop4u/shops          # terminal 1, keep running
# Claude Desktop: register packages/mcp-server/dist/main.js --stdio (README has the JSON), restart from tray
# new chat, web search off: "Use AIShop4U: I want to buy a laptop"  → range 300 to 1300
```

Without Claude: `npm run dev:mcp` then `npx tsx scripts/mcp-smoke.ts "laptop" 300 1300` drives the
whole loop and prints the receipt and the verify result.

## Wallets (testnet, public addresses)

| Role | Address |
|---|---|
| Treasury | rGSJQHf2v5LJo8QABXNPWL2dPpeoAGpMHT |
| Shop A | r9oJdFAgucHk6diBWkX7B8moLdw3HfcAWE |
| Shop B | rUoczCtVSHAuVHcwcRsMFpr2mUxAN5ria1 |
| Pool 1 | rHETm7YH5XR7Ey1AmQtTMaLWmDC5PpocFH |
| Pool 2 | raWSEo5RQSWH2cpfvEtwZ93chRQMAYV7Jt |

Seeds are in `.wallets/*.json` on Ihsan's machine only. RLUSD comes from the testnet AMM
(`npm run fund:treasury -- <amount>`), not the web faucet.

## Working rules that got us here

- Every phase ends with an independent review agent; findings go into `docs/REVIEW-LOG.md`
  before the commit. Six rules at the top of that file are the ones we kept re-learning.
- Conventional commits (`feat:`, `fix:`, `docs:`), one label per commit.
- Never commit seeds, `.env`, `.sessions/`, `.outbox/`. All gitignored.
- CLAUDE.md is the design; §15 is authoritative where it conflicts with earlier sections.
