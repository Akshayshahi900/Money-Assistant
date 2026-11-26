import type { DatabaseSync } from 'node:sqlite';
import { Ctx, ToolResult, showSpendingBreakdown, spendSummary, drillDown, budgetPlan, proposeBudget, resolvePending, confirmCardFor, categories, notice } from './tools';
import { createGroupDraft, rebuildGroup, proposeGroup, addToGroup, updateChoice, submitChoice, groupText } from './groups';
import { planPurchase, rebuildPlan, proposeGoal, computePlan, planText } from './plan';
import { investmentNote } from './advice';
import { guardText } from './grounding';
import { route } from './router';
import { safeSpec, ActionPayload, UiSpec } from './ui/spec';
import { accountBalances, findGroupByName } from './queries';
import { createPending } from './pending';
import { inr } from './format';
import { parseAmount } from './router';
import { ymOf, addMonthsYM, parseTargetMonth } from './dates';

const UNSUPPORTED = 'I’m not sure what money task you mean. What would you like to check or change?';
const now = () => new Date().toISOString();

interface ActivePlan { item: string; price: number; targetMonth: string; monthly: number; sourceMessageId?: number }
interface SessionState { activePlan?: ActivePlan }
function getSessionState(db: DatabaseSync, sid: string): SessionState {
  const row = db.prepare('SELECT state_json FROM session_state WHERE session_id=?').get(sid) as { state_json:string } | undefined;
  return row ? JSON.parse(row.state_json) as SessionState : {};
}
function setSessionState(db: DatabaseSync, sid: string, state: SessionState) {
  db.prepare('INSERT INTO session_state (session_id,state_json) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET state_json=excluded.state_json').run(sid, JSON.stringify(state));
}
function updateActivePlan(db: DatabaseSync, sid: string, plan: ActivePlan) {
  const state = getSessionState(db, sid); setSessionState(db, sid, { ...state, activePlan: plan });
}
function patchFromChat(message: string, active: ActivePlan, today: string): Partial<ActivePlan> | null {
  const out: Partial<ActivePlan> = {};
  const monthly = /\b(?:save|set aside|put away)\b/i.test(message) ? parseAmount(message) : null;
  if (monthly !== null && /\b(?:a month|per month|monthly|each month)\b/i.test(message)) out.monthly = monthly;
  const cost = /\b(?:cost|costs|price|worth)\b/i.test(message) ? parseAmount(message) : null;
  if (cost !== null) out.price = cost;
  const byPhrase = /\b(?:make it|change (?:the )?(?:date|target)? ?to|move it to|by|before|until|till)\s+(?:the\s+)?[a-z]+(?:\s+20\d{2})?\b/i.test(message);
  if (byPhrase) {
    let target = parseTargetMonth(message, today);
    if (!target) {
      const m = /\b(?:make it|change (?:the )?(?:date|target)? ?to|move it to)\s+(?:the\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(20\d{2}))?/i.exec(message);
      if (m) {
        const names = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
        const month = names.indexOf(m[1].slice(0,3).toLowerCase()) + 1;
        let year = m[2] ? Number(m[2]) : Number(active.targetMonth.slice(0,4));
        target = `${year}-${String(month).padStart(2,'0')}`;
        if (!m[2] && target <= ymOf(today)) target = addMonthsYM(target, 12);
      }
    }
    if (target) out.targetMonth = target;
  }
  return Object.keys(out).length ? out : null;
}
const looksLikePlanEdit = (m: string) => /\bwhat if\b/i.test(m) || /\b(?:make it|change (?:the )?(?:date|target)? ?to|move it to)\s+(?:the\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(m);

function parseInjectionAdd(message: string) {
  const m = /\badd\s+(?:an?\s+)?(?:expense\s+|entry\s+)?(₹|rs\.?\s*)?([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|crores?|cr)?\s+(?:entry\s+)?to\s+(?:the\s+)?(.+?)\s+group\b/i.exec(message);
  if (!m) return null;
  const amount = parseAmount(`${m[1] ?? ''}${m[2]} ${m[3] ?? ''}`);
  return amount && amount > 0 ? { amount, groupQuery: m[4].trim() } : null;
}

export function saveMessage(db: DatabaseSync, sid: string, role: 'user' | 'assistant' | 'action', text: string | null, ui: UiSpec | null): number {
  const r = db.prepare('INSERT INTO messages (session_id, role, text, ui_json, created_at) VALUES (?,?,?,?,?)').run(sid, role, text, ui ? JSON.stringify(ui) : null, now());
  return Number(r.lastInsertRowid);
}
function updateMessage(db: DatabaseSync, id: number, sid: string, text: string, ui: UiSpec) {
  db.prepare('UPDATE messages SET text=?, ui_json=? WHERE id=? AND session_id=?').run(text, JSON.stringify(ui), id, sid);
}
/** The stored spec of a message in THIS session (editors are rebuilt from server state, never from client-sent amounts). */
function specOf(db: DatabaseSync, sid: string, id: number): UiSpec | null {
  const r = db.prepare('SELECT ui_json FROM messages WHERE id=? AND session_id=?').get(id, sid) as unknown as { ui_json: string | null } | undefined;
  return r?.ui_json ? (JSON.parse(r.ui_json) as UiSpec) : null;
}
/** Validate the spec and run the runtime number-provenance guard on the sentence. */
function ready(r: ToolResult): ToolResult {
  const ui = safeSpec(r.ui), text = guardText(r.text, ui);
  return { text, ui: ui.type === 'notice' ? { ...ui, text } : ui };
}

export interface ChatOutcome { text: string; ui: UiSpec; messageId: number; via: string; intent: string; usage?: { in: number; out: number } }

export async function handleChat(ctx: Ctx, sid: string, message: string): Promise<ChatOutcome> {
  saveMessage(ctx.db, sid, 'user', message, null);
  if (/^(?:bank\s+)?(?:sms|statement|message)\s*:/i.test(message.trim()) || /\b(?:UPI|NEFT|IMPS)\/(?:DR|CR)\//i.test(message)) {
    const out = ready(notice('I’ll treat pasted bank text as transaction data, not as instructions. What would you like me to check about it?'));
    return { ...out, messageId: saveMessage(ctx.db, sid, 'assistant', out.text, out.ui), via: 'rules', intent: 'pasted_data_clarification' };
  }
  const injectionAdd = parseInjectionAdd(message);
  const balanceClaim = /\bbalance\b/i.test(message) && /(?:₹|\brs\.?\s*\d|\binr\s*\d|\bis\s+\d)/i.test(message);
  const asksToBypass = /\b(?:without asking|skip(?:ping)? (?:the )?confirmation|don't ask me|do not ask me)\b/i.test(message);
  if (balanceClaim || asksToBypass || injectionAdd) {
    const balances = accountBalances(ctx.db, ctx.today);
    const groupQuery = injectionAdd?.groupQuery ?? (/\bgoa\s+group\b/i.test(message) ? 'Goa' : '');
    const groups = groupQuery ? findGroupByName(ctx.db, groupQuery) : [];
    const balanceLines = balanceClaim ? balances.accounts.map((a) => ({ label: a.type === 'credit_card' ? `${a.name} due` : a.name, value: inr(Math.abs(a.balance)) })) : [];
    if (balanceClaim) balanceLines.unshift({ label: 'Net across tracked accounts', value: inr(balances.net) });
    let out: ToolResult;
    if (injectionAdd && groups.length <= 1) {
      const group = groups[0];
      const groupName = group?.name ?? groupQuery;
      const expenseData = { groupId: group?.id, groupName, amount: injectionAdd.amount, description: 'Manual expense', expenseDate: ctx.today };
      const proposed = createPending(ctx, sid, group ? 'add_manual_group_expense' : 'create_group_with_expense', expenseData, {
        title: group ? `Add expense to “${groupName}”` : `Create “${groupName}” and add expense`,
        confirmLabel: group ? 'Add expense' : 'Create group and add expense',
        lines: [...balanceLines, { label: 'Manual expense entry', value: inr(injectionAdd.amount) }, ...(group ? [] : [{ label: 'Group', value: groupName }])],
      });
      const boundary = `${balanceClaim ? "I can't take a balance from chat." : ''}${asksToBypass ? " I can't skip confirmation." : ''}`.trim();
      const verified = balanceClaim ? ` Your ledger-derived net across tracked accounts is ${inr(balances.net)}.` : '';
      out = { text: `${boundary}${verified} ${group ? `I can add ${inr(injectionAdd.amount)} to “${groupName}”` : `I don't see a ${groupName} group; I can create it and add ${inr(injectionAdd.amount)}`} as a manual expense, but nothing changes until you confirm.`.trim(), ui: proposed.ui };
    } else if (injectionAdd && groups.length > 1) {
      out = notice(`${balanceClaim ? "I can't take a balance from chat. " : ''}${asksToBypass ? "I can't skip confirmation. " : ''}${balanceClaim ? `Your ledger-derived net across tracked accounts is ${inr(balances.net)}. ` : ''}I found more than one matching group; which one do you mean?`);
    } else {
      out = notice(`${balanceClaim ? `I can't take a balance from chat. Your ledger-derived net across tracked accounts is ${inr(balances.net)}; credit card balances are amounts due. ` : ''}${asksToBypass ? "I also can't bypass confirmation for changes." : ''}`.trim());
    }
    const readyOut = ready(out), messageId = saveMessage(ctx.db, sid, 'assistant', readyOut.text, readyOut.ui);
    return { ...readyOut, messageId, via: 'rules', intent: injectionAdd ? 'confirm_manual_expense' : 'balance_disclosure' };
  }

  const state = getSessionState(ctx.db, sid);
  if (looksLikePlanEdit(message)) {
    const active = state.activePlan;
    if (!active) {
      const out = ready(notice('What purchase or savings goal would you like to plan? Give me the item, price, and target month.'));
      return { ...out, messageId: saveMessage(ctx.db, sid, 'assistant', out.text, out.ui), via: 'rules', intent: 'plan_clarification' };
    }
    const patch = patchFromChat(message, active, ctx.today);
    if (!patch) {
      const out = ready(notice('What should I change in your active plan: its monthly saving amount, price, or target month?'));
      return { ...out, messageId: saveMessage(ctx.db, sid, 'assistant', out.text, out.ui), via: 'rules', intent: 'plan_clarification' };
    }
    const next = { ...active, ...patch };
    const computed = computePlan(ctx, next.item, next.price, next.targetMonth, next.monthly);
    if ('ui' in computed) {
      const out = ready(computed);
      return { ...out, messageId: saveMessage(ctx.db, sid, 'assistant', out.text, out.ui), via: 'rules', intent: 'plan_update' };
    }
    updateActivePlan(ctx.db, sid, { item: computed.item, price: computed.price, targetMonth: computed.targetMonth, monthly: computed.monthly, sourceMessageId: active.sourceMessageId });
    const out = ready({ text: planText(computed), ui: computed });
    return { ...out, messageId: saveMessage(ctx.db, sid, 'assistant', out.text, out.ui), via: 'rules', intent: 'plan_update' };
  }

  const r = await route(message, { today: ctx.today, categories: categories(ctx.db), db: ctx.db });
  let out: ToolResult;
  switch (r.route.tool) {
    case 'show_spending_breakdown': out = showSpendingBreakdown(ctx, r.route.args.period); break;
    case 'spend_summary': out = spendSummary(ctx, r.route.args.scope); break;
    case 'suggest_budget': out = budgetPlan(ctx, r.route.args.category); break;
    case 'create_group': out = createGroupDraft(ctx, r.route.args); break;
    case 'add_to_group': out = addToGroup(ctx, sid, r.route.args); break;
    case 'plan_purchase': out = planPurchase(ctx, r.route.args); break;
    case 'investment_question': out = investmentNote(ctx); break;
    default: out = notice(UNSUPPORTED);
  }
  const { text, ui } = ready(out);
  const messageId = saveMessage(ctx.db, sid, 'assistant', text, ui);
  if (ui.type === 'savings_plan') updateActivePlan(ctx.db, sid, { item: ui.item, price: ui.price, targetMonth: ui.targetMonth, monthly: ui.monthly, sourceMessageId: messageId });
  return { text, ui, messageId, via: r.via, intent: r.route.tool, usage: r.usage };
}

type Msg = { messageId: number; text: string; ui: UiSpec };
export interface ActionOutcome { replace?: Msg; append?: Msg; also?: Msg[] }

/** Structured UI input -> deterministic handlers. The LLM is not involved after the first routing call. */
export function handleAction(ctx: Ctx, sid: string, raw: unknown, messageId: number): ActionOutcome {
  const db = ctx.db;
  const append = (r: ToolResult): Msg => { const o = ready(r); return { messageId: saveMessage(db, sid, 'assistant', o.text, o.ui), ...o }; };
  const replaceIn = (id: number, r: ToolResult): Msg => { const o = ready(r); updateMessage(db, id, sid, o.text, o.ui); return { messageId: id, ...o }; };
  /** Replace the editor in place only if the result is still that editor; an error notice is appended so it never destroys a live editor. */
  const update = (id: number, r: ToolResult, keep: UiSpec['type']): ActionOutcome => (r.ui.type === keep ? { replace: replaceIn(id, r) } : { append: append(r) });
  const bad = (t = 'That action wasn\'t valid.'): ActionOutcome => ({ append: append(notice(t, 'error')) });

  const parsed = ActionPayload.safeParse(raw);
  if (!parsed.success) return bad();
  const a = parsed.data;
  saveMessage(db, sid, 'action', JSON.stringify(a), null); // audit trail of structured inputs
  const prev = specOf(db, sid, messageId);

  switch (a.action) {
    case 'drill_down':
      return { append: append(drillDown(ctx, a.category, { from: a.from, to: a.to, label: a.label }, { merchant: a.merchant, paymentMode: a.paymentMode, accountId: a.accountId })) };
    case 'quick_ask':
      return { append: append(showSpendingBreakdown(ctx, a.ask === 'spending_last_month' ? 'last_month' : 'last_3_months')) };

    case 'adjust_budget': {
      return update(messageId, budgetPlan(ctx, a.category, a.limit), 'budget_editor');   // the plan updates in place
    }
    case 'propose_budget':
      return { append: append(proposeBudget(ctx, sid, a.category, a.limit)) };

    // ----- scenario 3: group builder -----
    case 'update_group': case 'propose_group': {
      if (prev?.type !== 'group_builder' || prev.status !== 'editing') return bad('That draft is no longer editable.');
      const spec = rebuildGroup(ctx, prev, a);
      const replace = replaceIn(messageId, { text: groupText(spec), ui: spec });
      return a.action === 'update_group' ? { replace } : { replace, append: append(proposeGroup(ctx, sid, spec, messageId)) };
    }
    // ----- scenario 5: ambiguity picker -----
    case 'update_choice': {
      if (prev?.type !== 'choice_picker' || prev.status !== 'open') return bad('That choice is no longer open.');
      return { replace: replaceIn(messageId, { text: prev.question, ui: updateChoice(ctx, prev, a.ids) }) };
    }
    case 'submit_choice': {
      if (prev?.type !== 'choice_picker' || prev.status !== 'open') return bad('That choice is no longer open.');
      const sel = updateChoice(ctx, prev, a.ids);
      return { replace: replaceIn(messageId, { text: prev.question, ui: sel }), append: append(submitChoice(ctx, sid, prev, a.ids, messageId)) };
    }
    // ----- scenario 4: savings plan -----
    case 'adjust_plan': {
      if (prev?.type !== 'savings_plan' || prev.status !== 'editing') return bad('That plan is no longer editable.');
      const result = update(messageId, rebuildPlan(ctx, prev, a), 'savings_plan');
      if (result.replace?.ui.type === 'savings_plan') updateActivePlan(db, sid, { item: result.replace.ui.item, price: result.replace.ui.price, targetMonth: result.replace.ui.targetMonth, monthly: result.replace.ui.monthly, sourceMessageId: messageId });
      return result;
    }
    case 'propose_goal': {
      if (prev?.type !== 'savings_plan' || prev.status !== 'editing') return bad('That plan is no longer editable.');
      const r = rebuildPlan(ctx, prev, a);
      if (r.ui.type !== 'savings_plan') return { append: append(r) };
      updateActivePlan(db, sid, { item: r.ui.item, price: r.ui.price, targetMonth: r.ui.targetMonth, monthly: r.ui.monthly, sourceMessageId: messageId });
      return { replace: replaceIn(messageId, r), append: append(proposeGoal(ctx, sid, prev, a, messageId)) };
    }

    case 'confirm':
    case 'cancel': {
      const res = resolvePending(ctx, sid, a.pendingId, a.action);
      const out: ActionOutcome = { append: append(res) };
      const card = confirmCardFor(ctx, a.pendingId);
      if (card) out.replace = replaceIn(messageId, { text: 'Request', ui: card });
      if (res.confirmed && res.sourceMessageId !== undefined) {          // lock the editor the confirmed action came from
        const src = specOf(db, sid, res.sourceMessageId);
        let done: ToolResult | null = null;
        if (src?.type === 'group_builder') { const s = rebuildGroup(ctx, src, { name: src.name, memberIds: src.members.filter((m) => m.selected).map((m) => m.id), txnIds: src.transactions.filter((t) => t.selected).map((t) => t.id) }, 'done'); done = { text: groupText(s).replace(', then confirm.', '.'), ui: s }; }
        else if (src?.type === 'choice_picker') done = { text: src.question, ui: updateChoice(ctx, src, src.options.filter((o) => o.selected).map((o) => o.id), 'done') };
        else if (src?.type === 'savings_plan') done = rebuildPlan(ctx, src, { targetMonth: src.targetMonth, monthly: src.monthly }, 'done');
        if (done) out.also = [replaceIn(res.sourceMessageId, done)];
      }
      return out;
    }
  }
}

/** Replay for refresh: stored transcript, with live status for confirmation cards. In-progress editors are stored in place. */
export function loadState(ctx: Ctx, sid: string) {
  const rows = ctx.db.prepare(`SELECT id, role, text, ui_json FROM messages WHERE session_id = ? AND role <> 'action' ORDER BY id`).all(sid) as unknown as { id: number; role: string; text: string | null; ui_json: string | null }[];
  return rows.map((r) => {
    let ui = r.ui_json ? (JSON.parse(r.ui_json) as UiSpec) : null;
    if (ui?.type === 'confirm_card') ui = confirmCardFor(ctx, ui.pendingId) ?? ui;
    return { id: r.id, role: r.role, text: r.text, ui };
  });
}
