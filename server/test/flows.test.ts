import { describe, it, expect, beforeEach } from "vitest";
import { handleChat, handleAction, loadState } from "../src/assistant";
import { ruleRoute } from "../src/router";
import { spendByCategory } from "../src/queries";
import { resolvePeriod } from "../src/dates";

import { freshCtx } from "./helpers";
let ctx = freshCtx();
beforeEach(() => {
  ctx = freshCtx();
});
const budgets = () =>
  (
    ctx.db.prepare("SELECT COUNT(*) AS n FROM budgets").get() as unknown as {
      n: number;
    }
  ).n;

describe("routing (rules)", () => {
  it.each([
    ["Where did my money go last month?", "show_spending_breakdown"],
    ["how much did i spend this month", "show_spending_breakdown"],
    ["I want to spend less on food.", "suggest_budget"],
    ["help me cut down on groceries", "suggest_budget"],
    ["I keep overspending on eating out lately", null], // no rule hit -> goes to the LLM tier
  ])("%s", (msg, tool) => expect(ruleRoute(msg)?.tool ?? null).toBe(tool));
});

describe("scenario 1: breakdown", () => {
  it("every number in the UI and text comes from the query layer", async () => {
    const o = await handleChat(ctx, "s1", "Where did my money go last month?");
    const truth = spendByCategory(
      ctx.db,
      resolvePeriod("last_month", ctx.today),
    );
    expect(o.ui.type).toBe("spending_breakdown");
    if (o.ui.type !== "spending_breakdown") return;
    expect(o.ui.total).toBe(truth.total);
    expect(o.ui.categories).toEqual(truth.categories);
    expect(o.text).toContain(truth.total.toLocaleString("en-IN"));
    expect(o.via).toBe("rules");
  });
  it("drill-down total equals the category amount in the breakdown", async () => {
    const o = await handleChat(ctx, "s1", "where did my money go last month");
    if (o.ui.type !== "spending_breakdown") throw 0;
    const top = o.ui.categories[0];
    const r = handleAction(
      ctx,
      "s1",
      {
        action: "drill_down",
        category: top.category,
        from: o.ui.period.from,
        to: o.ui.period.to,
        label: o.ui.period.label,
      },
      o.messageId,
    );
    if (r.append?.ui.type !== "transaction_list") throw 0;
    expect(r.append.ui.total).toBe(top.amount);
    expect(r.append.ui.rows).toHaveLength(top.count);
  });
});

describe("scenario 2: budget + human in the loop", () => {
  it("suggests from actual history and nothing is written until confirmed", async () => {
    const o = await handleChat(ctx, "s1", "I want to spend less on food");
    if (o.ui.type !== "budget_editor") throw 0;
    expect(o.ui.category).toBe("Food & Dining");
    expect(o.ui.history).toHaveLength(3);
    expect(o.ui.suggested).toBeLessThan(o.ui.average);
    const prop = handleAction(
      ctx,
      "s1",
      {
        action: "propose_budget",
        category: "Food & Dining",
        limit: o.ui.limit,
      },
      o.messageId,
    );
    expect(prop.append?.ui.type).toBe("confirm_card");
    expect(budgets()).toBe(0); // proposing writes nothing
  });
  it("adjusting recomputes savings server-side and clamps hostile input", async () => {
    const o = await handleChat(ctx, "s1", "I want to spend less on food");
    if (o.ui.type !== "budget_editor") throw 0;
    const a = handleAction(
      ctx,
      "s1",
      { action: "adjust_budget", category: "Food & Dining", limit: 5000 },
      o.messageId,
    );
    if (a.replace?.ui.type !== "budget_editor") throw 0;
    expect(a.replace.ui.limit).toBe(5000);
    expect(a.replace.ui.savingsPerMonth).toBeCloseTo(o.ui.average - 5000, 2);
    const bad = handleAction(
      ctx,
      "s1",
      { action: "adjust_budget", category: "Food & Dining", limit: 9e9 },
      o.messageId,
    );
    if (bad.replace?.ui.type !== "budget_editor") throw 0;
    expect(bad.replace.ui.limit).toBe(bad.replace.ui.max);
  });
  it("confirm commits once, is idempotent, and refresh shows the confirmed status", async () => {
    const o = await handleChat(ctx, "s1", "I want to spend less on food");
    if (o.ui.type !== "budget_editor") throw 0;
    const p = handleAction(
      ctx,
      "s1",
      { action: "propose_budget", category: "Food & Dining", limit: 9000 },
      o.messageId,
    );
    if (p.append?.ui.type !== "confirm_card") throw 0;
    const pid = p.append.ui.pendingId;
    handleAction(
      ctx,
      "s1",
      { action: "confirm", pendingId: pid },
      p.append.messageId,
    );
    handleAction(
      ctx,
      "s1",
      { action: "confirm", pendingId: pid },
      p.append.messageId,
    ); // double click
    expect(budgets()).toBe(1);
    expect(
      (
        ctx.db
          .prepare("SELECT monthly_limit AS l FROM budgets")
          .get() as unknown as { l: number }
      ).l,
    ).toBe(9000);
    const card = loadState(ctx, "s1").find(
      (m) => m.ui?.type === "confirm_card",
    )!.ui!;
    expect(card.type === "confirm_card" && card.status).toBe("confirmed");
  });
  it("cancel writes nothing; another session cannot confirm my pending action", async () => {
    const o = await handleChat(ctx, "s1", "I want to spend less on food");
    if (o.ui.type !== "budget_editor") throw 0;
    const p = handleAction(
      ctx,
      "s1",
      { action: "propose_budget", category: "Food & Dining", limit: 9000 },
      o.messageId,
    );
    if (p.append?.ui.type !== "confirm_card") throw 0;
    handleAction(
      ctx,
      "s2",
      { action: "confirm", pendingId: p.append.ui.pendingId },
      1,
    );
    expect(budgets()).toBe(0);
    handleAction(
      ctx,
      "s1",
      { action: "cancel", pendingId: p.append.ui.pendingId },
      p.append.messageId,
    );
    expect(budgets()).toBe(0);
  });
  it("malformed UI actions are rejected, not executed", () => {
    const r = handleAction(ctx, "s1", { action: "drop_tables" }, 1);
    expect(r.append?.ui).toMatchObject({ type: "notice", tone: "error" });
  });
});

describe("fallback", () => {
  it("unsupported intent gets a fixed, number-free reply (no LLM key in tests)", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const o = await handleChat(ctx, "s1", "tell me a joke");
    expect(o.via).toBe("fallback");
    expect(o.ui.type).toBe("notice");
  });
});
