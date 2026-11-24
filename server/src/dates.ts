/** Date resolution against a configurable "today" (default: env CURRENT_DATE). Pure functions. */
export const DEFAULT_TODAY = process.env.CURRENT_DATE ?? '2026-11-23';

export interface Period { from: string; to: string; label: string } // [from, to) as YYYY-MM-DD

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(s + 'T00:00:00Z');
export const addDays = (s: string, n: number) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const firstOfMonth = (s: string, offset = 0) => { const d = utc(s); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1))); };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthLabel = (s: string) => `${MONTHS[utc(s).getUTCMonth()]} ${utc(s).getUTCFullYear()}`;

export type PeriodKey = 'yesterday' | 'today' | 'this_week' | 'this_month' | 'last_month' | 'last_30_days' | 'last_3_months' | 'last_6_months';

export function resolvePeriod(key: PeriodKey, today = DEFAULT_TODAY): Period {
  switch (key) {
    case 'today': return { from: today, to: addDays(today, 1), label: 'today' };
    case 'yesterday': return { from: addDays(today, -1), to: today, label: 'yesterday' };
    case 'this_week': { const d = utc(today); const mondayOffset = (d.getUTCDay() + 6) % 7; return { from: addDays(today, -mondayOffset), to: addDays(today, 1), label: 'this week so far' }; }
    case 'this_month': return { from: firstOfMonth(today), to: addDays(today, 1), label: `${monthLabel(today)} so far` };
    case 'last_month': { const f = firstOfMonth(today, -1); return { from: f, to: firstOfMonth(today), label: monthLabel(f) }; }
    case 'last_30_days': return { from: addDays(today, -30), to: addDays(today, 1), label: 'the last 30 days' };
    case 'last_3_months': return { from: firstOfMonth(today, -3), to: firstOfMonth(today), label: 'the last 3 full months' };
    case 'last_6_months': return { from: firstOfMonth(today, -6), to: firstOfMonth(today), label: 'the last 6 full months' };
  }
}

/** Resolve an explicit month like "2026-09" */
export function monthPeriod(ym: string): Period {
  const from = `${ym}-01`; return { from, to: firstOfMonth(from, 1), label: monthLabel(from) };
}

export function monthsInPeriod(p: Period): number {
  const a = utc(p.from), b = utc(p.to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

// ---------- month arithmetic for savings plans ("YYYY-MM" strings) ----------
export const ymOf = (s: string) => s.slice(0, 7);
export function addMonthsYM(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
export function monthsBetweenYM(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}
export const labelYM = (ym: string) => monthLabel(ym + '-01');                       // "March 2027"
export const shortLabelYM = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1].slice(0, 3)} ${ym.slice(0, 4)}`; // "Mar 2027"

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NUM_WORDS: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/**
 * Resolve a target month from free text against `today`. "by March" = the next March after the current month;
 * an explicit year wins; "in 6 months" / "by next month" are relative. Returns "YYYY-MM" or null. Pure.
 */
export function parseTargetMonth(msg: string, today = DEFAULT_TODAY): string | null {
  const m = msg.toLowerCase(), cur = ymOf(today);
  const rel = /\bin (\d{1,2}|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) months?\b/.exec(m);
  if (rel) { const n = NUM_WORDS[rel[1]] ?? Number(rel[1]); return n >= 1 ? addMonthsYM(cur, n) : null; }
  if (/\b(by|before|until|till) next month\b/.test(m)) return addMonthsYM(cur, 1);
  const named = new RegExp(`\\b(?:by|before|until|till|in|for)\\s+(?:the\\s+end\\s+of\\s+|end\\s+of\\s+)?${MONTH_RE}\\b(?:\\s*,?\\s*(\\d{4}))?`).exec(m);
  if (named) {
    const idx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(named[1].slice(0, 3)) + 1;
    const mm = String(idx).padStart(2, '0');
    if (named[2]) return `${named[2]}-${mm}`;
    let y = Number(cur.slice(0, 4)); if (`${y}-${mm}` <= cur) y += 1;
    return `${y}-${mm}`;
  }
  return null;
}
