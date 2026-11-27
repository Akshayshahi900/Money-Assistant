import type { DatabaseSync } from "node:sqlite";
import { addDays, resolvePeriod, type Period } from "./dates";

export interface SpendFilters {
  merchant?: string;
  category?: string;
  paymentMode?: string;
  accountId?: string;
}
export type SpendScope =
  | {
      status: "ready";
      period: Period;
      filters: SpendFilters;
      queryLabel: string;
      dataFrom: string;
      dataTo: string;
      countRequested?: boolean;
    }
  | {
      status: "partial";
      period: Period;
      filters: SpendFilters;
      queryLabel: string;
      dataFrom: string;
      dataTo: string;
      countRequested?: boolean;
    }
  | { status: "needs_period"; filters: SpendFilters; queryLabel: string }
  | {
      status: "out_of_range";
      period: Period;
      filters: SpendFilters;
      queryLabel: string;
      dataFrom: string;
      dataTo: string;
    }
  | {
      status: "merchant_missing";
      filters: SpendFilters;
      queryLabel: string;
      merchant: string;
    };

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const monthName = (ym: string) =>
  MONTHS[Number(ym.slice(5, 7)) - 1].replace(/^./, (c) => c.toUpperCase());
const labelMonth = (ym: string) =>
  `${monthName(ym).slice(0, 3)} ${ym.slice(0, 4)}`;
const pad = (n: number) => String(n).padStart(2, "0");
const first = (ym: string) => `${ym}-01`;
const nextMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
};

export function parseSpendPeriod(text: string, today: string): Period | null {
  const m = text.toLowerCase();
  if (/\byesterday\b/.test(m)) return resolvePeriod("yesterday", today);
  if (/\b(today|so far today)\b/.test(m)) return resolvePeriod("today", today);
  if (/\bthis week\b/.test(m)) return resolvePeriod("this_week", today);
  if (/\bthis month\b/.test(m)) return resolvePeriod("this_month", today);
  if (/\blast month\b/.test(m)) return resolvePeriod("last_month", today);
  if (/\blast\s+(?:three|3)\s+months\b/.test(m))
    return resolvePeriod("last_3_months", today);
  const days = /\blast\s+(\d{1,4})\s+days?\b/.exec(m);
  if (days) {
    const n = Number(days[1]);
    if (n >= 1 && n <= 3650)
      return {
        from: addDays(today, -(n - 1)),
        to: addDays(today, 1),
        label: `last ${n} days`,
      };
  }
  const monthPattern =
    "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";
  const named =
    new RegExp(
      `\\b(?:in|during|for|on|last)\\s+${monthPattern}(?:\\s+(20\\d{2}))?\\b`,
      "i",
    ).exec(text) ??
    new RegExp(`\\b${monthPattern}\\s+(20\\d{2})\\b`, "i").exec(text);
  if (!named) return null;
  const monthWord = named[1].toLowerCase();
  const monthIndex =
    MONTHS.findIndex((x) => x.startsWith(monthWord.slice(0, 3))) + 1;
  let year = named[2] ? Number(named[2]) : Number(today.slice(0, 4));
  if (!named[2] && monthIndex > Number(today.slice(5, 7))) year -= 1;
  const ym = `${year}-${pad(monthIndex)}`;
  return {
    from: first(ym),
    to: nextMonth(ym),
    label: `${monthName(ym)} ${ym.slice(0, 4)}`,
  };
}

function dataRange(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT MIN(day) AS data_from, MAX(day) AS data_to FROM spend_events`,
    )
    .get() as { data_from: string | null; data_to: string | null };
}
function matchKnown(
  db: DatabaseSync,
  table: string,
  column: string,
  text: string,
): string | undefined {
  // table/column names are constants at call sites; values remain bound parameters.
  const rows = db
    .prepare(
      `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL ORDER BY LENGTH(${column}) DESC`,
    )
    .all() as { value: string }[];
  return rows.find((r) =>
    new RegExp(
      `(^|[^a-z0-9])${r.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
      "i",
    ).test(text),
  )?.value;
}
function unknownMerchant(text: string): string | undefined {
  const m =
    /\b(?:on|at|from|merchant)\s+(?:(?:the|my)\s+)?([a-z][a-z0-9 &'().-]{1,35}?)(?=\s+(?:in|during|for|over|this|last|between|by|on|via|using)\b|[?.!,]|$)/i.exec(
      text,
    );
  return m?.[1]?.trim();
}
function filtersFor(
  db: DatabaseSync,
  text: string,
): { filters: SpendFilters; unknownMerchant?: string } {
  const filters: SpendFilters = {};
  const merchant = matchKnown(db, "transactions", "merchant", text);
  let category = matchKnown(db, "spend_events", "category", text);
  if (!category) {
    const aliases: [RegExp, string][] = [
      [/\b(food|dining|restaurants?)\b/i, "Food & Dining"],
      [/\bgrocer(y|ies)\b/i, "Groceries"],
      [/\btransport\b/i, "Transport"],
      [/\bshopping\b/i, "Shopping"],
      [/\bentertainment\b/i, "Entertainment"],
      [/\bsubscriptions?\b/i, "Subscriptions"],
      [/\b(bills?|utilities)\b/i, "Bills & Utilities"],
    ];
    category = aliases.find(([re]) => re.test(text))?.[1];
  }
  const paymentMode = /\bcash\s+flow\b/i.test(text)
    ? undefined
    : matchKnown(db, "transactions", "payment_mode", text);
  const account = matchKnown(db, "accounts", "name", text);
  if (merchant) filters.merchant = merchant;
  if (category && category !== "Income") filters.category = category;
  if (paymentMode) filters.paymentMode = paymentMode;
  if (account) {
    const row = db
      .prepare("SELECT id FROM accounts WHERE name=?")
      .get(account) as { id: string } | undefined;
    if (row) filters.accountId = row.id;
  }
  const candidate = merchant ? undefined : unknownMerchant(text);
  const categoryOnly =
    candidate &&
    /^(food|dining|food\s*(?:&|and)\s*dining|restaurants?|grocer(?:y|ies)|transport|travel|shopping|entertainment|subscriptions?|bills?|utilities|cabs?|taxis?)$/i.test(
      candidate,
    );
  return { filters, unknownMerchant: categoryOnly ? undefined : candidate };
}
export function parseSpendScope(
  db: DatabaseSync,
  text: string,
  today: string,
): SpendScope {
  const countRequested = /\bhow many\b.{0,40}\b(?:times|orders?|transactions?)\b/i.test(text);
  const { filters, unknownMerchant: missing } = filtersFor(db, text);
  const period = parseSpendPeriod(text, today);
  const accountLabel = filters.accountId
    ? (
        db
          .prepare("SELECT name FROM accounts WHERE id=?")
          .get(filters.accountId) as { name: string } | undefined
      )?.name
    : undefined;
  const queryLabel = [
    filters.merchant ?? missing,
    filters.category,
    filters.paymentMode,
    accountLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  if (missing) {
    const exists = db
      .prepare(
        "SELECT 1 FROM transactions WHERE lower(COALESCE(merchant, ''))=lower(?) LIMIT 1",
      )
      .get(missing);
    if (!exists)
      return {
        status: "merchant_missing",
        filters,
        merchant: missing,
        queryLabel: [missing, period?.label].filter(Boolean).join(" · "),
      };
  }
  if (!period)
    return {
      status: "needs_period",
      filters,
      queryLabel: [queryLabel || "All spending", "period needed"].join(" · "),
    };
  const range = dataRange(db);
  const query =
    [
      filters.merchant ?? missing,
      filters.category,
      filters.paymentMode,
      accountLabel,
    ]
      .filter(Boolean)
      .join(" · ") || "All spending";
  const periodHeader =
    /^\d{4}-\d{2}-01$/.test(period.from) &&
    nextMonth(period.from.slice(0, 7)) === period.to
      ? labelMonth(period.from.slice(0, 7))
      : period.label;
  const label = `${query} · ${periodHeader}`;
  if (
    !range.data_from ||
    !range.data_to ||
    period.to <= range.data_from ||
    period.from > range.data_to
  )
    return {
      status: "out_of_range",
      period,
      filters,
      queryLabel: label,
      dataFrom: range.data_from ?? "unknown",
      dataTo: range.data_to ?? "unknown",
    };
  if (period.from < range.data_from || period.to > addDays(range.data_to, 1))
    return {
      status: "partial",
      period,
      filters,
      queryLabel: label,
      dataFrom: range.data_from,
      dataTo: range.data_to,
      countRequested,
    };
  return {
    status: "ready",
    period,
    filters,
    queryLabel: label,
    dataFrom: range.data_from,
    dataTo: range.data_to,
    countRequested,
  };
}
