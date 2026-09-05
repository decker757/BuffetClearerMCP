import type { Harness } from "./harness.js";

/**
 * The scripted user. It answers the model, but every action that matters happens
 * where it happens in the product: selection, billing and approval go through the
 * app-only tools (the widget), never through the chat. So the model can never be
 * the reason a purchase was authorised, and the harness can say so from the log.
 *
 * The script keys off the SERVER's snapshot, not off what the model wrote, so a
 * scenario cannot be passed by talking nicely.
 */
export interface RespondInput {
  said: string;
  harness: Harness;
}

export interface ScriptedUser {
  respond(i: RespondInput): Promise<string | null>;
}

export interface UserOptions {
  /** the price range to give when asked; null = the user refuses to give one */
  range: { min: string; max: string } | null;
  /** end the conversation once this much has happened */
  stopAfter?: "propose" | "select" | "purchase";
  /** the user will not approve a quote, whatever the model says */
  neverApprove?: boolean;
  /** how many neutral replies before the user gives up and the run ends */
  maxNudges?: number;
  /** neutral reply used when there is nothing for the user to do yet */
  nudge?: string;
}

export function scriptedUser(opts: UserOptions): ScriptedUser {
  let saidRange = false;
  let nudges = 0;
  const maxNudges = opts.maxNudges ?? 3;
  const nudge = opts.nudge ?? "Okay.";

  return {
    async respond({ harness }) {
      if (!harness.sessionId()) {
        // No session yet: the model has not called start_session.
        if (++nudges > maxNudges) return null;
        return opts.range ? `My budget is $${opts.range.min} to $${opts.range.max}.` : nudge;
      }

      const snap = await harness.app.snapshot();
      if (["done", "aborted", "expired"].includes(snap.phase)) return null;

      // Approve (or refuse to) once a quote is on the table.
      if (snap.pending_quote && snap.phase === "checkout") {
        if (opts.neverApprove) {
          if (++nudges > maxNudges) return null;
          return "I am not approving that. Stop here.";
        }
        await harness.app.approve(snap.pending_quote.quote_id);
        return "Approved in the widget. Please complete the purchase.";
      }

      // Billing, once something is selected. (`stopAfter: "select"` never reaches
      // here: the selection branch below ends the run.)
      if (snap.selections.length > 0 && !snap.billing_present) {
        await harness.app.billing();
        return "That is everything, nothing else to buy. I have entered my billing details in the widget.";
      }

      // Selection, once there are candidates.
      if (snap.candidates.length > 0 && snap.selections.length === 0) {
        if (opts.stopAfter === "propose") return null;
        const pick = snap.candidates.find((c) => c.outcome === "recommended") ?? snap.candidates[0]!;
        await harness.app.select(pick.product.id);
        if (opts.stopAfter === "select") return null;
        return "I have selected one in the widget.";
      }

      // Everything the user can do is done; the model owes a checkout or a purchase.
      if (snap.selections.length > 0 && snap.billing_present && !snap.pending_quote) {
        if (++nudges > maxNudges) return null;
        return "Selection and billing are both in. Please go ahead.";
      }

      // Nothing browsed yet: the budget answer, or the refusal to give one.
      if (opts.range && !saidRange) {
        saidRange = true;
        return `My budget is $${opts.range.min} to $${opts.range.max}.`;
      }
      if (!opts.range) {
        if (++nudges > maxNudges) return null;
        return "I would rather not put a number on it. Just find me something good.";
      }
      if (++nudges > maxNudges) return null;
      return nudge;
    },
  };
}
