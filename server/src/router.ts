/**
 * Intent routing. Two tiers for latency:
 *  1) rule-based fast path (0 ms, 0 cost) for the common phrasings,
 *  2) LLM tool-calling for everything else (only if an API key is configured).
 * Output is always a validated {tool,args}; the router never produces user-visible numbers.
 */
import { z } from 'zod';
import { PeriodKey, parseTargetMonth, DEFAULT_TODAY } from './dates';
import type { ItemKey } from './queries';
import { llmRoute } from './llm';
import type { DatabaseSync } from 'node:sqlite';
import { parseSpendScope, type SpendScope } from './spend-query';

export type Route =
  | { tool: 'show_spending_breakdown'; args: { period: PeriodKey } }
  | { tool: 'spend_summary'; args: { scope: SpendScope } }
  | { tool: 'suggest_budget'; args: { category: string } }
  | { tool: 'create_group'; args: { groupName: string; memberNames: string[]; items: ItemKey[]; period: PeriodKey } }
  | { tool: 'add_to_group'; args: { query: string; period: PeriodKey } }
  | { tool: 'plan_purchase'; args: { item: string | null; price: number | null; target: string | null } }
  | { tool: 'investment_question'; args: {} }
  | { tool: 'unsupported'; args: {} };

const CATEGORY_WORDS: [RegExp, string][] = [
  [/\b(food|dining|eating out|restaurants?|swiggy|zomato)\b/i, 'Food & Dining'],
  [/\bgrocer(y|ies)\b/i, 'Groceries'],
  [/\b(transport|travel(l)?ing around|cabs?|uber|ola|fuel|petrol)\b/i, 'Transport'],
  [/\bshopping\b/i, 'Shopping'],
  [/\b(entertainment|movies?)\b/i, 'Entertainment'],
  [/\b(subscriptions?)\b/i, 'Subscriptions'],
  [/\b(bills?|utilities)\b/i, 'Bills & Utilities'],
];
export function detectCategory(msg: string): string | null {
  for (const [re, cat] of CATEGORY_WORDS) if (re.test(msg)) return cat;
  return null;
}
export function detectPeriod(msg: string, dflt: PeriodKey = 'last_month'): PeriodKey {
  if (/\b(this|current) week\b/i.test(msg)) return 'this_week';
  if (/\bthis month\b/i.test(msg)) return 'this_month';
  if (/\byesterday\b/i.test(msg)) return 'yesterday';
  if (/\blast (6|six) months\b/i.test(msg)) return 'last_6_months';
  if (/\blast (3|three) months\b/i.test(msg)) return 'last_3_months';
  if (/\b(last|past) (30|thirty) days\b/i.test(msg)) return 'last_30_days';
  if (/\btoday\b/i.test(msg)) return 'today';
  if (/\blast month\b/i.test(msg)) return 'last_month';
  return dflt;
}

// ---------- deterministic parsers (the only way a user-typed amount becomes a number) ----------
const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7 };
export function parseAmount(msg: string): number | null {
  const re = /(₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|crores?|cr)?\b/gi;
  for (const m of msg.matchAll(re)) {
    const n = Number(m[2].replace(/,/g, '')), mult = m[3] ? MULT[m[3].toLowerCase()] : 1, marked = !!m[1];
    const yearLike = n >= 1900 && n <= 2100 && !marked && mult === 1;
    if (marked || mult > 1 || (n >= 1000 && !yearLike)) return Math.round(n * mult * 100) / 100;
  }
  return null;
}
export function parseItem(msg: string): string | null {
  const m = /(?:₹|rs\.?|inr)?\s*[\d.,]+\s*(?:k|thousand|lakhs?|lacs?|crores?)?\s+([a-z][a-z ]{1,28}?)\s+(?:by|before|in|until|till|for)\b/i.exec(msg)
    ?? /afford\s+(?:a|an|the)\s+([a-z][a-z ]{1,28}?)\s+(?:by|before|in|for|worth)\b/i.exec(msg);
  return m ? m[1].trim().toLowerCase() : null;
}
const ITEM_WORDS: [RegExp, ItemKey][] = [
  [/\b(hotels?|resort|stay)\b/i, 'hotel'], [/\b(cabs?|taxis?|uber|ola|rapido|rides?)\b/i, 'cab'],
  [/\b(flights?|airfare)\b/i, 'flight'], [/\b(food|dinner|lunch|restaurants?)\b/i, 'food'],
];
export function parseGroup(msg: string) {
  const name = /(?:make|create|start|set up|build)\s+(?:me\s+)?(?:(?:a|an|the|new)\s+)*(.+?)\s+group\b/i.exec(msg)?.[1]?.trim() || 'New group';
  const withPart = /\bwith\s+(.+?)(?=\s+(?:and\s+)?(?:add|include|put)\b|[.!?]|$)/i.exec(msg)?.[1] ?? '';
  const memberNames = withPart.split(/\s*(?:,|&|\band\b)\s*/i).map((x) => x.trim().replace(/[.!?;:]+$/, '')).filter((x) => x.length >= 2).slice(0, 8);
  const tail = /\b(?:add|include|put)\b(.*)$/i.exec(msg)?.[1] ?? msg;
  const items = ITEM_WORDS.filter(([re]) => re.test(tail)).map(([, k]) => k);
  return { groupName: name, memberNames, items, period: detectPeriod(msg, 'last_30_days') };
}
export function parseAddQuery(msg: string): string | null {
  return /\badd\s+(?:all\s+)?(?:of\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+(?:ones?|transactions?|orders?|payments?|expenses?|txns?|spends?))?\s+(?:to|into|in)\b/i.exec(msg)?.[1]?.trim() ?? null;
}

const INVEST_WORDS = /\b(stocks?|shares?|equity|equities|mutual funds?|etfs?|crypto|bitcoin|nifty|sensex|ipos?|sips?|invest(?:ing|ment|ments)?)\b/i;
const INVEST_INTENT = /\b(which|what|best|top|good|should|recommend|suggest|tips?|pick|buy|sell|invest|where)\b/i;

export function ruleRoute(msg: string, today = DEFAULT_TODAY): Route | null {
  const m = msg.toLowerCase();
  if (INVEST_WORDS.test(msg) && INVEST_INTENT.test(msg)) return { tool: 'investment_question', args: {} };
  if (/\b(make|create|start|set up|build)\b[^.]*\bgroup\b/.test(m)) return { tool: 'create_group', args: parseGroup(msg) };
  if (/\badd\b/.test(m) && /\bgroup\b/.test(m)) { const q = parseAddQuery(msg); if (q) return { tool: 'add_to_group', args: { query: q, period: detectPeriod(msg, 'last_30_days') } }; }
  const price = parseAmount(msg), target = parseTargetMonth(msg, today);
  if (/\bafford\b/.test(m) || (price !== null && target !== null && /\b(buy|purchase|get|save for|saving for)\b/.test(m)))
    return { tool: 'plan_purchase', args: { item: parseItem(msg), price, target } };
  if (/(spend|spent|cut|reduce|lower|less).{0,25}(on|in)\b/.test(m) && /(less|reduce|cut|lower|save)/.test(m)) {
    const c = detectCategory(msg); if (c) return { tool: 'suggest_budget', args: { category: c } };
  }
  if (/\b(cap|limit|allowance)\b/.test(m)) { const c = detectCategory(msg); if (c) return { tool: 'suggest_budget', args: { category: c } }; }
  if (/\bbudget\b/.test(m)) { const c = detectCategory(msg); if (c) return { tool: 'suggest_budget', args: { category: c } }; }
  if (/(where did my money go|where.*money.*go|show (?:me )?(?:my )?spending|spending (breakdown|summary)|how much did i spend|how much have i spent|how much i spent|what (?:did|have) i spend|what is (?:the )?(?:total )?(?:money )?i spent|total (?:money )?i spent|breakdown|total money i spent|\bspend(?:ing)?\b|\bspent\b|outgoings)/.test(m))
    return { tool: 'show_spending_breakdown', args: { period: detectPeriod(msg) } };
  return null;
}

const PeriodEnum = z.enum(['yesterday', 'today', 'this_week', 'this_month', 'last_month', 'last_30_days', 'last_3_months', 'last_6_months']);
export const RouteArgs = {
  show_spending_breakdown: z.object({ period: PeriodEnum }),
  suggest_budget: z.object({ category: z.string() }),
  create_group: z.object({ groupName: z.string().min(1).max(40), memberNames: z.array(z.string().max(30)).max(8), items: z.array(z.enum(['hotel', 'cab', 'flight', 'food'])).max(4), period: PeriodEnum }),
  add_to_group: z.object({ query: z.string().min(2).max(30), period: PeriodEnum }),
  plan_purchase: z.object({ item: z.string().max(30).nullable().optional(), month: z.number().int().min(1).max(12).nullable().optional(), inMonths: z.number().int().min(1).max(24).nullable().optional() }),
};

/** Model tool arguments select an intent; user amounts and target dates are parsed from the user's words only. */
export async function route(msg: string, ctx: { today: string; categories: string[]; db: DatabaseSync }): Promise<{ route: Route; via: 'rules' | 'llm' | 'fallback'; usage?: { in: number; out: number } }> {
  const r = ruleRoute(msg, ctx.today);
  if (r?.tool === 'show_spending_breakdown') return { route: { tool: 'spend_summary', args: { scope: parseSpendScope(ctx.db, msg, ctx.today) } }, via: 'rules' };
  if (r) return { route: r, via: 'rules' };
  // Rules handle common phrasings quickly; the model routes only unmatched requests.
  const l = await llmRoute(msg, ctx).catch((err: unknown) => {
    if (!(err instanceof Error && err.name === 'AbortError'))
      console.warn('LLM routing request failed:', err instanceof Error ? err.message : 'unknown error');
    return null;
  });
  if (l) {
    if (l.tool === 'show_spending_breakdown') { const a = RouteArgs.show_spending_breakdown.safeParse(l.args); if (a.success) return { route: { tool: 'spend_summary', args: { scope: parseSpendScope(ctx.db, msg, ctx.today) } }, via: 'llm', usage: l.usage }; }
    if (l.tool === 'suggest_budget') { const a = RouteArgs.suggest_budget.safeParse(l.args); if (a.success && ctx.categories.includes(a.data.category)) return { route: { tool: l.tool, args: a.data }, via: 'llm', usage: l.usage }; }
    if (l.tool === 'create_group') { const a = RouteArgs.create_group.safeParse(l.args); if (a.success) return { route: { tool: l.tool, args: a.data }, via: 'llm', usage: l.usage }; }
    if (l.tool === 'add_to_group') { const a = RouteArgs.add_to_group.safeParse(l.args); if (a.success) return { route: { tool: l.tool, args: a.data }, via: 'llm', usage: l.usage }; }
    if (l.tool === 'investment_question') return { route: { tool: l.tool, args: {} }, via: 'llm', usage: l.usage };
    if (l.tool === 'plan_purchase') {
      const a = RouteArgs.plan_purchase.safeParse(l.args);
      if (a.success) return { route: { tool: l.tool, args: { item: a.data.item?.toLowerCase() ?? parseItem(msg), price: parseAmount(msg), target: parseTargetMonth(msg, ctx.today) } }, via: 'llm', usage: l.usage };
      console.warn('LLM plan_purchase arguments failed validation:', a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    if (!['show_spending_breakdown', 'suggest_budget', 'create_group', 'add_to_group', 'investment_question', 'plan_purchase'].includes(l.tool)) console.warn(`LLM router returned unknown tool: ${l.tool}`);
    else if (l.tool !== 'plan_purchase') console.warn(`LLM router arguments failed validation for ${l.tool}.`);
  }
  return { route: { tool: 'unsupported', args: {} }, via: 'fallback', usage: l?.usage };
}
