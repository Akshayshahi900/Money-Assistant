import type { DatabaseSync } from 'node:sqlite';
import { Ctx, ToolResult, showSpendingBreakdown, drillDown, budgetPlan, proposeBudget, resolvePending, confirmCardFor, categories, notice } from './tools';
import { createGroupDraft, rebuildGroup, proposeGroup, addToGroup, updateChoice, submitChoice, groupText } from './groups';
import { planPurchase, rebuildPlan, proposeGoal } from './plan';
import { investmentNote } from './advice';
import { guardText } from './grounding';
import { route } from './router';
import { safeSpec, ActionPayload, UiSpec } from './ui/spec';

const UNSUPPORTED = 'I can show where your money went, suggest budgets, set up trip groups, plan a purchase, and explain what I can\'t advise on. Try "Where did my money go last month?", "I want to spend less on food", "Make a Goa trip group with Rahul and Priya", or "Can I afford an ₹80k phone by March?"';
const now = () => new Date().toISOString();

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
function ready(r: ToolResult): ToolResult { const ui = safeSpec(r.ui); return { text: guardText(r.text, ui), ui }; }

export interface ChatOutcome { text: string; ui: UiSpec; messageId: number; via: string; usage?: { in: number; out: number } }

export async function handleChat(ctx: Ctx, sid: string, message: string): Promise<ChatOutcome> {
  saveMessage(ctx.db, sid, 'user', message, null);
  const r = await route(message, { today: ctx.today, categories: categories(ctx.db) });
  let out: ToolResult;
  switch (r.route.tool) {
    case 'show_spending_breakdown': out = showSpendingBreakdown(ctx, r.route.args.period); break;
    case 'suggest_budget': out = budgetPlan(ctx, r.route.args.category); break;
    case 'create_group': out = createGroupDraft(ctx, r.route.args); break;
    case 'add_to_group': out = addToGroup(ctx, sid, r.route.args); break;
    case 'plan_purchase': out = planPurchase(ctx, r.route.args); break;
    case 'investment_question': out = investmentNote(ctx); break;
    default: out = notice(UNSUPPORTED);
  }
  const { text, ui } = ready(out);
  const messageId = saveMessage(ctx.db, sid, 'assistant', text, ui);
  return { text, ui, messageId, via: r.via, usage: r.usage };
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
      return { append: append(drillDown(ctx, a.category, { from: a.from, to: a.to, label: a.label })) };
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
      return update(messageId, rebuildPlan(ctx, prev, a), 'savings_plan');
    }
    case 'propose_goal': {
      if (prev?.type !== 'savings_plan' || prev.status !== 'editing') return bad('That plan is no longer editable.');
      const r = rebuildPlan(ctx, prev, a);
      if (r.ui.type !== 'savings_plan') return { append: append(r) };
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
