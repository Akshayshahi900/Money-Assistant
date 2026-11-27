/**
 * Deterministic query layer. EVERY number the user sees comes from here.
 * The LLM never produces or edits amounts; it only picks which of these functions to call.
 * "What counts as spending" lives in ONE place: the spend_events view in schema.sql.
 */
import type { DatabaseSync } from "node:sqlite";
import { Period, monthsInPeriod } from "./dates";

export const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CategoryRow {
  category: string;
  amount: number;
  pct: number;
  count: number;
}
export interface SpendBreakdown {
  period: Period;
  total: number;
  categories: CategoryRow[];
}
export interface TxnRow {
  id: string;
  timestamp: string;
  account_id: string;
  merchant: string | null;
  category: string;
  raw_description: string;
  net_amount: number;
}

export function spendByCategory(db: DatabaseSync, p: Period): SpendBreakdown {
  const rs = db
    .prepare(
      `SELECT category, ROUND(SUM(net_amount),2) AS amount, COUNT(*) AS count
     FROM spend_events WHERE day >= ? AND day < ? GROUP BY category HAVING SUM(net_amount) > 0 ORDER BY amount DESC`,
    )
    .all(p.from, p.to) as unknown as {
    category: string;
    amount: number;
    count: number;
  }[];
  const total = round2(rs.reduce((s, r) => s + r.amount, 0));
  return {
    period: p,
    total,
    categories: rs.map((r) => ({
      ...r,
      pct: total ? round2((r.amount / total) * 100) : 0,
    })),
  };
}

export function spendSummary(
  db: DatabaseSync,
  p: Period,
  f: {
    merchant?: string;
    category?: string;
    paymentMode?: string;
    accountId?: string;
  } = {},
): SpendBreakdown {
  const where = ["day >= ?", "day < ?"];
  const args: (string | number)[] = [p.from, p.to];
  if (f.merchant) {
    where.push("lower(COALESCE(merchant, ''))=lower(?)");
    args.push(f.merchant);
  }
  if (f.category) {
    where.push("category=?");
    args.push(f.category);
  }
  if (f.paymentMode) {
    where.push("payment_mode=?");
    args.push(f.paymentMode);
  }
  if (f.accountId) {
    where.push("account_id=?");
    args.push(f.accountId);
  }
  const rs = db
    .prepare(
      `SELECT category, ROUND(SUM(net_amount),2) AS amount, COUNT(*) AS count FROM spend_events WHERE ${where.join(" AND ")} GROUP BY category HAVING SUM(net_amount)>0 ORDER BY amount DESC`,
    )
    .all(...args) as unknown as {
    category: string;
    amount: number;
    count: number;
  }[];
  const total = round2(rs.reduce((s, r) => s + r.amount, 0));
  return {
    period: p,
    total,
    categories: rs.map((r) => ({
      ...r,
      pct: total ? round2((r.amount / total) * 100) : 0,
    })),
  };
}

export function transactionsFor(
  db: DatabaseSync,
  p: Period,
  f: {
    category?: string;
    merchant?: string;
    exactMerchant?: boolean;
    paymentMode?: string;
    accountId?: string;
  } = {},
): TxnRow[] {
  let sql = `SELECT id, timestamp, account_id, merchant, category, raw_description, net_amount FROM spend_events WHERE day >= ? AND day < ?`;
  const args: string[] = [p.from, p.to];
  if (f.category) {
    sql += " AND category = ?";
    args.push(f.category);
  }
  if (f.merchant) {
    sql += f.exactMerchant
      ? " AND lower(COALESCE(merchant,''))=lower(?)"
      : " AND merchant LIKE ?";
    args.push(f.exactMerchant ? f.merchant : `${f.merchant}%`);
  }
  if (f.paymentMode) {
    sql += " AND payment_mode = ?";
    args.push(f.paymentMode);
  }
  if (f.accountId) {
    sql += " AND account_id = ?";
    args.push(f.accountId);
  }
  return db
    .prepare(sql + " ORDER BY timestamp DESC")
    .all(...args) as unknown as TxnRow[];
}

/** Average monthly net spend in a category over a period of whole months. */
export function monthlyAverage(db: DatabaseSync, category: string, p: Period) {
  const months = Math.max(1, monthsInPeriod(p));
  const r = db
    .prepare(
      `SELECT COALESCE(ROUND(SUM(net_amount),2),0) AS total FROM spend_events WHERE category = ? AND day >= ? AND day < ?`,
    )
    .get(category, p.from, p.to) as unknown as { total: number };
  return {
    category,
    months,
    total: r.total,
    average: round2(r.total / months),
  };
}

export function monthlySpendSeries(
  db: DatabaseSync,
  p: Period,
  category?: string,
) {
  const rs = db
    .prepare(
      `SELECT substr(day,1,7) AS month, ROUND(SUM(net_amount),2) AS amount FROM spend_events
     WHERE day >= ? AND day < ? ${category ? "AND category = ?" : ""} GROUP BY month ORDER BY month`,
    )
    .all(
      ...(category ? [p.from, p.to, category] : [p.from, p.to]),
    ) as unknown as { month: string; amount: number }[];
  return rs;
}

/** Salary / regular income: credits categorised Income. */
export function monthlyIncome(db: DatabaseSync, p: Period) {
  const months = Math.max(1, monthsInPeriod(p));
  const r = db
    .prepare(
      `SELECT COALESCE(ROUND(SUM(amount),2),0) AS total FROM transactions WHERE direction='credit' AND category='Income' AND substr(timestamp,1,10) >= ? AND substr(timestamp,1,10) < ?`,
    )
    .get(p.from, p.to) as unknown as { total: number };
  return { months, total: r.total, average: round2(r.total / months) };
}

/** Average monthly total spend and implied monthly surplus (income − spend). */
export function monthlySurplus(db: DatabaseSync, p: Period) {
  const spend = spendByCategory(db, p).total,
    inc = monthlyIncome(db, p),
    months = Math.max(1, monthsInPeriod(p));
  const avgSpend = round2(spend / months);
  return {
    months,
    avgIncome: inc.average,
    avgSpend,
    avgSurplus: round2(inc.average - avgSpend),
  };
}

/** Ledger balances from synthetic opening balances plus posted debits/credits. Card debit rows increase the amount due. */
export function accountBalances(db: DatabaseSync, today: string) {
  const rows = db
    .prepare(
      `SELECT a.id,a.name,a.type,a.opening_balance,
    COALESCE(SUM(CASE WHEN substr(t.timestamp,1,10)<=? AND t.direction='credit' THEN t.amount ELSE 0 END),0) AS credits,
    COALESCE(SUM(CASE WHEN substr(t.timestamp,1,10)<=? AND t.direction='debit' THEN t.amount ELSE 0 END),0) AS debits
    FROM accounts a LEFT JOIN txn_flagged t ON t.account_id=a.id AND t.is_duplicate=0 GROUP BY a.id ORDER BY a.id`,
    )
    .all(today, today) as unknown as {
    id: string;
    name: string;
    type: string;
    opening_balance: number;
    credits: number;
    debits: number;
  }[];
  const accounts = rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    balance: round2(
      r.type === "credit_card"
        ? r.opening_balance + r.debits - r.credits
        : r.opening_balance + r.credits - r.debits,
    ),
  }));
  const net = round2(
    accounts.reduce(
      (sum, a) => sum + (a.type === "credit_card" ? -a.balance : a.balance),
      0,
    ),
  );
  return { accounts, net };
}

export function findGroupByName(db: DatabaseSync, name: string) {
  return db
    .prepare(
      `SELECT id,name FROM groups WHERE lower(name) LIKE lower(?) ORDER BY created_at DESC`,
    )
    .all(`%${name}%`) as unknown as { id: string; name: string }[];
}

export function findContact(db: DatabaseSync, name: string) {
  return db
    .prepare(
      `SELECT id, name, phone, upi_id FROM contacts WHERE name LIKE ? ORDER BY name`,
    )
    .all(`%${name}%`) as unknown as {
    id: string;
    name: string;
    phone: string;
    upi_id: string;
  }[];
}

// ---------- scenario 3 / 5 helpers: matching transactions deterministically ----------
export type ItemKey = "hotel" | "cab" | "flight" | "food";
export const ITEM_KEYS: ItemKey[] = ["hotel", "cab", "flight", "food"];
const ITEM_SQL: Record<ItemKey, string> = {
  hotel: `(raw_description LIKE '%HOTEL%' OR raw_description LIKE '%RESORT%')`,
  cab: `merchant IN ('Uber','Ola','Rapido')`,
  flight: `(merchant = 'IndiGo' OR raw_description LIKE '%FLIGHT%' OR raw_description LIKE '%INDIGO%')`,
  food: `category = 'Food & Dining'`,
};
const COLS = `id, timestamp, account_id, merchant, category, raw_description, net_amount`;
/** Strip anything that is not a plain word character so user text can never alter the SQL pattern. */
const likeSafe = (s: string) =>
  s
    .replace(/[^A-Za-z0-9 &.'-]/g, "")
    .trim()
    .slice(0, 40);

/** Spend rows in a period that match a kind of item ("the hotel", "the cab"). */
export function matchItem(
  db: DatabaseSync,
  item: ItemKey,
  p: Period,
): TxnRow[] {
  return db
    .prepare(
      `SELECT ${COLS} FROM spend_events WHERE day >= ? AND day < ? AND net_amount > 0 AND ${ITEM_SQL[item]} ORDER BY timestamp DESC`,
    )
    .all(p.from, p.to) as unknown as TxnRow[];
}
/** Free-text search over merchant or raw description ("the Swiggy ones"). */
export function searchSpend(
  db: DatabaseSync,
  text: string,
  p: Period,
): TxnRow[] {
  const t = likeSafe(text);
  if (t.length < 2) return [];
  return db
    .prepare(
      `SELECT ${COLS} FROM spend_events WHERE day >= ? AND day < ? AND net_amount > 0 AND (merchant LIKE ? OR raw_description LIKE ?) ORDER BY timestamp DESC`,
    )
    .all(p.from, p.to, `%${t}%`, `%${t}%`) as unknown as TxnRow[];
}
/** Rows mentioning a keyword anywhere in the description (e.g. "GOA") within a period. */
export function keywordTxns(
  db: DatabaseSync,
  keyword: string,
  p: Period,
): TxnRow[] {
  return searchSpend(db, keyword, p).filter((r) =>
    r.raw_description.toUpperCase().includes(likeSafe(keyword).toUpperCase()),
  );
}
/** Look rows up by id from the spend view, so amounts always come from the database, never from the client. */
export function txnsByIds(db: DatabaseSync, ids: string[]): TxnRow[] {
  const uniq = [...new Set(ids)].slice(0, 200);
  if (!uniq.length) return [];
  return db
    .prepare(
      `SELECT ${COLS} FROM spend_events WHERE id IN (${uniq.map(() => "?").join(",")}) ORDER BY timestamp DESC`,
    )
    .all(...uniq) as unknown as TxnRow[];
}
export function allContacts(db: DatabaseSync) {
  return db
    .prepare(`SELECT id, name FROM contacts ORDER BY name`)
    .all() as unknown as { id: string; name: string }[];
}
export function latestGroup(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT id, name FROM groups ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get() as unknown as { id: string; name: string } | undefined;
}
