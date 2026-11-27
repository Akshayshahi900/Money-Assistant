/**
 * Scenario 4: "Can I afford an ₹80k phone by March?" A savings projection the user can adjust (monthly amount, target month).
 * Assumptions (stated in the UI): nothing saved for it yet; money is set aside once a month starting next month;
 * "by March" means by the March salary cycle. Income/spend come from the last 3 full months of real data.
 * Every number is computed here; the client only sends a month and an amount, both clamped and validated.
 */
import { Ctx, ToolResult, notice } from "./common";
import { createPending } from "./pending";
import {
  resolvePeriod,
  ymOf,
  addMonthsYM,
  monthsBetweenYM,
  labelYM,
  shortLabelYM,
} from "./dates";
import { monthlySurplus, monthlyAverage, round2 } from "./queries";
import { inr } from "./format";
import type { UiSpec } from "./ui/spec";

type Plan = Extract<UiSpec, { type: "savings_plan" }>;
const MAX_MONTHS = 24,
  STEP = 500,
  LEVER_CUT = 0.15;
const FLEX = ["Food & Dining", "Shopping", "Entertainment", "Groceries"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthsToReach = (price: number, perMonth: number) =>
  perMonth > 0 ? Math.ceil(price / perMonth) : Infinity;

export function computePlan(
  ctx: Ctx,
  item: string,
  price: number,
  targetMonth: string,
  monthlyIn?: number,
  status: "editing" | "done" = "editing",
): Plan | ToolResult {
  const cur = ymOf(ctx.today),
    monthsLeft = monthsBetweenYM(cur, targetMonth);
  if (!(price >= 1000 && price <= 100_000_000))
    return notice(
      "That price can't be planned yet. Check the amount and try again.",
    );
  if (monthsLeft < 1)
    return notice(
      "That month has already started or passed. Pick a month after this one.",
      "error",
    );
  if (monthsLeft > MAX_MONTHS)
    return notice(
      "That date is outside the planning window. Choose an earlier month.",
      "error",
    );

  const p = resolvePeriod("last_3_months", ctx.today),
    s = monthlySurplus(ctx.db, p);
  const max = Math.ceil((s.avgIncome * 0.5) / 1000) * 1000;
  const snap = (n: number) =>
    Math.min(max, Math.max(0, Math.round(n / STEP) * STEP)); // server clamps: client input is never trusted
  const monthly = snap(
    monthlyIn ?? Math.floor(Math.max(0, s.avgSurplus) / STEP) * STEP,
  );
  const savedAlready = 0; // no goal-specific balance is present in this prototype; account cash is not assumed saved for this purchase
  const requiredMonthly = Math.ceil(
    Math.max(0, price - savedAlready) / monthsLeft,
  );
  const projected = round2(savedAlready + monthly * monthsLeft);
  const shortfall = Math.max(0, round2(price - projected));
  const verdict: Plan["verdict"] =
    projected >= price
      ? monthly <= s.avgSurplus
        ? "on_track"
        : "stretch"
      : "short";
  const label = (n: number) =>
    Number.isFinite(n) && n <= 60 ? shortLabelYM(addMonthsYM(cur, n)) : null;

  const levers = FLEX.map((category) => ({
    category,
    savePerMonth:
      Math.floor(
        (monthlyAverage(ctx.db, category, p).average * LEVER_CUT) / 100,
      ) * 100,
  }))
    .filter((l) => l.savePerMonth > 0)
    .sort((a, b) => b.savePerMonth - a.savePerMonth)
    .slice(0, 2);

  const ui: Plan = {
    type: "savings_plan",
    status,
    item: cap(item),
    price,
    targetMonth,
    targetLabel: labelYM(targetMonth),
    targetOptions: Array.from({ length: MAX_MONTHS }, (_, i) => {
      const v = addMonthsYM(cur, i + 1);
      return { value: v, label: shortLabelYM(v) };
    }),
    monthsLeft,
    monthly,
    min: 0,
    max,
    step: STEP,
    requiredMonthly,
    savedAlready,
    gapMonthly: Math.max(0, requiredMonthly - monthly),
    avgIncome: s.avgIncome,
    avgSpend: s.avgSpend,
    avgSurplus: s.avgSurplus,
    basis: p.label,
    projected,
    shortfall,
    verdict,
    reachedLabel: label(monthsToReach(price, monthly)),
    earliestLabel: label(monthsToReach(price, s.avgSurplus)),
    series: Array.from({ length: monthsLeft }, (_, i) => ({
      label: shortLabelYM(addMonthsYM(cur, i + 1)),
      saved: round2(monthly * (i + 1)),
    })),
    levers: shortfall > 0 ? levers : [],
  };
  return ui;
}

const isPlan = (x: Plan | ToolResult): x is Plan =>
  (x as Plan).type === "savings_plan";

export function planText(u: Plan): string {
  const it = u.item.toLowerCase();
  if (u.verdict === "on_track")
    return `Yes. Setting aside ${inr(u.monthly)} a month for ${u.monthsLeft} months gets you ${inr(u.projected)} by ${u.targetLabel}, enough for the ${inr(u.price)} ${it}, and it's within your usual surplus of ${inr(u.avgSurplus)} a month.`;
  if (u.verdict === "stretch")
    return `It's reachable, but it's a stretch. ${inr(u.monthly)} a month gives you ${inr(u.projected)} by ${u.targetLabel}, enough for the ${inr(u.price)} ${it}, but that's more than the ${inr(u.avgSurplus)} a month you usually have left over.`;
  return `Not quite on your current numbers. The ${inr(u.price)} ${it} by ${u.targetLabel} needs ${inr(u.requiredMonthly)} a month for ${u.monthsLeft} months, and your recent surplus is ${inr(u.avgSurplus)} a month. At ${inr(u.monthly)} a month you'd have ${inr(u.projected)}, which is ${inr(u.shortfall)} short${u.reachedLabel ? ` (you'd get there by ${u.reachedLabel})` : ""}. Adjust the amount or the date below.`;
}

export function planPurchase(
  ctx: Ctx,
  a: { item: string | null; price: number | null; target: string | null },
): ToolResult {
  if (a.price === null)
    return notice("What price should I use? Tell me the amount in rupees.");
  if (a.target === null)
    return notice(
      "What month are you aiming for? You can give a calendar month or a relative date.",
    );
  const r = computePlan(ctx, a.item || "purchase", a.price, a.target);
  return isPlan(r) ? { text: planText(r), ui: r } : r;
}

export function rebuildPlan(
  ctx: Ctx,
  prev: Plan,
  input: { targetMonth: string; monthly: number },
  status: "editing" | "done" = "editing",
): ToolResult {
  const r = computePlan(
    ctx,
    prev.item,
    prev.price,
    input.targetMonth,
    input.monthly,
    status,
  ); // price/item come from the stored spec, not the client
  return isPlan(r) ? { text: planText(r), ui: r } : r;
}

export function proposeGoal(
  ctx: Ctx,
  sid: string,
  prev: Plan,
  input: { targetMonth: string; monthly: number },
  sourceMessageId: number,
): ToolResult {
  const r = computePlan(
    ctx,
    prev.item,
    prev.price,
    input.targetMonth,
    input.monthly,
  );
  if (!isPlan(r)) return r;
  return createPending(
    ctx,
    sid,
    "create_goal",
    {
      item: r.item,
      price: r.price,
      targetMonth: r.targetMonth,
      targetLabel: r.targetLabel,
      monthly: r.monthly,
    },
    {
      title: "Save savings goal",
      confirmLabel: "Save goal",
      lines: [
        { label: "Goal", value: r.item },
        { label: "Price", value: inr(r.price) },
        { label: "Target", value: r.targetLabel },
        { label: "Already saved for this goal", value: inr(r.savedAlready) },
        {
          label: "Required monthly formula",
          value: `(${inr(r.price)} − ${inr(r.savedAlready)} saved) ÷ ${r.monthsLeft} = ${inr(r.requiredMonthly)}/month`,
        },
        { label: "Set aside each month", value: inr(r.monthly) },
        { label: `Saved by ${r.targetLabel}`, value: inr(r.projected) },
        ...(r.shortfall > 0
          ? [{ label: "Still short by", value: inr(r.shortfall) }]
          : []),
      ],
    },
    sourceMessageId,
  );
}
