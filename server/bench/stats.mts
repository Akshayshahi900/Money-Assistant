export const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
export const summarize = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) });
export const fmt = (n: number) => (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n).toString());
export function table(rows: Record<string, { n: number; p50: number; p95: number; max: number }>) {
  const w = Math.max(...Object.keys(rows).map((k) => k.length)) + 2;
  console.log('scenario'.padEnd(w) + 'n'.padStart(5) + 'p50 ms'.padStart(10) + 'p95 ms'.padStart(10) + 'max ms'.padStart(10));
  for (const [k, v] of Object.entries(rows)) console.log(k.padEnd(w) + String(v.n).padStart(5) + fmt(v.p50).padStart(10) + fmt(v.p95).padStart(10) + fmt(v.max).padStart(10));
}
