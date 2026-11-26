/**
 * Deterministic synthetic data generator (seeded). Run: npm run seed
 * Writes: data/nance.db, data/dataset.json (the dataset deliverable),
 *         data/ground_truth.json (independent per-month/category net spend, used by tests + eval)
 * Ground truth is built from the *intended* purchases BEFORE messy rows
 * (duplicates, transfers, splits) are injected, so it is independent of the SQL rules under test.
 */
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from '../db';

const SEED = Number(process.env.SEED ?? 42);
const END_DAY = '2026-11-22'; // latest transaction date; evaluation "today" is 2026-11-23
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../../data');

// ---------- seeded PRNG ----------
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const ref = () => String(int(100000000000, 999999999999));
const round2 = (n: number) => Math.round(n * 100) / 100;
const amt = (lo: number, hi: number) => round2(int(lo, hi) + (rnd() < 0.25 ? pick([0.5, 0.25, 0.75, 0.99]) : 0));
const pad = (n: number) => String(n).padStart(2, '0');

// ---------- static entities ----------
const accounts = [
  { id: 'acc_sav', name: 'HDFC Savings ••4412', type: 'savings', opening_balance: 150000 },
  { id: 'acc_cc', name: 'ICICI Amazon Pay Credit Card ••9037', type: 'credit_card', opening_balance: 5000 },
  { id: 'acc_wal', name: 'Paytm Wallet', type: 'wallet', opening_balance: 2500 },
];
const contacts = [
  { id: 'c_rahul', name: 'Rahul Sharma', phone: '+91 98100 11001', upi_id: 'rahul.sharma@okhdfcbank' },
  { id: 'c_priya', name: 'Priya Menon', phone: '+91 98100 11002', upi_id: 'priya.menon@okicici' },
  { id: 'c_ankit', name: 'Ankit Verma', phone: '+91 98100 11003', upi_id: 'ankitv@ybl' },
  { id: 'c_neha', name: 'Neha Kapoor', phone: '+91 98100 11004', upi_id: 'neha.k@oksbi' },
  { id: 'c_mom', name: 'Mom', phone: '+91 98100 11005', upi_id: 'sunita.shah@okaxis' },
];

// ---------- row accumulation ----------
interface Row {
  id?: string; account_id: string; timestamp: string; amount: number; direction: 'debit' | 'credit';
  raw_description: string; payment_mode: string; merchant: string | null; category: string | null;
}
const rows: Row[] = [];
const truth: Record<string, Record<string, number>> = {}; // month -> category -> net spend

const ts = (day: string, h?: number, m?: number, s?: number) =>
  `${day}T${pad(h ?? int(8, 22))}:${pad(m ?? int(0, 59))}:${pad(s ?? int(0, 59))}+05:30`;

function addTruth(day: string, category: string | null, net: number) {
  const mo = day.slice(0, 7), c = category ?? 'Uncategorised';
  truth[mo] ??= {}; truth[mo][c] = round2((truth[mo][c] ?? 0) + net);
}
/** a genuine purchase: counts in ground truth */
function spend(r: Omit<Row, 'direction'>, day: string) {
  rows.push({ ...r, direction: 'debit' });
  addTruth(day, r.category, r.amount);
}
function other(r: Row) { rows.push(r); }

// ---------- month loop ----------
const months: [number, number][] = [[2026,4],[2026,5],[2026,6],[2026,7],[2026,8],[2026,9],[2026,10],[2026,11]];
const MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

const upiRaw = (name: string, handle: string, note = '') => `UPI/DR/${ref()}/${name}/${handle}${note ? '/' + note : ''}`;
const cardsAmzRefundable: { day: string; amount: number; merchant: string }[] = [];

for (const [y, mo] of months) {
  const ym = `${y}-${pad(mo)}`;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const last = ym === END_DAY.slice(0, 7) ? Number(END_DAY.slice(8)) : dim;
  const D = (d: number) => `${ym}-${pad(d)}`;
  const rd = () => D(int(1, last));

  // income + fixed
  other({ account_id: 'acc_sav', timestamp: ts(D(1), 9, 12, 4), amount: 85000, direction: 'credit',
    raw_description: `NEFT/CR/ACME TECHNOLOGIES PVT LTD/SALARY ${MON[mo-1]} ${y}`, payment_mode: 'Net Banking', merchant: 'Acme Technologies', category: 'Income' });
  spend({ account_id: 'acc_sav', timestamp: ts(D(5), 10, 3, 11), amount: 18000,
    raw_description: `NEFT/DR/RAMESH KUMAR/RENT ${MON[mo-1]}`, payment_mode: 'Net Banking', merchant: 'Ramesh Kumar (Landlord)', category: 'Rent' }, D(5));
  spend({ account_id: 'acc_cc', timestamp: ts(D(3), 0, 5, 0), amount: 119, raw_description: 'SPOTIFY INDIA MUMBAI IN', payment_mode: 'Card', merchant: 'Spotify', category: 'Subscriptions' }, D(3));
  spend({ account_id: 'acc_cc', timestamp: ts(D(12), 0, 7, 0), amount: 649, raw_description: 'NETFLIX.COM MUMBAI IN', payment_mode: 'Card', merchant: 'Netflix', category: 'Subscriptions' }, D(12));
  if (last >= 20) spend({ account_id: 'acc_cc', timestamp: ts(D(20), 0, 9, 0), amount: 130, raw_description: 'GOOGLE *CLOUD STORAGE', payment_mode: 'Card', merchant: 'Google One', category: 'Subscriptions' }, D(20));
  spend({ account_id: 'acc_sav', timestamp: ts(D(8), 11, 20, 0), amount: 799, raw_description: upiRaw('JIO PREPAID', 'jio@sbi', 'RECHARGE'), payment_mode: 'UPI', merchant: 'Jio', category: 'Bills & Utilities' }, D(8));
  spend({ account_id: 'acc_sav', timestamp: ts(D(15), 14, 2, 9), amount: amt(1100, 2400), raw_description: `BBPS/DR/BSES RAJDHANI/${ref()}`, payment_mode: 'Net Banking', merchant: 'BSES Electricity', category: 'Bills & Utilities' }, D(15));

  // variable spend. 4% of categorised rows lose their category (messy data)
  const cat = (c: string) => (rnd() < 0.04 ? null : c);
  const upi = (day: string, merchant: string, handle: string, amount: number, category: string | null) =>
    spend({ account_id: 'acc_sav', timestamp: ts(day), amount, raw_description: upiRaw(merchant.toUpperCase(), handle), payment_mode: 'UPI', merchant, category }, day);
  const card = (day: string, merchant: string, rawName: string, amount: number, category: string | null) =>
    spend({ account_id: 'acc_cc', timestamp: ts(day), amount, raw_description: `${rawName} ${int(1000, 9999)}`, payment_mode: 'Card', merchant, category }, day);

  for (let i = 0; i < int(7, 11); i++) { const d = rd(); rnd() < 0.6 ? upi(d, 'Swiggy', 'swiggy@icici', amt(180, 650), cat('Food & Dining')) : card(d, 'Swiggy', 'SWIGGY BANGALORE IN ORDER', amt(180, 650), cat('Food & Dining')); }
  for (let i = 0; i < int(3, 5); i++) card(rd(), 'Zomato', 'ZOMATO*ORDER', amt(220, 700), cat('Food & Dining'));
  for (let i = 0; i < int(2, 4); i++) card(rd(), pick(['Social Offline', 'Barbeque Nation', 'Toit Brewpub']), `POS ${int(1000,9999)} RESTAURANT MUMBAI`, amt(600, 2200), cat('Food & Dining'));
  for (let i = 0; i < int(2, 3); i++) card(rd(), 'Starbucks', 'STARBUCKS COFFEE', amt(280, 650), cat('Food & Dining'));
  for (let i = 0; i < int(4, 6); i++) upi(rd(), 'Blinkit', 'blinkit@ybl', amt(150, 900), cat('Groceries'));
  for (let i = 0; i < int(2, 3); i++) upi(rd(), 'Zepto', 'zepto@axis', amt(150, 800), cat('Groceries'));
  for (let i = 0; i < int(2, 4); i++) upi(rd(), 'Swiggy Instamart', 'swiggyinstamart@icici', amt(200, 900), cat('Groceries'));
  card(rd(), 'BigBasket', 'BIGBASKET INNOVATIVE', amt(900, 2500), cat('Groceries'));
  card(rd(), 'DMart', 'DMART AVENUE SUPERMARTS', amt(1500, 3500), cat('Groceries'));
  for (let i = 0; i < int(4, 6); i++) { const d = rd(); rnd() < 0.5 ? card(d, 'Uber', 'UBER INDIA SYSTEMS', amt(120, 480), cat('Transport')) : upi(d, 'Uber', 'uber@axis', amt(120, 480), cat('Transport')); }
  for (let i = 0; i < int(2, 3); i++) upi(rd(), 'Ola', 'ola@icici', amt(100, 420), cat('Transport'));
  for (let i = 0; i < int(3, 4); i++) upi(rd(), 'Rapido', 'rapido@ybl', amt(60, 180), cat('Transport'));
  for (let i = 0; i < 2; i++) card(rd(), 'HPCL', 'HPCL PETROL PUMP', amt(1200, 2500), cat('Transport'));
  for (let i = 0; i < int(2, 3); i++) { const d = rd(); const a = amt(399, 6500); card(d, 'Amazon', 'AMAZON PAY INDIA', a, cat('Shopping')); if (a > 1500) cardsAmzRefundable.push({ day: d, amount: a, merchant: 'Amazon' }); }
  for (let i = 0; i < int(1, 2); i++) card(rd(), 'Flipkart', 'FLIPKART INTERNET', amt(500, 4000), cat('Shopping'));
  { const d = rd(); const a = amt(800, 3500); card(d, 'Myntra', 'MYNTRA DESIGNS', a, cat('Shopping')); cardsAmzRefundable.push({ day: d, amount: a, merchant: 'Myntra' }); }
  for (let i = 0; i < int(1, 2); i++) upi(rd(), 'Apollo Pharmacy', 'apollo@hdfcbank', amt(150, 1200), cat('Health'));
  card(rd(), 'BookMyShow', 'BOOKMYSHOW', amt(500, 1200), cat('Entertainment'));
  other({ account_id: 'acc_sav', timestamp: ts(rd(), 12, 30, 0), amount: pick([2000, 3000, 5000]), direction: 'debit',
    raw_description: `ATM WDL HDFC BANK BKC MUMBAI ${int(1000,9999)}`, payment_mode: 'Cash', merchant: null, category: 'Cash Withdrawal' });
  // (cash withdrawals are tracked as spend in truth below)

  // wallet: load (transfer) + small spends
  const loadDay = D(2);
  other({ account_id: 'acc_sav', timestamp: ts(loadDay, 9, 40, 0), amount: 2000, direction: 'debit', raw_description: upiRaw('PAYTM WALLET LOAD', 'paytm@paytm'), payment_mode: 'UPI', merchant: null, category: null });
  other({ account_id: 'acc_wal', timestamp: ts(loadDay, 9, 40, 30), amount: 2000, direction: 'credit', raw_description: 'WALLET LOAD FROM HDFC BANK', payment_mode: 'Wallet', merchant: null, category: null });
  for (let i = 0; i < 4; i++) spend({ account_id: 'acc_wal', timestamp: ts(rd()), amount: amt(40, 120), raw_description: `DMRC METRO TOPUP ${int(100,999)}`, payment_mode: 'Wallet', merchant: 'Delhi Metro', category: cat('Transport') }, '');
  for (let i = 0; i < 3; i++) spend({ account_id: 'acc_wal', timestamp: ts(rd()), amount: amt(40, 150), raw_description: `CHAI POINT ${int(100,999)}`, payment_mode: 'Wallet', merchant: 'Chai Point', category: cat('Food & Dining') }, '');

  // unclear merchants: no merchant, no category
  for (let i = 0; i < int(4, 6); i++) {
    const d = rd(), kind = int(0, 2);
    const raw = kind === 0 ? upiRaw(`PAYU*MERCHANT ${int(1000,9999)}`, 'payu@axis')
      : kind === 1 ? upiRaw(pick(['MOHD AZHAR', 'SURESH P', 'K RAVI KUMAR', 'DEEPAK S']), `${int(7000000000, 9999999999)}@ybl`)
      : `POS ${int(1000,9999)} SAI KRIPA ENT MUMBAI`;
    spend({ account_id: kind === 2 ? 'acc_cc' : 'acc_sav', timestamp: ts(d), amount: amt(99, 1500), raw_description: raw, payment_mode: kind === 2 ? 'Card' : 'UPI', merchant: null, category: null }, d);
  }

  // shared dinner: user pays, friend repays half (repayment is a credit, NOT income, NOT netted)
  { const d = D(int(1, Math.max(1, last - 4))); const a = amt(2400, 4200) ;
    card(d, 'Toit Brewpub', 'POS RESTAURANT BKC', a, 'Food & Dining');
    other({ account_id: 'acc_sav', timestamp: ts(D(Math.min(last, Number(d.slice(8)) + 2)), 20, 11, 5), amount: round2(a / 2), direction: 'credit',
      raw_description: `UPI/CR/${ref()}/${pick(['RAHUL SHARMA', 'PRIYA MENON'])}/DINNER SPLIT`, payment_mode: 'UPI', merchant: null, category: null }); }
}

// the "ATM" rows were pushed via other(); register them in truth
for (const r of rows) if (r.category === 'Cash Withdrawal') addTruth(r.timestamp.slice(0, 10), r.category, r.amount);
// wallet rows were added with day '' -> fix truth by recomputing month from timestamp
for (const k of Object.keys(truth)) if (k === '') delete truth[k];
for (const r of rows) if (r.account_id === 'acc_wal' && r.direction === 'debit') addTruth(r.timestamp.slice(0, 10), r.category, r.amount);

// ---------- refunds, reversals ----------
const refundables = cardsAmzRefundable.filter((x) => x.day < '2026-11-10').filter((_, i) => i % 5 === 0).slice(0, 4);
for (const rf of refundables) {
  const d = new Date(rf.day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + int(3, 6));
  const day = d.toISOString().slice(0, 10);
  other({ account_id: 'acc_cc', timestamp: ts(day, 11, 15, 0), amount: rf.amount, direction: 'credit',
    raw_description: `${rf.merchant.toUpperCase()} REFUND ORDER ${int(10000,99999)}`, payment_mode: 'Card', merchant: rf.merchant, category: 'Shopping' });
  addTruth(day, 'Shopping', -rf.amount);
}
// failed UPI payment + reversal (net zero)
{ const day = '2026-09-14', a = 340, rr = ref();
  rows.push({ account_id: 'acc_sav', timestamp: ts(day, 18, 2, 10), amount: a, direction: 'debit', raw_description: `UPI/DR/${rr}/UBER/uber@axis`, payment_mode: 'UPI', merchant: 'Uber', category: 'Transport' });
  addTruth(day, 'Transport', a);
  rows.push({ account_id: 'acc_sav', timestamp: ts(day, 18, 9, 40), amount: a, direction: 'credit', raw_description: `UPI/CR/${rr}/REVERSAL UBER FAILED TXN`, payment_mode: 'UPI', merchant: 'Uber', category: 'Transport' });
  addTruth(day, 'Transport', -a); }

// ---------- Goa trip + Swiggy ambiguity (scenarios 3 and 5; "today" = 2026-11-23) ----------
const Y = '2026-11-22';
spend({ account_id: 'acc_sav', timestamp: ts(Y, 6, 40, 12), amount: 1450, raw_description: upiRaw('UBER INDIA', 'uber@axis', 'GOA AIRPORT'), payment_mode: 'UPI', merchant: 'Uber', category: 'Transport' }, Y);
spend({ account_id: 'acc_cc', timestamp: ts(Y, 13, 5, 33), amount: 18400, raw_description: 'MAKEMYTRIP*HOTEL GOA BEACH RESORT', payment_mode: 'Card', merchant: 'MakeMyTrip', category: 'Travel' }, Y);
spend({ account_id: 'acc_cc', timestamp: ts('2026-11-05', 16, 20, 0), amount: 9800, raw_description: 'INDIGO 6E BOOKING GOA DEL', payment_mode: 'Card', merchant: 'IndiGo', category: 'Travel' }, '2026-11-05');
const sw = (day: string, h: number, m: number, merchant: string, handle: string, a: number, c: string) =>
  spend({ account_id: 'acc_sav', timestamp: ts(day, h, m, 20), amount: a, raw_description: upiRaw(merchant.toUpperCase(), handle), payment_mode: 'UPI', merchant, category: c }, day);
sw('2026-11-20', 21, 10, 'Swiggy', 'swiggy@icici', 412, 'Food & Dining');
sw('2026-11-21', 20, 45, 'Swiggy', 'swiggy@icici', 289, 'Food & Dining');
sw('2026-11-22', 9, 5, 'Swiggy Instamart', 'swiggyinstamart@icici', 356, 'Groceries');
sw('2026-11-22', 20, 30, 'Swiggy Dineout', 'swiggydineout@icici', 1180, 'Food & Dining');

// ---------- duplicates (same payment posted twice within a minute) ----------
const dupCandidates = rows.filter((r) => r.direction === 'debit' && r.payment_mode === 'UPI' && r.merchant && r.account_id === 'acc_sav' && !r.raw_description.includes('WALLET'));
for (let i = 0; i < 7; i++) {
  const src = dupCandidates[int(0, dupCandidates.length - 1)];
  const t = new Date(src.timestamp); t.setSeconds(t.getSeconds() + int(20, 90));
  const iso = new Date(t.getTime() + 330 * 60000).toISOString().slice(0, 19) + '+05:30';
  rows.push({ ...src, id: undefined, timestamp: iso });
}

// ---------- credit-card bill payments (own-account transfer, two legs) ----------
for (const [y, mo] of months.slice(0, -1)) {
  const ym = `${y}-${pad(mo)}`;
  const bill = round2(rows.filter((r) => r.account_id === 'acc_cc' && r.timestamp.startsWith(ym)).reduce((s, r) => s + (r.direction === 'debit' ? r.amount : -r.amount), 0));
  const nm = mo === 12 ? 1 : mo + 1, ny = mo === 12 ? y + 1 : y;
  const day = `${ny}-${pad(nm)}-10`;
  if (day > END_DAY || bill <= 0) continue;
  other({ account_id: 'acc_sav', timestamp: ts(day, 10, 15, 0), amount: bill, direction: 'debit', raw_description: `NEFT/DR/ICICI CC BILL PAY ${ref()}`, payment_mode: 'Net Banking', merchant: null, category: null });
  other({ account_id: 'acc_cc', timestamp: ts(day, 10, 16, 0), amount: bill, direction: 'credit', raw_description: 'PAYMENT RECEIVED THANK YOU', payment_mode: 'Net Banking', merchant: null, category: null });
}

// ---------- finalize: sort, assign ids, write ----------
rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
rows.forEach((r, i) => (r.id = `txn_${String(i + 1).padStart(4, '0')}`));

for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) rmSync(f, { force: true });
const db = openDb();
db.exec('BEGIN');
const ia = db.prepare('INSERT INTO accounts (id,name,type,opening_balance) VALUES (?,?,?,?)');
for (const a of accounts) ia.run(a.id, a.name, a.type, a.opening_balance);
const ic = db.prepare('INSERT INTO contacts VALUES (?,?,?,?)');
for (const c of contacts) ic.run(c.id, c.name, c.phone, c.upi_id);
const it = db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?)');
for (const r of rows) it.run(r.id!, r.account_id, r.timestamp, r.amount, r.direction, r.raw_description, r.payment_mode, r.merchant, r.category);
db.exec('COMMIT');

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'dataset.json'), JSON.stringify({ accounts, contacts, transactions: rows }, null, 1));
writeFileSync(resolve(outDir, 'ground_truth.json'), JSON.stringify({ seed: SEED, monthly_net_spend: truth }, null, 1));
console.log(`seeded ${rows.length} transactions, ${accounts.length} accounts, ${contacts.length} contacts -> ${DB_PATH}`);
