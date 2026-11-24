/**
 * In-process latency of the full server pipeline (route -> query -> spec validation -> grounding guard -> SQLite writes),
 * i.e. everything except the network and the optional LLM call. Run: npm run bench
 * LLM-tier and HTTP numbers: see bench/http-latency.mjs (needs a running server, and for LLM tier an API key).
 */
import { rmSync } from 'node:fs';
import { openDb } from '../src/db';
import { handleChat, handleAction } from '../src/assistant';
import { summarize, table } from './stats.mts';

const N = Number(process.env.N ?? 300);
const path = `/tmp/nance-bench-${process.pid}.db`;
rmSync(path, { force: true });
openDb().exec(`VACUUM INTO '${path}'`);
const db = openDb(path);
for (const t of ['group_transactions', 'group_members', 'groups', 'goals', 'budgets', 'pending_actions', 'messages', 'sessions']) db.exec(`DELETE FROM ${t}`);
const ctx = { db, today: '2026-11-23' };
let sid = 0;
const newSession = () => { const id = `b${sid++}`; db.prepare("INSERT INTO sessions VALUES (?, 'x')").run(id); return id; };

// one group must exist for the "add the Swiggy ones" scenario
{ const s = newSession(), g = await handleChat(ctx, s, "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab.");
  if (g.ui.type !== 'group_builder') throw 0;
  const p = handleAction(ctx, s, { action: 'propose_group', name: 'Goa trip', memberIds: g.ui.members.filter((m) => m.selected).map((m) => m.id), txnIds: g.ui.transactions.filter((t) => t.selected).map((t) => t.id) }, g.messageId);
  if (p.append?.ui.type !== 'confirm_card') throw 0;
  handleAction(ctx, s, { action: 'confirm', pendingId: p.append.ui.pendingId }, p.append.messageId); }

const chat: [string, string][] = [
  ['1 breakdown', 'Where did my money go last month?'], ['2 food budget', 'I want to spend less on food.'],
  ['3 goa group', "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab."],
  ['4 phone plan', 'Can I afford an ₹80k phone by March?'], ['5 swiggy picker', 'Add the Swiggy ones to the group.'], ['6 stock advice', 'Which stock should I buy?'],
];
const time = async (f: () => unknown) => { const t = performance.now(); await f(); return performance.now() - t; };
const rows: Record<string, ReturnType<typeof summarize>> = {};

for (const [name, msg] of chat) {
  for (let i = 0; i < 20; i++) await handleChat(ctx, newSession(), msg);       // warm-up (JIT, statement cache)
  const xs: number[] = []; for (let i = 0; i < N; i++) xs.push(await time(() => handleChat(ctx, newSession(), msg)));
  rows[`chat   ${name}`] = summarize(xs);
}
// follow-up actions (what a slider drag / checkbox tick costs)
{ const s = newSession(), p = await handleChat(ctx, s, 'Can I afford an ₹80k phone by March?'), xs: number[] = [];
  for (let i = 0; i < N; i++) xs.push(await time(() => handleAction(ctx, s, { action: 'adjust_plan', targetMonth: '2027-03', monthly: 500 * (i % 80) }, p.messageId)));
  rows['action plan slider'] = summarize(xs); }
{ const s = newSession(), g = await handleChat(ctx, s, "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab."); if (g.ui.type !== 'group_builder') throw 0;
  const ids = g.ui.transactions.map((t) => t.id), xs: number[] = [];
  for (let i = 0; i < N; i++) xs.push(await time(() => handleAction(ctx, s, { action: 'update_group', name: 'Goa trip', memberIds: ['c_rahul', 'c_priya'], txnIds: ids.slice(0, i % ids.length) }, g.messageId)));
  rows['action group tick'] = summarize(xs); }
{ const s = newSession(), f = await handleChat(ctx, s, 'I want to spend less on food'), xs: number[] = [];
  for (let i = 0; i < N; i++) xs.push(await time(() => handleAction(ctx, s, { action: 'adjust_budget', category: 'Food & Dining', limit: 100 * (i % 90) }, f.messageId)));
  rows['action budget slider'] = summarize(xs); }

console.log(`\nIn-process pipeline latency (rule-routed path, no network, no LLM). node ${process.version}, N=${N} per row after warm-up.\n`);
table(rows);
rmSync(path, { force: true });
