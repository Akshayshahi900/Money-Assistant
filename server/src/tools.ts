/**
 * Tools = the only code that produces user-visible numbers. Each returns { text, ui } where
 * text is a TEMPLATE filled from query results (the LLM never writes amounts).
 * Writes (budgets) only happen in confirmPending(), which is called by the action handler, never by the LLM.
 */
import type { DatabaseSync } from "node:sqlite";
import { Period, PeriodKey, resolvePeriod } from "./dates";
import {
  spendByCategory,
  transactionsFor,
  monthlyAverage,
  monthlySpendSeries,
  spendSummary as querySpendSummary,
  round2,
} from "./queries";
import { inr } from "./format";
import type { UiSpec } from "./ui/spec";

import { Ctx, ToolResult, notice } from "./common";
import { createPending } from "./pending";
import type { SpendScope } from './spend-query';
export type { Ctx, ToolResult };
export { notice };

export function categories(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT category FROM spend_events WHERE category <> 'Uncategorised' ORDER BY category`,
      )
      .all() as unknown as { category: string }[]
  ).map((r) => r.category);
}

// ---------- scenario 1: breakdown + drill-down ----------
export function showSpendingBreakdown(ctx: Ctx, period: PeriodKey): ToolResult {
  const p = resolvePeriod(period, ctx.today);
  return spendSummary(ctx, { status: 'ready', period: p, filters: {}, queryLabel: `All spending · ${p.label}`, dataFrom: p.from, dataTo: p.to });
}

export function spendSummary(ctx: Ctx, scope: SpendScope): ToolResult {
  if (scope.status === 'needs_period') return notice(`What period should I use for ${scope.queryLabel.replace(/ · period needed$/, '')}? Try this week, last month, a named month, or the last 7 days.`);
  if (scope.status === 'merchant_missing') return notice(`I can't find “${scope.merchant}” as a merchant in your transaction data.`);
  const p = scope.period;
  const base = { type: 'spending_breakdown' as const, period: p, queryLabel: scope.queryLabel, dataRange: { from: scope.dataFrom, to: scope.dataTo }, filters: scope.filters };
  if (scope.status === 'out_of_range') {
    return {
      text: `I only have spend data from ${scope.dataFrom} to ${scope.dataTo}; ${scope.queryLabel} is outside that range.`,
      ui: { ...base, status: 'out_of_range', total: null, categories: [] },
    };
  }
  const b = querySpendSummary(ctx.db, p, scope.filters);
  const empty = b.categories.length === 0 || b.total <= 0;
  const summary = empty
    ? `No ${scope.filters.merchant ? `${scope.filters.merchant} ` : ''}spend found in ${p.label}.${scope.status === 'partial' ? ` Available records are from ${scope.dataFrom} to ${scope.dataTo}.` : ''}`
    : `You spent ${inr(b.total)} for ${scope.queryLabel}.${scope.status === 'partial' ? ` Available records are from ${scope.dataFrom} to ${scope.dataTo}; this requested period is partial.` : ' Tap a category to see its transactions.'}`;
  return {
    text: summary,
    ui: { ...base, status: scope.status === 'partial' ? 'partial' : empty ? 'empty' : 'ready', total: b.total, categories: b.categories },
  };
}

export function drillDown(ctx: Ctx, category: string, p: Period, filters: { merchant?: string; paymentMode?: string; accountId?: string } = {}): ToolResult {
  const rows = transactionsFor(ctx.db, p, { category, ...filters, exactMerchant: true });
  const total = round2(rows.reduce((s, r) => s + r.net_amount, 0));
  return {
    text: `${category} in ${p.label}: ${rows.length} transaction${rows.length === 1 ? "" : "s"} totalling ${inr(total)}.`,
    ui: {
      type: "transaction_list",
      title: `${category} · ${p.label}`,
      total,
      rows: rows.map((r) => ({
        id: r.id,
        date: r.timestamp.slice(0, 10),
        merchant: r.merchant ?? "Unknown merchant",
        description: r.raw_description,
        amount: r.net_amount,
      })),
    },
  };
}

// ---------- scenario 2: budget suggestion (adjustable) ----------
const CUT = 0.85; // suggest a 15% reduction from the 3-month average, rounded to ₹100
const roundTo = (n: number, step: number) => Math.round(n / step) * step;

export function budgetPlan(
  ctx: Ctx,
  category: string,
  requestedLimit?: number,
): ToolResult & {
  plan?: {
    category: string;
    limit: number;
    average: number;
    savingsPerMonth: number;
  };
} {
  const p = resolvePeriod("last_3_months", ctx.today);
  if (!categories(ctx.db).includes(category))
    return notice(`I don't have spending history for "${category}".`, "error");
  const avg = monthlyAverage(ctx.db, category, p).average;
  if (avg <= 0)
    return notice(
      `You haven't spent anything on ${category} recently, so there's nothing to cut.`,
    );
  const step = 100,
    max = Math.ceil((avg * 1.25) / step) * step;
  const suggested = Math.max(0, roundTo(avg * CUT, step));
  const limit = Math.min(max, Math.max(0, requestedLimit ?? suggested)); // server clamps: client input is never trusted
  const savingsPerMonth = round2(avg - limit);
  const history = monthlySpendSeries(ctx.db, p, category);
  const text =
    requestedLimit === undefined
      ? `Over ${p.label} you averaged ${inr(avg)} a month on ${category}. A limit of ${inr(suggested)} would save you ${inr(round2(avg - suggested))} a month. Adjust it below, then confirm.`
      : `With a ${inr(limit)} monthly limit on ${category}, you'd ${savingsPerMonth >= 0 ? `save ${inr(savingsPerMonth)}` : `spend ${inr(-savingsPerMonth)} more`} a month versus your ${inr(avg)} average.`;
  return {
    text,
    ui: {
      type: "budget_editor",
      category,
      basis: p.label,
      history,
      average: avg,
      suggested,
      limit,
      min: 0,
      max,
      step,
      savingsPerMonth,
      savingsPerYear: round2(savingsPerMonth * 12),
    },
    plan: { category, limit, average: avg, savingsPerMonth },
  };
}

// ---------- human-in-the-loop: propose (writes nothing) ----------
export function proposeBudget(ctx: Ctx, sid: string, category: string, limit: number): ToolResult {
  const r = budgetPlan(ctx, category, limit);
  if (!r.plan) return r;
  return createPending(ctx, sid, "create_budget", r.plan, {
    title: "Set monthly budget", confirmLabel: "Save budget",
    lines: [
      { label: "Category", value: category },
      { label: "Monthly limit", value: inr(r.plan.limit) },
      { label: "3-month average", value: inr(r.plan.average) },
      { label: "Saves per month", value: inr(r.plan.savingsPerMonth) },
    ],
  });
}
export { confirmCardFor, resolvePending } from "./pending";
