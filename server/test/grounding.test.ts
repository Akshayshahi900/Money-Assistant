import { describe, it, expect, beforeEach } from "vitest";
import { handleChat, handleAction } from "../src/assistant";
import { ungrounded, numbersIn, guardText, SAFE_TEXT } from "../src/grounding";
import { spendByCategory } from "../src/queries";
import { resolvePeriod } from "../src/dates";
import { freshCtx, count } from "./helpers";

let ctx = freshCtx();
beforeEach(() => {
  ctx = freshCtx();
});

const SCRIPT = [
  "Where did my money go last month?",
  "where did my money go in the last 3 months",
  "how much did i spend this month",
  "I want to spend less on food.",
  "help me cut down on groceries",
  "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab.",
  "Can I afford an ₹80k phone by March?",
  "Can I afford a 1.5 lakh laptop in 6 months",
  "Can I afford an ₹80k phone",
  "Which stock should I buy?",
  "tell me a joke",
];

describe("number provenance: every number in every sentence exists in the data-built UI payload", () => {
  it("holds for all scenario outputs (first turn)", async () => {
    for (const q of SCRIPT) {
      const o = await handleChat(ctx, "s1", q);
      expect(ungrounded(o.text, o.ui), `${q} -> ${o.text}`).toEqual([]);
      expect(o.text).not.toBe(SAFE_TEXT); // the runtime guard never had to step in
    }
  });
  it("clarification and fallback notices do not inject canned amounts, dates, or counts", async () => {
    for (const q of [
      "Can I afford a phone by March?",
      "Can I afford an ₹80k phone?",
      "Can I afford an ₹80k phone in 50 months?",
      "tell me a joke",
    ]) {
      const o = await handleChat(ctx, "s1", q);
      expect(o.ui.type).toBe("notice");
      expect(numbersIn(o.text), q).toEqual([]);
    }
  });
  it("holds for follow-up turns: drill-downs, adjustments, proposals, confirmations, the picker", async () => {
    const outs: { text: string; ui: any }[] = [];
    const take = (r: any) => {
      for (const m of [r.replace, r.append, ...(r.also ?? [])])
        if (m) outs.push(m);
    };
    const b = await handleChat(ctx, "s1", "Where did my money go last month?");
    outs.push(b);
    if (b.ui.type === "spending_breakdown")
      for (const c of b.ui.categories)
        take(
          handleAction(
            ctx,
            "s1",
            {
              action: "drill_down",
              category: c.category,
              from: b.ui.period.from,
              to: b.ui.period.to,
              label: b.ui.period.label,
            },
            b.messageId,
          ),
        );
    const f = await handleChat(ctx, "s1", "I want to spend less on food");
    outs.push(f);
    for (const limit of [0, 4000, 9000, 12345, 1e9])
      take(
        handleAction(
          ctx,
          "s1",
          { action: "adjust_budget", category: "Food & Dining", limit },
          f.messageId,
        ),
      );
    const g = await handleChat(
      ctx,
      "s1",
      "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab.",
    );
    outs.push(g);
    if (g.ui.type !== "group_builder") throw 0;
    const ids = g.ui.transactions.map((t) => t.id);
    for (let n = 0; n <= ids.length; n++)
      take(
        handleAction(
          ctx,
          "s1",
          {
            action: "update_group",
            name: "Goa trip",
            memberIds: ["c_rahul", "c_priya"],
            txnIds: ids.slice(0, n),
          },
          g.messageId,
        ),
      );
    const p = handleAction(
      ctx,
      "s1",
      {
        action: "propose_group",
        name: "Goa trip",
        memberIds: ["c_rahul", "c_priya"],
        txnIds: ids.slice(0, 2),
      },
      g.messageId,
    );
    take(p);
    if (p.append?.ui.type === "confirm_card")
      take(
        handleAction(
          ctx,
          "s1",
          { action: "confirm", pendingId: p.append.ui.pendingId },
          p.append.messageId,
        ),
      );
    const pk = await handleChat(ctx, "s1", "Add the Swiggy ones to the group.");
    outs.push(pk);
    if (pk.ui.type === "choice_picker") {
      take(
        handleAction(
          ctx,
          "s1",
          {
            action: "update_choice",
            ids: pk.ui.options.slice(0, 3).map((o) => o.id),
          },
          pk.messageId,
        ),
      );
      take(
        handleAction(
          ctx,
          "s1",
          {
            action: "submit_choice",
            ids: pk.ui.options.slice(0, 3).map((o) => o.id),
          },
          pk.messageId,
        ),
      );
    }
    const pl = await handleChat(
      ctx,
      "s1",
      "Can I afford an ₹80k phone by March?",
    );
    outs.push(pl);
    for (const [m, v] of [
      ["2027-03", 20000],
      ["2027-06", 13000],
      ["2027-01", 0],
      ["2028-10", 43000],
      ["2027-02", 7500],
    ] as const)
      take(
        handleAction(
          ctx,
          "s1",
          { action: "adjust_plan", targetMonth: m, monthly: v },
          pl.messageId,
        ),
      );
    take(
      handleAction(
        ctx,
        "s1",
        { action: "propose_goal", targetMonth: "2027-06", monthly: 13000 },
        pl.messageId,
      ),
    );
    expect(outs.length).toBeGreaterThan(30);
    for (const o of outs) {
      expect(ungrounded(o.text, o.ui), o.text).toEqual([]);
      expect(o.text).not.toBe(SAFE_TEXT);
    } // guard must not have rescued anything
  });
  it("the checker itself catches an invented number (negative control)", () => {
    const ui = {
      type: "notice",
      tone: "info",
      text: "You spent ₹1,000",
    } as const;
    expect(ungrounded("You spent ₹1,000 and saved ₹9,999", ui)).toEqual([
      "9999",
    ]);
    expect(guardText("You spent ₹1,000 and saved ₹9,999", ui)).toBe(SAFE_TEXT);
    expect(guardText("You spent ₹1,000", ui)).toBe("You spent ₹1,000");
    expect(numbersIn("₹4,31,749.74 and 6 months")).toEqual(["431749.74", "6"]);
  });
});

describe("adversarial LLM: whatever the model says, user-visible numbers still come from the data", () => {
  const realFetch = globalThis.fetch;
  const stub = (toolCall: { name: string; args: any }) => {
    process.env.GROQ_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "You spent ₹1,23,456 last month, definitely!",
                tool_calls: [
                  {
                    function: {
                      name: toolCall.name,
                      arguments: JSON.stringify(toolCall.args),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      )) as any;
  };
  const restore = () => {
    globalThis.fetch = realFetch;
    delete process.env.GROQ_API_KEY;
  };

  it("model prose and injected numeric args never reach the user; amounts are recomputed", async () => {
    stub({
      name: "show_spending_breakdown",
      args: { period: "last_month", total: 123456, amount: 999999 },
    });
    try {
      const o = await handleChat(
        ctx,
        "s1",
        "I keep wondering how my cash flow looked last month",
      );
      const truth = spendByCategory(
        ctx.db,
        resolvePeriod("last_month", ctx.today),
      );
      expect(o.via).toBe("llm");
      if (o.ui.type !== "spending_breakdown") throw 0;
      expect(o.ui.total).toBe(truth.total);
      expect(JSON.stringify(o)).not.toContain("123456");
      expect(JSON.stringify(o)).not.toContain("1,23,456");
      expect(JSON.stringify(o)).not.toContain("999999");
    } finally {
      restore();
    }
  });
  it("a price returned by the model is ignored: the price is parsed from the user's own words", async () => {
    stub({
      name: "plan_purchase",
      args: { item: "tablet", inMonths: 6, price: 1 },
    });
    try {
      const o = await handleChat(
        ctx,
        "s1",
        "thinking of a ₹50k tablet in six months",
      );
      expect(o.via).toBe("llm");
      if (o.ui.type !== "savings_plan") throw new Error(o.ui.type);
      expect(o.ui.price).toBe(50000);
      expect(o.ui.monthsLeft).toBe(6);
    } finally {
      restore();
    }
  });
  it("a target date returned by the model is ignored when the user did not provide one", async () => {
    stub({ name: "plan_purchase", args: { item: "tablet", inMonths: 6 } });
    try {
      const o = await handleChat(
        ctx,
        "s1",
        "I am thinking about a ₹50k tablet",
      );
      expect(o.via).toBe("llm");
      expect(o.ui.type).toBe("notice");
      expect(o.text).toBe(
        "What month are you aiming for? You can give a calendar month or a relative date.",
      );
      expect(numbersIn(o.text)).toEqual([]);
    } finally {
      restore();
    }
  });
  it("a model that invents a category, a bogus tool, or malformed args falls back safely", async () => {
    for (const call of [
      { name: "suggest_budget", args: { category: "Yachts" } },
      { name: "transfer_money", args: { amount: 5000 } },
      { name: "create_group", args: { groupName: 7, memberNames: "x" } },
    ]) {
      stub(call);
      try {
        const o = await handleChat(
          ctx,
          "s1",
          "something vague about my finances",
        );
        expect(o.ui.type).toBe("notice");
        expect(o.via).toBe("fallback");
      } finally {
        restore();
      }
    }
    expect(
      count(ctx.db, "groups") +
        count(ctx.db, "budgets") +
        count(ctx.db, "goals"),
    ).toBe(0);
  });
  it("an LLM outage or timeout degrades to the fixed reply, not an error", async () => {
    process.env.GROQ_API_KEY = "test-key";
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as any;
    try {
      const o = await handleChat(ctx, "s1", "something vague");
      expect(o.via).toBe("fallback");
      expect(o.ui.type).toBe("notice");
    } finally {
      restore();
    }
  });
});

describe("hostile structured input never writes and never crashes", () => {
  it("rejects malformed payloads and writes nothing", async () => {
    const g = await handleChat(
      ctx,
      "s1",
      "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab.",
    );
    const junk: unknown[] = [
      null,
      "x",
      {},
      { action: "confirm" },
      { action: "confirm", pendingId: "nope" },
      {
        action: "update_group",
        name: "x".repeat(500),
        memberIds: [],
        txnIds: [],
      },
      { action: "update_group", name: "x", memberIds: [1], txnIds: [] },
      { action: "adjust_plan", targetMonth: "March", monthly: 1 },
      { action: "adjust_plan", targetMonth: "2027-03", monthly: NaN },
      { action: "submit_choice", ids: ["a"] },
      { action: "propose_goal", targetMonth: "2027-03", monthly: 1 },
      { action: "quick_ask", ask: "drop table" },
      { action: "DROP", sql: "'; DELETE FROM transactions; --" },
    ];
    for (const j of junk)
      expect(() => handleAction(ctx, "s1", j, g.messageId)).not.toThrow();
    expect(
      count(ctx.db, "groups") +
        count(ctx.db, "goals") +
        count(ctx.db, "budgets"),
    ).toBe(0);
    expect(count(ctx.db, "transactions")).toBeGreaterThan(300);
  });
  it("SQL-ish text in the group name or search term is inert", async () => {
    const o = await handleChat(
      ctx,
      "s1",
      "Make a Robert'); DROP TABLE transactions;-- group with Rahul",
    );
    expect(o.ui.type).toBe("group_builder");
    await handleChat(ctx, "s1", "add the %' OR 1=1 -- ones to the group");
    expect(count(ctx.db, "transactions")).toBeGreaterThan(300);
  });
});
