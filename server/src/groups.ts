/**
 * Scenario 3 (create a trip group from a sentence) and scenario 5 (ambiguous "add the Swiggy ones").
 * The model never picks transactions: SQL matchers do. Where a match is not unique, nothing is guessed:
 * the item is left unselected (scenario 3) or the user is asked to choose (scenario 5).
 * The client may only send ids; names/amounts/totals/splits are recomputed here from the database.
 */
import { Ctx, ToolResult, notice, joinNames, equalSplit } from "./common";
import { createPending } from "./pending";
import { resolvePeriod, PeriodKey, addDays } from "./dates";
import { ItemKey, TxnRow, matchItem, keywordTxns, searchSpend, transactionsFor, txnsByIds, allContacts, findContact, latestGroup, round2 } from "./queries";
import { inr } from "./format";
import type { UiSpec } from "./ui/spec";

type GroupBuilder = Extract<UiSpec, { type: "group_builder" }>;
type ChoicePicker = Extract<UiSpec, { type: "choice_picker" }>;
const MAX_CANDIDATES = 40;
const clean = (s: string, max = 40) => s.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const short = (s: string) => (s.length > 46 ? s.slice(0, 45) + "…" : s);
const row = (t: TxnRow, selected: boolean, hint?: string) => ({
  id: t.id, date: t.timestamp.slice(0, 10), merchant: t.merchant ?? "Unknown merchant",
  description: short(t.raw_description), amount: t.net_amount, selected, ...(hint ? { hint } : {}),
});

/** Single place that turns (name, member ids, selected txn ids, candidates) into a validated builder spec. */
function builderSpec(ctx: Ctx, o: { name: string; memberIds: string[]; selected: string[]; candidates: string[]; hints: Record<string, string>; notes: string[]; status?: "editing" | "done" }): GroupBuilder {
  const contacts = allContacts(ctx.db), mset = new Set(o.memberIds), sset = new Set(o.selected);
  const txns = txnsByIds(ctx.db, o.candidates);
  const selectedRows = txns.filter((t) => sset.has(t.id));
  const total = round2(selectedRows.reduce((s, t) => s + t.net_amount, 0));
  const friends = contacts.filter((c) => mset.has(c.id)).length;
  return {
    type: "group_builder", status: o.status ?? "editing", name: o.name,
    members: contacts.map((c) => ({ id: c.id, name: c.name, selected: mset.has(c.id) })),
    transactions: txns.map((t) => row(t, sset.has(t.id), o.hints[t.id])),
    selectedCount: selectedRows.length, total,
    split: friends > 0 && total > 0 ? equalSplit(total, friends) : null,
    notes: o.notes,
  };
}

export interface CreateGroupArgs { groupName: string; memberNames: string[]; items: ItemKey[]; period: PeriodKey }

export function createGroupDraft(ctx: Ctx, a: CreateGroupArgs): ToolResult {
  const name = clean(a.groupName) || "New group";
  const p = resolvePeriod(a.period, ctx.today);
  const notes: string[] = [], hints: Record<string, string> = {}, selected: string[] = [], memberIds: string[] = [];
  const matchedParts: string[] = [];

  for (const raw of a.memberNames.slice(0, 8)) {
    const hits = findContact(ctx.db, clean(raw, 30));
    if (hits.length === 1) memberIds.push(hits[0].id);
    else if (hits.length === 0) notes.push(`I couldn't find “${clean(raw, 30)}” in your contacts.`);
    else notes.push(`“${clean(raw, 30)}” matches several contacts (${joinNames(hits.map((h) => h.name))}), so I left them unselected.`);
  }
  for (const item of a.items) {
    const hits = matchItem(ctx.db, item, p);
    if (hits.length === 1) { selected.push(hits[0].id); hints[hits[0].id] = `Matched “${item}”`; matchedParts.push(`the ${item} (${hits[0].merchant ?? "unknown"}, ${inr(hits[0].net_amount)})`); }
    else if (hits.length === 0) notes.push(`I couldn't find a ${item} in ${p.label}.`);
    else notes.push(`I found ${hits.length} ${item} payments in ${p.label}, so I left them unselected for you to pick.`);
  }

  // candidates: what the user can tick. Matches first, then everything else in the period, then keyword hints.
  const cand: string[] = [...selected];
  const inPeriod = transactionsFor(ctx.db, p).filter((t) => t.net_amount > 0);
  for (const t of inPeriod) if (!cand.includes(t.id)) cand.push(t.id);
  const kw = name.split(" ").find((w) => w.length >= 3 && !/^(trip|group|the|our|new)$/i.test(w));
  if (kw) {
    const wide = { from: addDays(ctx.today, -60), to: addDays(ctx.today, 1), label: "the last 60 days" };
    for (const t of keywordTxns(ctx.db, kw, wide)) if (!cand.includes(t.id)) { cand.push(t.id); hints[t.id] = `Mentions “${kw.toUpperCase()}”`; }
  }
  const spec = builderSpec(ctx, { name, memberIds, selected, candidates: cand.slice(0, MAX_CANDIDATES), hints, notes });

  const who = memberIds.length ? ` with ${joinNames(spec.members.filter((m) => m.selected).map((m) => m.name))}` : "";
  const what = matchedParts.length ? ` and pre-selected ${joinNames(matchedParts)} from ${p.label}, ${inr(spec.total)} in all` : ". Pick the transactions to include";
  return { text: `Here's a draft of “${name}”${who}${what}. Review it, change anything you like, then confirm. Nothing is created until you do.`, ui: spec };
}

/** User edited the draft (rename, toggle member/transaction). Only ids are trusted; everything else is recomputed. */
export function rebuildGroup(ctx: Ctx, prev: GroupBuilder, input: { name: string; memberIds: string[]; txnIds: string[] }, status: "editing" | "done" = "editing"): GroupBuilder {
  const cand = prev.transactions.map((t) => t.id);
  const hints = Object.fromEntries(prev.transactions.filter((t) => t.hint).map((t) => [t.id, t.hint!]));
  const valid = new Set(allContacts(ctx.db).map((c) => c.id));
  return builderSpec(ctx, {
    name: clean(input.name) || prev.name,
    memberIds: input.memberIds.filter((id) => valid.has(id)),
    selected: input.txnIds.filter((id) => cand.includes(id)),
    candidates: cand, hints, notes: prev.notes, status,
  });
}

export function proposeGroup(ctx: Ctx, sid: string, spec: GroupBuilder, sourceMessageId: number): ToolResult {
  const members = spec.members.filter((m) => m.selected), txns = spec.transactions.filter((t) => t.selected);
  if (!spec.name.trim()) return notice("Give the group a name first.", "error");
  if (!members.length) return notice("Pick at least one person to add to the group.", "error");
  const lines = [
    { label: "Group", value: spec.name },
    { label: "Members", value: joinNames(members.map((m) => m.name)) },
    ...txns.slice(0, 8).map((t) => ({ label: `${t.merchant} · ${t.date}`, value: inr(t.amount) })),
    ...(txns.length > 8 ? [{ label: `…and ${txns.length - 8} more`, value: "" }] : []),
    { label: "Total", value: inr(spec.total) },
    ...(spec.split ? [{ label: `Each of ${members.length} friend${members.length === 1 ? "" : "s"} owes`, value: inr(spec.split.each) }, { label: "Your share", value: inr(spec.split.you) }] : []),
  ];
  return createPending(ctx, sid, "create_group", { name: spec.name, memberIds: members.map((m) => m.id), txnIds: txns.map((t) => t.id) }, { title: "Create group", confirmLabel: "Create group", lines }, sourceMessageId);
}

// ---------------- scenario 5: "add the Swiggy ones to the group" ----------------
function openDraftExists(ctx: Ctx, sid: string) {
  const rows = ctx.db.prepare(`SELECT ui_json FROM messages WHERE session_id=? AND ui_json LIKE '%"group_builder"%'`).all(sid) as unknown as { ui_json: string }[];
  return rows.some((r) => JSON.parse(r.ui_json).status === "editing");
}

export function addToGroup(ctx: Ctx, sid: string, a: { query: string; period: PeriodKey }): ToolResult {
  const g = latestGroup(ctx.db);
  if (!g) return notice(openDraftExists(ctx, sid) ? "Finish creating your group first (confirm it above), then I can add those." : "You don't have a group yet. Say something like “Make a Goa trip group with Rahul and Priya” and I'll set one up.");
  const p = resolvePeriod(a.period, ctx.today), q = clean(a.query, 30);
  const inGroup = new Set((ctx.db.prepare(`SELECT transaction_id AS id FROM group_transactions WHERE group_id=?`).all(g.id) as unknown as { id: string }[]).map((r) => r.id));
  const all = searchSpend(ctx.db, q, p), rows = all.filter((t) => !inGroup.has(t.id));
  if (!all.length) return notice(`I couldn't find any “${q}” transactions in ${p.label}.`);
  if (!rows.length) return notice(`Everything matching “${q}” in ${p.label} is already in “${g.name}”.`);
  if (rows.length === 1) return confirmAdd(ctx, sid, g, rows, undefined);
  const merchants = [...new Set(rows.map((t) => t.merchant ?? "Unknown"))];
  const question = `“${q}” matches ${rows.length} transactions in ${p.label} (${joinNames(merchants)}). Which ones should I add to “${g.name}”? I haven't picked any for you.`;
  return { text: question, ui: pickerSpec(rows, [], g, question) };
}

function pickerSpec(rows: TxnRow[], selected: string[], g: { id: string; name: string }, question: string, status: "open" | "done" = "open"): ChoicePicker {
  const s = new Set(selected);
  return {
    type: "choice_picker", status, question, group: g,
    options: rows.map((t) => ({ id: t.id, label: t.merchant ?? "Unknown merchant", detail: `${t.timestamp.slice(0, 10)} · ${short(t.raw_description)}`, amount: t.net_amount, selected: s.has(t.id) })),
    selectedCount: rows.filter((t) => s.has(t.id)).length,
    selectedTotal: round2(rows.filter((t) => s.has(t.id)).reduce((x, t) => x + t.net_amount, 0)),
  };
}

export function updateChoice(ctx: Ctx, prev: ChoicePicker, ids: string[], status: "open" | "done" = "open"): ChoicePicker {
  const rows = txnsByIds(ctx.db, prev.options.map((o) => o.id));
  const allowed = new Set(prev.options.map((o) => o.id));
  return pickerSpec(rows, ids.filter((i) => allowed.has(i)), prev.group, prev.question, status);
}

function confirmAdd(ctx: Ctx, sid: string, g: { id: string; name: string }, rows: TxnRow[], sourceMessageId?: number): ToolResult {
  const total = round2(rows.reduce((s, t) => s + t.net_amount, 0));
  return createPending(ctx, sid, "add_to_group", { groupId: g.id, txnIds: rows.map((t) => t.id) }, {
    title: `Add to “${g.name}”`, confirmLabel: "Add to group",
    lines: [...rows.slice(0, 8).map((t) => ({ label: `${t.merchant ?? "Unknown"} · ${t.timestamp.slice(0, 10)}`, value: inr(t.net_amount) })),
      ...(rows.length > 8 ? [{ label: `…and ${rows.length - 8} more`, value: "" }] : []),
      { label: "Total added", value: inr(total) }],
  }, sourceMessageId);
}

export function submitChoice(ctx: Ctx, sid: string, prev: ChoicePicker, ids: string[], sourceMessageId: number): ToolResult {
  const chosen = updateChoice(ctx, prev, ids);
  if (!chosen.selectedCount) return notice("Tick at least one transaction first.", "error");
  const rows = txnsByIds(ctx.db, chosen.options.filter((o) => o.selected).map((o) => o.id));
  return confirmAdd(ctx, sid, prev.group, rows, sourceMessageId);
}

export const groupText = (s: GroupBuilder) =>
  `“${s.name}”: ${s.selectedCount} transaction${s.selectedCount === 1 ? "" : "s"} selected, ${inr(s.total)} in total. Review it, then confirm.`;
