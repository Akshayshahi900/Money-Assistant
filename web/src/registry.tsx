import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { UiSpec, ActionPayload } from '../../server/src/ui/spec';   // type-only: erased at build, one source of truth
export type { UiSpec };
export type Action = ActionPayload;
type Of<T extends UiSpec['type']> = Extract<UiSpec, { type: T }>;
export type OnAction = (a: Action) => void;

// Display formatting only: every value originates from the server's query layer.
const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
const Amount = ({ n }: { n: number }) => <span className="num">{inr(n)}</span>;

function Breakdown({ spec, onAction }: { spec: Of<'spending_breakdown'>; onAction: OnAction }) {
  const max = spec.categories[0]?.amount || 1;
  return (
    <div className="card">
      <div className="sub">Spent in {spec.period.label}</div>
      <div className="big num">{inr(spec.total)}</div>
      {spec.categories.map((c) => (
        <button key={c.category} className="cat" aria-label={`${c.category}, ${inr(c.amount)}. Show transactions`}
          onClick={() => onAction({ action: 'drill_down', category: c.category, from: spec.period.from, to: spec.period.to, label: spec.period.label })}>
          <div className="row"><span>{c.category}</span><span><Amount n={c.amount} /> <span className="sub num">{c.pct}%</span></span></div>
          <div className="bar"><i style={{ width: `${(c.amount / max) * 100}%` }} /></div>
        </button>
      ))}
    </div>
  );
}

function TxnList({ spec }: { spec: Of<'transaction_list'> }) {
  return (
    <div className="card">
      <div className="row"><h3>{spec.title}</h3><b className="num">{inr(spec.total)}</b></div>
      <table><tbody>
        {spec.rows.map((r) => (
          <tr key={r.id}><td><div>{r.merchant}</div><div className="desc">{r.date} · {r.description}</div></td>
            <td className="r num" style={r.amount < 0 ? { color: 'var(--ok)' } : undefined}>{r.amount < 0 ? '−' : ''}{inr(Math.abs(r.amount))}</td></tr>
        ))}
      </tbody></table>
    </div>
  );
}

function BudgetEditor({ spec, onAction }: { spec: Of<'budget_editor'>; onAction: OnAction }) {
  const [v, setV] = useState(spec.limit);           // local drag value; server recomputes savings on release
  const maxH = Math.max(...spec.history.map((h) => h.amount), 1);
  const saves = spec.savingsPerMonth;
  return (
    <div className="card">
      <h3>{spec.category} budget</h3>
      <div className="sub">Based on {spec.basis} · average <span className="num">{inr(spec.average)}</span> a month</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', height: 64, margin: '12px 0' }} aria-label="Monthly spend history">
        {spec.history.map((h) => (
          <div key={h.month} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ height: (h.amount / maxH) * 44, background: 'var(--accent-soft)', borderRadius: 4 }} title={inr(h.amount)} />
            <div className="sub num" style={{ fontSize: 11 }}>{h.month.slice(5)}</div>
          </div>
        ))}
      </div>
      <div className="row"><span>Monthly limit</span><b className="num">{inr(v)}</b></div>
      <input type="range" min={spec.min} max={spec.max} step={spec.step} value={v} aria-label="Monthly limit"
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => v !== spec.limit && onAction({ action: 'adjust_budget', category: spec.category, limit: v })}
        onKeyUp={() => v !== spec.limit && onAction({ action: 'adjust_budget', category: spec.category, limit: v })} />
      <div className="sub" style={{ marginTop: 6 }}>
        {saves >= 0 ? <>Saves <b className="num">{inr(saves)}</b> a month · <b className="num">{inr(spec.savingsPerYear)}</b> a year</> : <>That's <b className="num">{inr(-saves)}</b> more a month than your average</>}
      </div>
      <div className="btns"><button className="btn primary" onClick={() => onAction({ action: 'propose_budget', category: spec.category, limit: v })}>Review and confirm</button></div>
    </div>
  );
}

function Confirm({ spec, onAction }: { spec: Of<'confirm_card'>; onAction: OnAction }) {
  return (
    <div className="card">
      <h3>{spec.title}</h3>
      <table><tbody>{spec.lines.map((l) => (<tr key={l.label}><td>{l.label}</td><td className="r num">{l.value}</td></tr>))}</tbody></table>
      {spec.status === 'proposed'
        ? <div className="btns">
            <button className="btn primary" onClick={() => onAction({ action: 'confirm', pendingId: spec.pendingId })}>{spec.confirmLabel ?? 'Confirm'}</button>
            <button className="btn" onClick={() => onAction({ action: 'cancel', pendingId: spec.pendingId })}>Cancel</button></div>
        : <div className={`status ${spec.status}`}>{spec.status === 'confirmed' ? 'Done' : 'Cancelled — nothing was saved'}</div>}
    </div>
  );
}

function InfoCard({ spec, onAction }: { spec: Of<'info_card'>; onAction: OnAction }) {
  return (
    <div className="card">
      <h3>{spec.title}</h3>
      <p className="sub" style={{ margin: '6px 0 10px' }}>{spec.body}</p>
      <table><tbody>{spec.facts.map((f) => <tr key={f.label}><td>{f.label}</td><td className="r num">{f.value}</td></tr>)}</tbody></table>
      <div className="sub" style={{ marginTop: 12, fontWeight: 600 }}>Questions worth answering first</div>
      <ul className="points">{spec.points.map((p) => <li key={p}>{p}</li>)}</ul>
      <div className="btns" style={{ flexWrap: 'wrap' }}>{spec.actions.map((x) => <button key={x.ask} className="btn" onClick={() => onAction({ action: 'quick_ask', ask: x.ask })}>{x.label}</button>)}</div>
    </div>
  );
}

function GroupBuilder({ spec, onAction }: { spec: Of<'group_builder'>; onAction: OnAction }) {
  const editable = spec.status === 'editing';
  const [name, setName] = useState(spec.name);
  const [mem, setMem] = useState(() => new Set(spec.members.filter((m) => m.selected).map((m) => m.id)));
  const [tx, setTx] = useState(() => new Set(spec.transactions.filter((t) => t.selected).map((t) => t.id)));
  const send = (kind: 'update_group' | 'propose_group', n = name, m = mem, t = tx) => onAction({ action: kind, name: n, memberIds: [...m], txnIds: [...t] });
  const flip = (set: Set<string>, id: string) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); return n; };
  return (
    <div className="card" aria-label="Group draft">
      <div className="sub">{editable ? 'Draft group · nothing is created until you confirm' : 'Group created'}</div>
      <input className="name" value={name} disabled={!editable} aria-label="Group name" maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => editable && name !== spec.name && send('update_group')}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      <div className="sub" style={{ marginTop: 10 }}>People</div>
      <div className="chips">{spec.members.map((m) => (
        <button key={m.id} className={`chip ${mem.has(m.id) ? 'on' : ''}`} aria-pressed={mem.has(m.id)} disabled={!editable}
          onClick={() => { const n = flip(mem, m.id); setMem(n); send('update_group', name, n); }}>{mem.has(m.id) ? '✓ ' : ''}{m.name}</button>))}
      </div>
      <div className="sub" style={{ marginTop: 10 }}>Transactions</div>
      <div className="scroll">
        {spec.transactions.map((t) => (
          <label key={t.id} className={`pick ${tx.has(t.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={tx.has(t.id)} disabled={!editable} onChange={() => { const n = flip(tx, t.id); setTx(n); send('update_group', name, mem, n); }} />
            <span className="grow"><div>{t.merchant} {t.hint && <span className="tag">{t.hint}</span>}</div><div className="desc">{t.date} · {t.description}</div></span>
            <span className="num">{inr(t.amount)}</span>
          </label>))}
      </div>
      {spec.notes.map((n) => <div key={n} className="note">{n}</div>)}
      <div className="row total"><span>{spec.selectedCount} selected</span><b className="num">{inr(spec.total)}</b></div>
      {spec.split && <div className="sub">Split equally: each friend <b className="num">{inr(spec.split.each)}</b> · your share <b className="num">{inr(spec.split.you)}</b></div>}
      {editable && <div className="btns"><button className="btn primary" disabled={!mem.size || !name.trim()} onClick={() => send('propose_group')}>Review and confirm</button></div>}
    </div>
  );
}

function ChoicePicker({ spec, onAction }: { spec: Of<'choice_picker'>; onAction: OnAction }) {
  const open = spec.status === 'open';
  const [sel, setSel] = useState(() => new Set(spec.options.filter((o) => o.selected).map((o) => o.id)));
  const toggle = (id: string) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); onAction({ action: 'update_choice', ids: [...n] }); };
  return (
    <div className="card" role="group" aria-label={spec.question}>
      <div style={{ fontWeight: 600 }}>{spec.question}</div>
      <div className="scroll" style={{ marginTop: 8 }}>
        {spec.options.map((o) => (
          <label key={o.id} className={`pick ${sel.has(o.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={sel.has(o.id)} disabled={!open} onChange={() => toggle(o.id)} />
            <span className="grow"><div>{o.label}</div><div className="desc">{o.detail}</div></span>
            <span className="num">{inr(o.amount)}</span>
          </label>))}
      </div>
      <div className="row total"><span>{spec.selectedCount} selected</span><b className="num">{inr(spec.selectedTotal)}</b></div>
      {open && <div className="btns"><button className="btn primary" disabled={!sel.size} onClick={() => onAction({ action: 'submit_choice', ids: [...sel] })}>Add selected to {spec.group.name}</button></div>}
    </div>
  );
}

const VERDICT = { on_track: 'On track', stretch: 'A stretch', short: 'Not quite' } as const;

function SavingsPlan({ spec, onAction }: { spec: Of<'savings_plan'>; onAction: OnAction }) {
  const editable = spec.status === 'editing';
  const [v, setV] = useState(spec.monthly), [tm, setTm] = useState(spec.targetMonth);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { setV(spec.monthly); setTm(spec.targetMonth); }, [spec.monthly, spec.targetMonth]);   // server is the source of truth
  useEffect(() => () => clearTimeout(timer.current), []);
  const send = (month: string, monthly: number) => onAction({ action: 'adjust_plan', targetMonth: month, monthly });
  const top = Math.max(spec.price, spec.projected, 1);
  return (
    <div className="card" aria-label="Savings plan">
      <div className="row"><h3>{spec.item} · <span className="num">{inr(spec.price)}</span></h3><span className={`badge ${spec.verdict}`}>{VERDICT[spec.verdict]}</span></div>
      <div className="sub">Needs <b className="num">{inr(spec.requiredMonthly)}</b> a month to hit it by {spec.targetLabel} · your recent surplus is <b className="num">{inr(spec.avgSurplus)}</b> a month ({spec.basis})</div>

      <div className="bars" aria-label="Savings by month">
        <div className="goal" style={{ bottom: `${(spec.price / top) * 100}%` }}><span>Goal {inr(spec.price)}</span></div>
        {spec.series.map((p) => <div key={p.label} className="barcol" title={inr(p.saved)}><i style={{ height: `${(p.saved / top) * 100}%` }} /><span className="sub num">{p.label.slice(0, 3)}</span></div>)}
      </div>

      <label className="ctl"><span>Target month</span>
        <select value={tm} disabled={!editable} onChange={(e) => { setTm(e.target.value); send(e.target.value, v); }}>
          {spec.targetOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select></label>
      <div className="row" style={{ marginTop: 10 }}><span>Set aside each month</span><b className="num">{inr(v)}</b></div>
      <input type="range" min={spec.min} max={spec.max} step={spec.step} value={v} disabled={!editable} aria-label="Monthly saving"
        onChange={(e) => { const n = Number(e.target.value); setV(n); clearTimeout(timer.current); timer.current = setTimeout(() => send(tm, n), 150); }} />

      <table><tbody>
        <tr><td>Saved by {spec.targetLabel}</td><td className="r num">{inr(spec.projected)}</td></tr>
        {spec.shortfall > 0 ? <tr><td>Still short by</td><td className="r num" style={{ color: 'var(--bad)' }}>{inr(spec.shortfall)}</td></tr> : <tr><td>Covers the price</td><td className="r" style={{ color: 'var(--ok)' }}>Yes</td></tr>}
        {spec.gapMonthly > 0 && <tr><td>Extra needed each month</td><td className="r num">{inr(spec.gapMonthly)}</td></tr>}
        {spec.reachedLabel && <tr><td>At this pace you'd reach it by</td><td className="r">{spec.reachedLabel}</td></tr>}
        {spec.earliestLabel && <tr><td>At your usual surplus</td><td className="r">{spec.earliestLabel}</td></tr>}
      </tbody></table>
      {spec.levers.length > 0 && <div className="note">To free up more: {spec.levers.map((l, i) => <span key={l.category}>{i ? ' or ' : ''}trimming {l.category} could free up to <b className="num">{inr(l.savePerMonth)}</b> a month</span>)}.</div>}
      <div className="sub" style={{ marginTop: 8 }}>Assumes nothing saved for this yet and one deposit a month starting next month.</div>
      {editable && <div className="btns"><button className="btn primary" onClick={() => onAction({ action: 'propose_goal', targetMonth: tm, monthly: v })}>Save as goal</button></div>}
    </div>
  );
}

const Notice = ({ spec }: { spec: Of<'notice'> }) => <div className={`card notice ${spec.tone}`}>{spec.text}</div>;

/** Registry: spec.type -> component. Adding a UI = one schema on the server + one entry here. */
export function RenderUi({ spec, onAction }: { spec: UiSpec; onAction: OnAction }): ReactNode {
  switch (spec.type) {
    case 'spending_breakdown': return <Breakdown spec={spec} onAction={onAction} />;
    case 'transaction_list': return <TxnList spec={spec} />;
    case 'budget_editor': return <BudgetEditor key={spec.limit} spec={spec} onAction={onAction} />;
    case 'confirm_card': return <Confirm spec={spec} onAction={onAction} />;
    case 'info_card': return <InfoCard spec={spec} onAction={onAction} />;
    case 'group_builder': return <GroupBuilder key={JSON.stringify([spec.name, spec.status, spec.members.map((m) => m.selected), spec.transactions.map((t) => t.selected)])} spec={spec} onAction={onAction} />;
    case 'choice_picker': return <ChoicePicker key={JSON.stringify([spec.status, spec.options.map((o) => o.selected)])} spec={spec} onAction={onAction} />;
    case 'savings_plan': return <SavingsPlan spec={spec} onAction={onAction} />;
    case 'notice': return <Notice spec={spec} />;
    default: return <div className="card">Unsupported view</div>;
  }
}
