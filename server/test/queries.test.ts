import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/db';
import { spendByCategory, transactionsFor, monthlyAverage, monthlySurplus } from '../src/queries';
import { resolvePeriod, monthPeriod } from '../src/dates';

const db = openDb();
const truth = JSON.parse(readFileSync(resolve(__dirname, '../../data/ground_truth.json'), 'utf8')).monthly_net_spend as Record<string, Record<string, number>>;

describe('date resolver (fixed today = 2026-11-23)', () => {
  it('resolves relative periods', () => {
    expect(resolvePeriod('yesterday', '2026-11-23')).toMatchObject({ from: '2026-11-22', to: '2026-11-23' });
    expect(resolvePeriod('last_month', '2026-11-23')).toMatchObject({ from: '2026-10-01', to: '2026-11-01', label: 'October 2026' });
    expect(resolvePeriod('last_month', '2027-01-15')).toMatchObject({ from: '2026-12-01', to: '2027-01-01' }); // year boundary
    expect(resolvePeriod('last_3_months', '2026-11-23')).toMatchObject({ from: '2026-08-01', to: '2026-11-01' });
  });
});

describe('spend queries vs independent ground truth', () => {
  for (const ym of Object.keys(truth)) {
    it(`matches ground truth for ${ym} (per category + total)`, () => {
      const got = spendByCategory(db, monthPeriod(ym));
      const exp = truth[ym];
      const expTotal = Math.round(Object.values(exp).reduce((a, b) => a + b, 0) * 100) / 100;
      expect(got.total).toBeCloseTo(expTotal, 2);
      for (const [cat, amount] of Object.entries(exp)) {
        const row = got.categories.find((c) => c.category === cat);
        expect(row?.amount ?? 0, `${ym} ${cat}`).toBeCloseTo(Math.max(amount, 0), 2);
      }
    });
  }
});

describe('messy-data rules', () => {
  it('excludes own-account transfers', () => {
    const t = db.prepare(`SELECT COUNT(*) AS n FROM spend_events WHERE raw_description LIKE '%CC BILL PAY%' OR raw_description LIKE '%WALLET LOAD%' OR raw_description LIKE '%PAYMENT RECEIVED%'`).get() as unknown as { n: number };
    expect(t.n).toBe(0);
  });
  it('removes exact duplicates but keeps the first posting', () => {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM txn_flagged WHERE is_duplicate=1`).get() as unknown as { n: number }).n;
    expect(n).toBe(7);
  });
  it('nets refunds and reversals against spend', () => {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM spend_events WHERE net_amount < 0`).get() as unknown as { n: number };
    expect(r.n).toBeGreaterThanOrEqual(2);
  });
  it('does not count salary or friend repayments as spend', () => {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM spend_events WHERE raw_description LIKE '%SALARY%' OR raw_description LIKE '%DINNER SPLIT%'`).get() as unknown as { n: number };
    expect(r.n).toBe(0);
  });
  it('category totals sum to the grand total (no lost or double-counted rows)', () => {
    const b = spendByCategory(db, resolvePeriod('last_month', '2026-11-23'));
    expect(round(b.categories.reduce((s, c) => s + c.amount, 0))).toBe(b.total);
    const txnSum = transactionsFor(db, b.period).reduce((s, t) => s + t.net_amount, 0);
    expect(round(txnSum)).toBe(b.total); // drill-down == summary
  });
});

describe('scenario fixtures', () => {
  it('yesterday has exactly one hotel and one cab', () => {
    const y = transactionsFor(db, resolvePeriod('yesterday', '2026-11-23'));
    expect(y.filter((t) => t.merchant === 'MakeMyTrip')).toHaveLength(1);
    expect(y.filter((t) => t.merchant === 'Uber')).toHaveLength(1);
  });
  it('"Swiggy" is ambiguous in the last 30 days (3+ distinct Swiggy merchants)', () => {
    const m = new Set(transactionsFor(db, resolvePeriod('last_30_days', '2026-11-23'), { merchant: 'Swiggy' }).map((t) => t.merchant));
    expect(m.size).toBeGreaterThanOrEqual(3);
  });
  it('monthlyAverage and surplus are computed from data', () => {
    const p = resolvePeriod('last_3_months', '2026-11-23');
    expect(monthlyAverage(db, 'Food & Dining', p).months).toBe(3);
    expect(monthlySurplus(db, p).avgIncome).toBe(85000);
  });
});
function round(n: number) { return Math.round(n * 100) / 100; }
