/**
 * Human-in-the-loop write path. A tool may only PROPOSE: it stores a draft in pending_actions and returns a
 * confirm card. Data is written ONLY here, in resolvePending(), when the user's explicit confirm action arrives.
 * Each kind has one applier; all run in a transaction and are idempotent (second confirm = no-op).
 */
import { randomUUID } from "node:crypto";
import { Ctx, ToolResult, notice, joinNames } from "./common";
import { inr } from "./format";
import { txnsByIds } from "./queries";
import { round2 } from "./queries";
import type { UiSpec } from "./ui/spec";

export type PendingKind = "create_budget" | "create_group" | "add_to_group" | "create_goal" | "add_manual_group_expense" | "create_group_with_expense";
export interface Card { title: string; confirmLabel: string; lines: { label: string; value: string }[] }
interface Draft { data: any; card: Card; sourceMessageId?: number }

export function createPending(ctx: Ctx, sid: string, kind: PendingKind, data: unknown, card: Card, sourceMessageId?: number): ToolResult {
  const id = randomUUID();
  if (sourceMessageId !== undefined)   // re-proposing from the same editor supersedes the earlier proposal
    ctx.db.prepare(`UPDATE pending_actions SET status='cancelled' WHERE session_id=? AND kind=? AND status='proposed' AND json_extract(draft_json,'$.sourceMessageId') = ?`).run(sid, kind, sourceMessageId);
  const draft: Draft = { data, card, sourceMessageId };
  ctx.db.prepare(`INSERT INTO pending_actions (id, session_id, kind, draft_json, status, created_at) VALUES (?,?,?,?, 'proposed', ?)`)
    .run(id, sid, kind, JSON.stringify(draft), new Date().toISOString());
  return { text: "Please confirm: nothing is saved until you do.", ui: cardSpec(id, card, "proposed") };
}

const cardSpec = (pendingId: string, c: Card, status: "proposed" | "confirmed" | "cancelled"): UiSpec =>
  ({ type: "confirm_card", pendingId, title: c.title, lines: c.lines, status, confirmLabel: c.confirmLabel });

function readDraft(json: string): Draft {
  const d = JSON.parse(json);
  if (d.card) return d;
  // legacy budget drafts (stored before generic cards existed)
  return { data: d, card: { title: "Set monthly budget", confirmLabel: "Save budget", lines: [
    { label: "Category", value: d.category }, { label: "Monthly limit", value: inr(d.limit) },
    { label: "3-month average", value: inr(d.average) }, { label: "Saves per month", value: inr(d.savingsPerMonth) }] } };
}

/** Live card for a pending action (status from the DB, so a refresh always shows the truth). */
export function confirmCardFor(ctx: Ctx, pendingId: string): UiSpec | null {
  const row = ctx.db.prepare("SELECT draft_json, status FROM pending_actions WHERE id = ?").get(pendingId) as unknown as { draft_json: string; status: "proposed" | "confirmed" | "cancelled" } | undefined;
  return row ? cardSpec(pendingId, readDraft(row.draft_json).card, row.status) : null;
}

type Applier = (ctx: Ctx, d: any) => string;
const APPLY: Record<PendingKind, Applier> = {
  create_budget(ctx, d) {
    ctx.db.prepare("DELETE FROM budgets WHERE category = ?").run(d.category);
    ctx.db.prepare("INSERT INTO budgets (id, category, monthly_limit, created_at) VALUES (?,?,?,?)").run(randomUUID(), d.category, d.limit, new Date().toISOString());
    return `Done. Your monthly ${d.category} budget is now ${inr(d.limit)}.`;
  },
  create_group(ctx, d) {
    // re-validate at commit time: ids must still exist; amounts are re-read from the DB
    const members = (d.memberIds as string[]).map((id) => ctx.db.prepare("SELECT id, name FROM contacts WHERE id=?").get(id) as unknown as { id: string; name: string } | undefined).filter(Boolean) as { id: string; name: string }[];
    if (!members.length) throw new Error("no valid members");
    const txns = txnsByIds(ctx.db, d.txnIds);
    const gid = randomUUID(), now = new Date().toISOString();
    ctx.db.prepare("INSERT INTO groups (id, name, created_at) VALUES (?,?,?)").run(gid, d.name, now);
    for (const m of members) ctx.db.prepare("INSERT INTO group_members VALUES (?,?)").run(gid, m.id);
    for (const t of txns) ctx.db.prepare("INSERT INTO group_transactions VALUES (?,?)").run(gid, t.id);
    const total = round2(txns.reduce((s, t) => s + t.net_amount, 0));
    return `Done. “${d.name}” now has ${joinNames(members.map((m) => m.name))} and ${txns.length} transaction${txns.length === 1 ? "" : "s"} totalling ${inr(total)}.`;
  },
  add_to_group(ctx, d) {
    const g = ctx.db.prepare("SELECT id, name FROM groups WHERE id=?").get(d.groupId) as unknown as { id: string; name: string } | undefined;
    if (!g) throw new Error("group missing");
    const txns = txnsByIds(ctx.db, d.txnIds);
    let added = 0, addedTotal = 0;
    for (const t of txns) {
      const r = ctx.db.prepare("INSERT OR IGNORE INTO group_transactions VALUES (?,?)").run(g.id, t.id);
      if (Number(r.changes)) { added++; addedTotal += t.net_amount; }
    }
    return added === 0 ? `Those were already in “${g.name}”, so nothing changed.`
      : `Done. Added ${added} transaction${added === 1 ? "" : "s"} (${inr(round2(addedTotal))}) to “${g.name}”.`;
  },
  create_goal(ctx, d) {
    ctx.db.prepare("INSERT INTO goals (id, item, price, target_month, monthly_saving, created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), d.item, d.price, d.targetMonth, d.monthly, new Date().toISOString());
    return `Done. Saved your goal: ${inr(d.price)} for ${d.item.toLowerCase()} by ${d.targetLabel}, setting aside ${inr(d.monthly)} a month.`;
  },
  add_manual_group_expense(ctx, d) {
    const id = randomUUID();
    ctx.db.prepare('INSERT INTO group_manual_expenses (id,group_id,amount,description,expense_date,created_at) VALUES (?,?,?,?,?,?)').run(id,d.groupId,d.amount,d.description,d.expenseDate,new Date().toISOString());
    return `Done. Added ${inr(d.amount)} to “${d.groupName}” as ${d.description.toLowerCase()}.`;
  },
  create_group_with_expense(ctx, d) {
    const id = randomUUID(), now = new Date().toISOString();
    ctx.db.prepare('INSERT INTO groups (id,name,created_at) VALUES (?,?,?)').run(id,d.groupName,now);
    ctx.db.prepare('INSERT INTO group_manual_expenses (id,group_id,amount,description,expense_date,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(),id,d.amount,d.description,d.expenseDate,now);
    return `Done. Created “${d.groupName}” and added ${inr(d.amount)} as ${d.description.toLowerCase()}.`;
  },
};

export interface Resolution extends ToolResult { kind?: PendingKind; sourceMessageId?: number; confirmed?: boolean }

/** The ONLY function that writes assistant data. Idempotent and session-scoped. */
export function resolvePending(ctx: Ctx, sid: string, pendingId: string, decision: "confirm" | "cancel"): Resolution {
  const row = ctx.db.prepare("SELECT draft_json, status, session_id, kind FROM pending_actions WHERE id = ?").get(pendingId) as unknown as { draft_json: string; status: string; session_id: string; kind: PendingKind } | undefined;
  if (!row || row.session_id !== sid) return notice("That request no longer exists.", "error");
  if (row.status !== "proposed") return notice(`That request was already ${row.status}.`);
  const draft = readDraft(row.draft_json);
  if (decision === "cancel") {
    ctx.db.prepare(`UPDATE pending_actions SET status='cancelled' WHERE id=?`).run(pendingId);
    return { ...notice("Okay, I haven't saved anything."), kind: row.kind, sourceMessageId: draft.sourceMessageId };
  }
  ctx.db.exec("BEGIN");
  try {
    ctx.db.prepare(`UPDATE pending_actions SET status='confirmed' WHERE id=? AND status='proposed'`).run(pendingId);
    const text = APPLY[row.kind](ctx, draft.data);
    ctx.db.exec("COMMIT");
    return { ...notice(text, "success"), kind: row.kind, sourceMessageId: draft.sourceMessageId, confirmed: true };
  } catch (e) {
    ctx.db.exec("ROLLBACK");
    console.error(e);
    return notice("I couldn't save that, so nothing was changed.", "error");
  }
}
