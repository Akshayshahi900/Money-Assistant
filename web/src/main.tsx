import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RenderUi, type UiSpec, type Action } from './registry';
import './styles.css';

interface Msg { id?: number; role: 'user' | 'assistant'; text: string | null; ui: UiSpec | null; pending?: boolean; meta?: string }
const SUGGESTIONS = [
  'Where did my money go last month?', 'I want to spend less on food.',
  "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab.", 'Add the Swiggy ones to the group.',
  'Can I afford a phone by March?', 'Which stock should I buy?',
];

function App() {
  const [sid, setSid] = useState<string | null>(localStorage.getItem('nance_sid'));
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const seq = useRef<Record<number, number>>({});   // per-message request counter: a slow, older reply never overwrites a newer edit

  useEffect(() => { if (sid) fetch(`/api/state/${sid}`).then((r) => r.json()).then((d) => setMsgs(d.messages)).catch(() => {}); }, []);
  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [msgs]);

  async function send(text?: string) {
    const message = (text ?? input).trim(); if (!message || busy) return;
    setInput(''); setBusy(true);
    setMsgs((m) => [...m, { role: 'user', text: message, ui: null }, { role: 'assistant', text: null, ui: null, pending: true }]);
    const patch = (f: (m: Msg) => Msg) => setMsgs((ms) => ms.map((m, i) => (i === ms.length - 1 ? f(m) : m)));
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, message }) });
      const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /event: (.*)/.exec(block)?.[1], data = JSON.parse(/data: (.*)/.exec(block)?.[1] ?? 'null');
          if (ev === 'session') { localStorage.setItem('nance_sid', data.sessionId); setSid(data.sessionId); }
          if (ev === 'text') patch((m) => ({ ...m, text: data.text }));
          if (ev === 'ui') patch((m) => ({ ...m, ui: data, pending: false }));
          if (ev === 'done') patch((m) => ({ ...m, id: data.messageId, pending: false, meta: data.ms !== undefined ? `${data.ms} ms${data.via ? ' · ' + data.via : ''}` : undefined }));
        }
      }
    } catch { patch((m) => ({ ...m, pending: false, ui: { type: 'notice', tone: 'error', text: 'Connection problem. Please try again.' } })); }
    setBusy(false);
  }

  async function act(messageId: number | undefined, payload: Action) {
    if (!sid || messageId === undefined) return;
    const n = (seq.current[messageId] = (seq.current[messageId] ?? 0) + 1);
    try {
      const r = await (await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, messageId, payload }) })).json();
      const replaces = [r.replace, ...(r.also ?? [])].filter(Boolean) as { messageId: number; text: string; ui: UiSpec }[];
      setMsgs((ms) => {
        let out = ms.map((m) => { const x = replaces.find((p) => p.messageId === m.id); return x && (x.messageId !== messageId || seq.current[messageId] === n) ? { ...m, text: x.text, ui: x.ui } : m; });
        if (r.append) out = [...out, { id: r.append.messageId, role: 'assistant', text: r.append.text, ui: r.append.ui } as Msg];
        return out;
      });
    } catch { setMsgs((ms) => [...ms, { role: 'assistant', text: null, ui: { type: 'notice', tone: 'error', text: 'That action failed. Nothing was changed.' } }]); }
  }
  function reset() { localStorage.removeItem('nance_sid'); setSid(null); setMsgs([]); }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Nance home"><span className="brand-mark">n</span><span>Nance</span></a>
        <div className="topbar-right"><span className="demo-pill"><i /> Synthetic demo</span>{msgs.length > 0 && <button className="btn new-chat" onClick={reset}>＋ <span>New chat</span></button>}</div>
      </header>
      <main id="top" className="conversation">
        {msgs.length === 0 ? <section className="welcome">
          <div className="eyebrow"><span>✳</span> Your money, made clearer</div>
          <h1>Good decisions start<br /><em>with a clearer picture.</em></h1>
          <p className="welcome-copy">Ask a question or explore a plan. Nance turns your money data into clear, interactive next steps.</p>
          <div className="prompt-heading">TRY ASKING</div>
          <div className="prompt-grid">{SUGGESTIONS.map((s, i) => <button key={s} className="prompt-card" onClick={() => send(s)}><span className="prompt-icon">{['↗', '◒', '⌂', '⌕', '◷', '✳'][i]}</span><span>{s}</span><span className="prompt-arrow">↗</span></button>)}</div>
          <div className="privacy-note"><span>◇</span> Sample data only · No real accounts connected</div>
        </section> : <>
          <div className="conversation-heading"><div><span className="eyebrow">MONEY ASSISTANT</span><h1>Your conversation</h1></div><span className="live-pill"><i /> Ready when you are</span></div>
          {msgs.map((m, i) => (
            <div key={m.id ?? `t${i}`} className={`msg ${m.role}`}>
              {m.role === 'assistant' && <div className="speaker"><span className="mini-mark">n</span><span>Nance</span></div>}
              {m.role === 'user' && <div className="speaker user-speaker">You</div>}
              {m.text && m.ui?.type !== 'choice_picker' && <div className="bubble">{m.text}</div>}
              {m.pending && !m.ui && <div className="skeleton" aria-label="Loading response" />}
              {m.ui && <RenderUi spec={m.ui} onAction={(a) => act(m.id, a)} />}
              {m.meta && <div className="sub meta">{m.meta}</div>}
            </div>
          ))}
        </>}
      </main>
      <div ref={bottom} />
      <footer className="composer-wrap"><div className="composer">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Ask Nance anything about your money…" aria-label="Message Nance" />
        <button className="send-btn" disabled={busy || !input.trim()} onClick={() => send()} aria-label="Send message">{busy ? <span className="send-spinner" /> : <span>↑</span>}</button>
      </div><div className="composer-hint">Enter to send <span>·</span> Your data stays in this demo</div></footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
