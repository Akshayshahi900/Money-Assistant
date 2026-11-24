/** Scenario 6: a polite, useful decline of personalised investment advice. Facts come from the query layer. */
import { Ctx, ToolResult } from "./common";
import { resolvePeriod } from "./dates";
import { monthlySurplus, round2 } from "./queries";
import { inr } from "./format";

export function investmentNote(ctx: Ctx): ToolResult {
  const p = resolvePeriod("last_3_months", ctx.today), s = monthlySurplus(ctx.db, p);
  return {
    text: "I can't tell you which stock to buy. That's personalised investment advice, which I'm not able to give. Here's what I can do instead.",
    ui: {
      type: "info_card",
      title: "I can't recommend investments, but I can help you get ready",
      body: "Choosing what to buy or sell depends on your goals, time horizon and risk appetite, and it should come from a SEBI-registered investment adviser. What I can do is show how much room you have, based on your real numbers.",
      facts: [
        { label: `Average monthly surplus (${p.label})`, value: inr(s.avgSurplus) },
        { label: "Emergency fund target (6 months of spending)", value: inr(round2(s.avgSpend * 6)) },
      ],
      points: [
        "What is the money for, and when will you need it?",
        "How big a fall could you sit through without selling?",
        "Is your emergency fund in place before you invest?",
        "Check fees and taxes, and verify any adviser on SEBI's registered-advisers list.",
      ],
      actions: [{ label: "See where my money went", ask: "spending_last_month" }, { label: "Last 3 months", ask: "spending_last_3_months" }],
    },
  };
}
