import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleChat, handleAction, loadState } from '../src/assistant';
import { ruleRoute } from '../src/router';
import { parseTargetMonth } from '../src/dates';
import { equalSplit } from '../src/common';
import { freshCtx, count } from './helpers';

let ctx = freshCtx();
beforeEach(() => { ctx = freshCtx(); });

// Independent oracle: plain JS over the raw dataset file, no SQL views involved.
const ds = JSON.parse(readFileSync(resolve(__dirname, '../../data/dataset.json'), 'utf8'));
const truth = JSON.parse(readFileSync(resolve(__dirname, '../../data/ground_truth.json'), 'utf8')).monthly_net_spend as Record<string, Record<string, number>>;
const yesterday = ds.transactions.filter((t: any) => t.timestamp.startsWith('2026-11-22'));
const hotel = yesterday.find((t: any) => t.merchant === 'MakeMyTrip'), cab = yesterday.find((t: any) => t.merchant === 'Uber');

const GOA = 'Make a Goa trip group with Rahul and Priya and add yesterday\'s hotel and cab.';
async function draft() { const o = await handleChat(ctx, 's1', GOA); if (o.ui.type !== 'group_builder') throw new Error('not a builder: ' + o.ui.type); return { o, ui: o.ui }; }
const selMembers = (u: any) => u.members.filter((m: any) => m.selected).map((m: any) => m.id);
const selTxns = (u: any) => u.transactions.filter((t: any) => t.selected).map((t: any) => t.id);
const payload = (u: any, over: any = {}) => ({ name: u.name, memberIds: selMembers(u), txnIds: selTxns(u), ...over });

describe('routing: all six scenarios hit the zero-latency rule path', () => {
  it.each([
    ['Where did my money go last month?', 'show_spending_breakdown'],
    ['I want to spend less on food.', 'suggest_budget'],
    [GOA, 'create_group'],
    ['Can I afford an ₹80k phone by March?', 'plan_purchase'],
    ['Add the Swiggy ones to the group.', 'add_to_group'],
    ['Which stock should I buy?', 'investment_question'],
    ['should I invest in mutual funds', 'investment_question'],
    ['Can I afford a 1.5 lakh laptop in 6 months', 'plan_purchase'],
  ])('%s', (msg, tool) => expect(ruleRoute(msg, '2026-11-23')?.tool).toBe(tool));
  it('parses the Goa sentence into structured args', () => {
    expect(ruleRoute(GOA)?.args).toEqual({ groupName: 'Goa trip', memberNames: ['Rahul', 'Priya'], items: ['hotel', 'cab'], period: 'yesterday' });
  });
  it('resolves target months against today', () => {
    expect(parseTargetMonth('by March', '2026-11-23')).toBe('2027-03');
    expect(parseTargetMonth('by november', '2026-11-23')).toBe('2027-11');
    expect(parseTargetMonth('in 6 months', '2026-11-23')).toBe('2027-05');
    expect(parseTargetMonth('by Jan 2028', '2026-11-23')).toBe('2028-01');
    expect(parseTargetMonth('I may buy it', '2026-11-23')).toBeNull();
  });
});

describe('scenario 3: Goa trip group', () => {
  it('pre-fills members and the matching hotel + cab from the data', async () => {
    const { ui } = await draft();
    expect(ui.name).toBe('Goa trip');
    expect(ui.members.filter((m) => m.selected).map((m) => m.name)).toEqual(['Priya Menon', 'Rahul Sharma']);
    const sel = ui.transactions.filter((t) => t.selected);
    expect(sel).toHaveLength(2);
    expect(sel.map((t) => t.id).sort()).toEqual([hotel.id, cab.id].sort());
    expect(ui.total).toBe(hotel.amount + cab.amount);                   // oracle: 18400 + 1450
    expect(ui.split).toEqual({ people: 3, each: 6616.66, you: 6616.68 });
    expect(Math.round((ui.split!.each * 2 + ui.split!.you) * 100)).toBe(Math.round(ui.total * 100));   // shares add up exactly
    const flight = ui.transactions.find((t) => t.merchant === 'IndiGo');
    expect(flight?.selected).toBe(false);                               // trip-related but not requested: offered, not assumed
    expect(flight?.hint).toContain('GOA');
  });
  it('creates nothing until confirmed', async () => {
    const { o, ui } = await draft();
    const r = handleAction(ctx, 's1', { action: 'propose_group', ...payload(ui) }, o.messageId);
    expect(r.append?.ui.type).toBe('confirm_card');
    expect(count(ctx.db, 'groups')).toBe(0);
    expect(count(ctx.db, 'group_transactions')).toBe(0);
  });
  it('editing recomputes total and split on the server', async () => {
    const { o, ui } = await draft();
    const r = handleAction(ctx, 's1', { action: 'update_group', ...payload(ui, { txnIds: [hotel.id] }) }, o.messageId);
    if (r.replace?.ui.type !== 'group_builder') throw 0;
    expect(r.replace.ui.total).toBe(hotel.amount);
    expect(r.replace.ui.split).toEqual(equalSplit(hotel.amount, 2));
    const r2 = handleAction(ctx, 's1', { action: 'update_group', ...payload(ui, { name: '  Goa   2026 <b>', memberIds: ['c_rahul'] }) }, o.messageId);
    if (r2.replace?.ui.type !== 'group_builder') throw 0;
    expect(r2.replace.ui.name).toBe('Goa 2026 b');
    expect(r2.replace.ui.members.filter((m) => m.selected)).toHaveLength(1);
  });
  it('ignores ids that were never offered (cannot smuggle in other transactions or contacts)', async () => {
    const { o, ui } = await draft();
    const other = ds.transactions.find((t: any) => t.timestamp.startsWith('2026-05') && t.direction === 'debit').id;
    const r = handleAction(ctx, 's1', { action: 'update_group', ...payload(ui, { txnIds: [other, hotel.id], memberIds: ['c_nope', 'c_rahul'] }) }, o.messageId);
    if (r.replace?.ui.type !== 'group_builder') throw 0;
    expect(selTxns(r.replace.ui)).toEqual([hotel.id]);
    expect(selMembers(r.replace.ui)).toEqual(['c_rahul']);
  });
  it('confirm commits once, is idempotent, locks the editor, and survives refresh', async () => {
    const { o, ui } = await draft();
    const p = handleAction(ctx, 's1', { action: 'propose_group', ...payload(ui) }, o.messageId);
    if (p.append?.ui.type !== 'confirm_card') throw 0;
    const pid = p.append.ui.pendingId;
    const c = handleAction(ctx, 's1', { action: 'confirm', pendingId: pid }, p.append.messageId);
    handleAction(ctx, 's1', { action: 'confirm', pendingId: pid }, p.append.messageId);   // double click
    expect(count(ctx.db, 'groups')).toBe(1);
    expect(count(ctx.db, 'group_members')).toBe(2);
    expect(count(ctx.db, 'group_transactions')).toBe(2);
    expect(c.append?.text).toContain('₹19,850');
    expect((c.also?.[0].ui as any).status).toBe('done');
    const state = loadState(ctx, 's1');
    expect((state.find((m) => m.ui?.type === 'group_builder')!.ui as any).status).toBe('done');
    expect((state.find((m) => m.ui?.type === 'confirm_card')!.ui as any).status).toBe('confirmed');
    const again = handleAction(ctx, 's1', { action: 'update_group', ...payload(ui) }, o.messageId);   // editor is locked now
    expect(again.append?.ui).toMatchObject({ type: 'notice', tone: 'error' });
  });
  it('in-progress edits survive a refresh (draft is stored in place)', async () => {
    const { o, ui } = await draft();
    handleAction(ctx, 's1', { action: 'update_group', ...payload(ui, { txnIds: [hotel.id] }) }, o.messageId);
    const b = loadState(ctx, 's1').find((m) => m.ui?.type === 'group_builder')!.ui as any;
    expect(b.total).toBe(hotel.amount);
  });
  it('re-proposing supersedes the older confirmation; another session cannot confirm', async () => {
    const { o, ui } = await draft();
    const p1 = handleAction(ctx, 's1', { action: 'propose_group', ...payload(ui) }, o.messageId);
    const p2 = handleAction(ctx, 's1', { action: 'propose_group', ...payload(ui, { txnIds: [hotel.id] }) }, o.messageId);
    if (p1.append?.ui.type !== 'confirm_card' || p2.append?.ui.type !== 'confirm_card') throw 0;
    handleAction(ctx, 's2', { action: 'confirm', pendingId: p2.append.ui.pendingId }, 1);
    expect(count(ctx.db, 'groups')).toBe(0);
    handleAction(ctx, 's1', { action: 'confirm', pendingId: p1.append.ui.pendingId }, 1);   // superseded
    expect(count(ctx.db, 'groups')).toBe(0);
    handleAction(ctx, 's1', { action: 'confirm', pendingId: p2.append.ui.pendingId }, 1);
    expect(count(ctx.db, 'groups')).toBe(1);
    expect(count(ctx.db, 'group_transactions')).toBe(1);
  });
  it('needs a name and a member; says so instead of guessing', async () => {
    const { o, ui } = await draft();
    const r = handleAction(ctx, 's1', { action: 'propose_group', ...payload(ui, { memberIds: [] }) }, o.messageId);
    expect(r.append?.ui).toMatchObject({ type: 'notice', tone: 'error' });
    const u = await handleChat(ctx, 's1', 'Make a Goa trip group with Rahul and Zorro and add yesterday\'s hotel');
    if (u.ui.type !== 'group_builder') throw 0;
    expect(u.ui.notes.join(' ')).toContain('Zorro');
    expect(u.ui.members.filter((m) => m.selected)).toHaveLength(1);
  });
});

async function makeGroup() {
  const { o, ui } = await draft();
  const p = handleAction(ctx, 's1', { action: 'propose_group', ...payload(ui) }, o.messageId);
  if (p.append?.ui.type !== 'confirm_card') throw 0;
  handleAction(ctx, 's1', { action: 'confirm', pendingId: p.append.ui.pendingId }, p.append.messageId);
}

describe('scenario 5: ambiguous "add the Swiggy ones"', () => {
  it('asks instead of guessing: nothing preselected, all Swiggy merchants offered', async () => {
    await makeGroup();
    const o = await handleChat(ctx, 's1', 'Add the Swiggy ones to the group.');
    if (o.ui.type !== 'choice_picker') throw new Error(o.ui.type);
    const swiggy = ds.transactions.filter((t: any) => t.merchant?.startsWith('Swiggy') && t.direction === 'debit' && t.timestamp.slice(0, 10) >= '2026-10-24');
    expect(o.ui.options.length).toBeGreaterThan(3);
    expect(o.ui.options.every((x) => !x.selected)).toBe(true);
    expect(new Set(o.ui.options.map((x) => x.label)).size).toBeGreaterThanOrEqual(3);
    expect(o.ui.options.length).toBeLessThanOrEqual(swiggy.length);
    expect(o.ui.group.name).toBe('Goa trip');
    expect(count(ctx.db, 'group_transactions')).toBe(2);               // unchanged
  });
  it('requires a choice, then confirm, then writes only the chosen ones', async () => {
    await makeGroup();
    const o = await handleChat(ctx, 's1', 'Add the Swiggy ones to the group.');
    if (o.ui.type !== 'choice_picker') throw 0;
    const none = handleAction(ctx, 's1', { action: 'submit_choice', ids: [] }, o.messageId);
    expect(none.append?.ui).toMatchObject({ type: 'notice', tone: 'error' });
    const chosen = o.ui.options.slice(0, 2), want = chosen.reduce((s, x) => s + x.amount, 0);
    const up = handleAction(ctx, 's1', { action: 'update_choice', ids: chosen.map((c) => c.id) }, o.messageId);
    if (up.replace?.ui.type !== 'choice_picker') throw 0;
    expect(up.replace.ui.selectedCount).toBe(2);
    expect(up.replace.ui.selectedTotal).toBeCloseTo(want, 2);
    const sub = handleAction(ctx, 's1', { action: 'submit_choice', ids: chosen.map((c) => c.id) }, o.messageId);
    if (sub.append?.ui.type !== 'confirm_card') throw 0;
    expect(count(ctx.db, 'group_transactions')).toBe(2);               // proposing writes nothing
    const c = handleAction(ctx, 's1', { action: 'confirm', pendingId: sub.append.ui.pendingId }, sub.append.messageId);
    expect(count(ctx.db, 'group_transactions')).toBe(4);
    expect((c.also?.[0].ui as any).status).toBe('done');
    const again = await handleChat(ctx, 's1', 'Add the Swiggy ones to the group.');   // already-added rows are not offered twice
    if (again.ui.type !== 'choice_picker') throw 0;
    expect(again.ui.options.length).toBe(o.ui.options.length - 2);
  });
  it('a single match goes straight to confirmation; no match and no group are explained', async () => {
    await makeGroup();
    const one = await handleChat(ctx, 's1', 'Add the Delhi Metro ones to the group yesterday');
    expect(one.ui.type).toBe('confirm_card');
    const none = await handleChat(ctx, 's1', 'Add the Zomatoooo ones to the group');
    expect(none.ui.type).toBe('notice');
  });
  it('with no group yet, it says so instead of inventing one', async () => {
    const noGroup = await handleChat(ctx, 's1', 'Add the Swiggy ones to the group.');
    expect(noGroup.ui).toMatchObject({ type: 'notice' });
    expect(noGroup.text).toContain("don't have a group");
  });
  it('with an unconfirmed draft only, it asks the user to finish that first', async () => {
    await draft();
    expect((await handleChat(ctx, 's1', 'Add the Swiggy ones to the group.')).text).toContain('Finish creating your group');
  });
});

describe('scenario 4: ₹80k phone by March', () => {
  // oracle: avg of Aug-Oct from dataset income and the independent ground-truth spend
  const incomeAvg = ds.transactions.filter((t: any) => t.category === 'Income' && t.timestamp >= '2026-08' && t.timestamp < '2026-11').reduce((s: number, t: any) => s + t.amount, 0) / 3;
  const spendAvg = ['2026-08', '2026-09', '2026-10'].reduce((s, m) => s + Object.values(truth[m]).reduce((a, b) => a + b, 0), 0) / 3;
  it('projection numbers match an independent calculation', async () => {
    const o = await handleChat(ctx, 's1', 'Can I afford an ₹80k phone by March?');
    if (o.ui.type !== 'savings_plan') throw new Error(o.ui.type);
    expect(o.ui.price).toBe(80000);
    expect(o.ui.item).toBe('Phone');
    expect(o.ui.targetMonth).toBe('2027-03');
    expect(o.ui.monthsLeft).toBe(4);
    expect(o.ui.requiredMonthly).toBe(20000);
    expect(Math.abs(o.ui.avgSurplus - (incomeAvg - spendAvg))).toBeLessThan(0.02);
    expect(o.ui.projected).toBe(o.ui.monthly * 4);
    expect(o.ui.shortfall).toBe(80000 - o.ui.projected);
    expect(o.ui.verdict).toBe('short');
    expect(o.ui.series).toHaveLength(4);
    expect(o.ui.series[3].saved).toBe(o.ui.projected);
    expect(o.text).toContain('₹20,000');
  });
  it('changing the amount or the date updates the result server-side', async () => {
    const o = await handleChat(ctx, 's1', 'Can I afford an ₹80k phone by March?');
    if (o.ui.type !== 'savings_plan') throw 0;
    const a = handleAction(ctx, 's1', { action: 'adjust_plan', targetMonth: '2027-03', monthly: 20000 }, o.messageId);
    if (a.replace?.ui.type !== 'savings_plan') throw 0;
    expect(a.replace.ui.verdict).toBe('stretch');                       // enough, but above usual surplus
    expect(a.replace.ui.shortfall).toBe(0);
    const b = handleAction(ctx, 's1', { action: 'adjust_plan', targetMonth: '2027-06', monthly: 13000 }, o.messageId);
    if (b.replace?.ui.type !== 'savings_plan') throw 0;
    expect(b.replace.ui.monthsLeft).toBe(7);
    expect(b.replace.ui.verdict).toBe('on_track');
    expect(b.replace.ui.projected).toBe(91000);
  });
  it('clamps hostile input and rejects dates that are past or too far away', async () => {
    const o = await handleChat(ctx, 's1', 'Can I afford an ₹80k phone by March?');
    if (o.ui.type !== 'savings_plan') throw 0;
    const hi = handleAction(ctx, 's1', { action: 'adjust_plan', targetMonth: '2027-03', monthly: 9e9 }, o.messageId);
    if (hi.replace?.ui.type !== 'savings_plan') throw 0;
    expect(hi.replace.ui.monthly).toBe(hi.replace.ui.max);
    const neg = handleAction(ctx, 's1', { action: 'adjust_plan', targetMonth: '2027-03', monthly: -5 }, o.messageId);
    expect((neg.replace?.ui as any).monthly).toBe(0);
    expect((neg.replace?.ui as any).reachedLabel).toBeNull();
    const past = handleAction(ctx, 's1', { action: 'adjust_plan', targetMonth: '2026-10', monthly: 1000 }, o.messageId);
    expect(past.append?.ui).toMatchObject({ type: 'notice', tone: 'error' });
    expect(past.replace).toBeUndefined();                              // the live editor is not destroyed by an error
    const far = handleAction(ctx, 's1', { action: 'adjust_plan', targetMonth: '2031-01', monthly: 1000 }, o.messageId);
    expect(far.append?.ui).toMatchObject({ type: 'notice', tone: 'error' });
    const ok = handleAction(ctx, 's1', { action: 'adjust_plan', targetMonth: '2027-03', monthly: 1000 }, o.messageId);
    expect(ok.replace?.ui.type).toBe('savings_plan');                  // still editable afterwards
  });
  it('saving the goal needs explicit confirmation and then writes exactly one row', async () => {
    const o = await handleChat(ctx, 's1', 'Can I afford an ₹80k phone by March?');
    if (o.ui.type !== 'savings_plan') throw 0;
    const p = handleAction(ctx, 's1', { action: 'propose_goal', targetMonth: '2027-06', monthly: 13000 }, o.messageId);
    if (p.append?.ui.type !== 'confirm_card') throw 0;
    expect(count(ctx.db, 'goals')).toBe(0);
    handleAction(ctx, 's1', { action: 'confirm', pendingId: p.append.ui.pendingId }, p.append.messageId);
    expect(count(ctx.db, 'goals')).toBe(1);
    expect(ctx.db.prepare('SELECT price, target_month AS t, monthly_saving AS m FROM goals').get()).toMatchObject({ price: 80000, t: '2027-06', m: 13000 });
    expect((loadState(ctx, 's1').find((m) => m.ui?.type === 'savings_plan')!.ui as any).status).toBe('done');
  });
  it('asks when the price or date is missing instead of inventing one', async () => {
    expect((await handleChat(ctx, 's1', 'Can I afford a new phone by March?')).ui.type).toBe('notice');
    expect((await handleChat(ctx, 's1', 'Can I afford an ₹80k phone?')).ui.type).toBe('notice');
  });
});

describe('scenario 6: investment advice', () => {
  it('declines politely, gives data-backed facts, writes nothing', async () => {
    const o = await handleChat(ctx, 's1', 'Which stock should I buy?');
    if (o.ui.type !== 'info_card') throw 0;
    expect(o.text).toContain("can't tell you which stock");
    expect(o.ui.facts).toHaveLength(2);
    expect(o.ui.facts[0].value).toBe('₹13,041.71');
    expect(o.ui.facts[1].value).toBe('₹4,31,749.74');                   // 6 x the 3-month average spend, Indian digit grouping
    expect(o.ui.actions.length).toBeGreaterThan(0);
    for (const t of ['groups', 'budgets', 'goals', 'pending_actions']) expect(count(ctx.db, t)).toBe(0);
  });
  it('the suggested follow-up button works as a structured action', async () => {
    const o = await handleChat(ctx, 's1', 'Which stock should I buy?');
    const r = handleAction(ctx, 's1', { action: 'quick_ask', ask: 'spending_last_month' }, o.messageId);
    expect(r.append?.ui.type).toBe('spending_breakdown');
  });
});
