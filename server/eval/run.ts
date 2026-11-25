import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db';
import { handleAction, handleChat } from '../src/assistant';
import type { UiSpec } from '../src/ui/spec';

type Prompt = { id: string; prompt: string; expectedIntent: string; expectedUi: UiSpec['type']; numberProfile: string; llmRequired?: boolean };
type Suite = { today: string; profiles: Record<string, Record<string, unknown>>; prompts: Prompt[] };
const suite = JSON.parse(readFileSync(new URL('./prompts.json', import.meta.url), 'utf8')) as Suite;
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envFile); } catch (e) { console.error('Could not load .env:', e); }
}
const evalDbPath = `/tmp/nance-eval-${process.pid}.db`;
const hasLlmKey = Boolean(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);
const skipLlm = process.env.EVAL_SKIP_LLM === '1';
const onlyId = process.env.EVAL_ONLY;

function readPath(root: unknown, path: string): unknown {
  let v: any = root;
  for (const part of path.split('.')) {
    if (part === '*') v = Array.isArray(v) ? v.map((x) => x) : undefined;
    else if (part === 'length' && Array.isArray(v)) v = v.length;
    else if (Array.isArray(v)) v = v.map((x) => x?.[part]);
    else v = v?.[part];
  }
  return v;
}
function matches(a: unknown, b: unknown): boolean {
  if (b && typeof b === 'object' && !Array.isArray(b) && 'contains' in b && typeof (b as { contains: unknown }).contains === 'string')
    return typeof a === 'string' && a.toLocaleLowerCase().includes((b as { contains: string }).contains.toLocaleLowerCase());
  return JSON.stringify(a) === JSON.stringify(b);
}
function numericLeaves(value: unknown): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) return [value];
  if (typeof value === 'string' && /^₹[\d,]+(?:\.\d+)?$/.test(value)) return [Number(value.slice(1).replace(/,/g, ''))];
  if (Array.isArray(value)) return value.flatMap(numericLeaves);
  return [];
}
const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0;
};
function costUsd(usage: { in: number; out: number } | undefined): number | null {
  if (!usage || (usage.in === 0 && usage.out === 0)) return 0;
  const input = Number(process.env.LLM_INPUT_USD_PER_1M_TOKENS);
  const output = Number(process.env.LLM_OUTPUT_USD_PER_1M_TOKENS);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return (usage.in * input + usage.out * output) / 1_000_000;
}

async function main() {
  rmSync(evalDbPath, { force: true });
  const seedDb = openDb();
  const n = (seedDb.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
  if (n < 300) throw new Error(`Seed DB has only ${n} transactions. Run "npm run seed" first.`);
  seedDb.exec(`VACUUM INTO '${evalDbPath}'`);
  seedDb.close();
  const db = openDb(evalDbPath);
  for (const table of ['group_transactions', 'group_members', 'groups', 'goals', 'budgets', 'pending_actions', 'messages', 'sessions']) db.exec(`DELETE FROM ${table}`);
  const ctx = { db, today: suite.today };

  // Scenario 5 needs an existing confirmed group. It is created only in this throwaway evaluation DB.
  const setupSid = 'eval-setup';
  db.prepare("INSERT INTO sessions VALUES (?, 'eval')").run(setupSid);
  const setup = await handleChat(ctx, setupSid, "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab.");
  if (setup.ui.type !== 'group_builder') throw new Error('Evaluation setup did not produce a group draft.');
  const proposed = handleAction(ctx, setupSid, {
    action: 'propose_group', name: setup.ui.name,
    memberIds: setup.ui.members.filter((m) => m.selected).map((m) => m.id),
    txnIds: setup.ui.transactions.filter((t) => t.selected).map((t) => t.id),
  }, setup.messageId);
  if (proposed.append?.ui.type !== 'confirm_card') throw new Error('Could not prepare picker fixture.');
  handleAction(ctx, setupSid, { action: 'confirm', pendingId: proposed.append.ui.pendingId }, proposed.append.messageId);

  const results: { id: string; okIntent: boolean; okUi: boolean; exactFields: number; expectedFields: number; matchedNumbers: number; expectedNumbers: number; ms: number; via: string; llmRequired: boolean; usage?: { in: number; out: number }; failures: string[] }[] = [];
  for (const [index, test] of suite.prompts.entries()) {
    if (onlyId && test.id !== onlyId) continue;
    if (test.llmRequired && (!hasLlmKey || skipLlm)) continue;
    const sid = `eval-${String(index).padStart(2, '0')}`;
    db.prepare("INSERT INTO sessions VALUES (?, 'eval')").run(sid);
    const start = performance.now();
    const out = await handleChat(ctx, sid, test.prompt);
    const ms = performance.now() - start;
    const profile = suite.profiles[test.numberProfile];
    if (!profile) throw new Error(`Unknown number profile ${test.numberProfile} (${test.id}).`);
    const exactFields = Object.entries(profile).filter(([path, expected]) => matches(readPath(out.ui, path), expected));
    const failures = Object.entries(profile).filter(([path, expected]) => !matches(readPath(out.ui, path), expected)).map(([path]) => path);
    const wantNumbers = Object.values(profile).flatMap(numericLeaves);
    const gotNumbers = Object.entries(profile).flatMap(([path, expected]) => {
      const actual = readPath(out.ui, path);
      return matches(actual, expected) ? numericLeaves(expected) : [];
    });
    const okIntent = out.intent === test.expectedIntent;
    const okUi = out.ui.type === test.expectedUi;
    results.push({ id: test.id, okIntent, okUi, exactFields: exactFields.length, expectedFields: Object.keys(profile).length,
      matchedNumbers: gotNumbers.length, expectedNumbers: wantNumbers.length, ms, via: out.via, llmRequired: Boolean(test.llmRequired), usage: out.usage,
      failures: [...(!okIntent ? [`intent: ${out.intent}`] : []), ...(!okUi ? [`ui: ${out.ui.type}`] : []), ...failures] });
  }
  db.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(evalDbPath + suffix, { force: true });

  const elapsed = results.map((r) => r.ms);
  const llmElapsed = results.filter((r) => r.llmRequired).map((r) => r.ms);
  const allNumbers = results.reduce((s, r) => s + r.expectedNumbers, 0);
  const matchedNumbers = results.reduce((s, r) => s + r.matchedNumbers, 0);
  const expectedFields = results.reduce((s, r) => s + r.expectedFields, 0);
  const matchedFields = results.reduce((s, r) => s + r.exactFields, 0);
  const costs = results.map((r) => costUsd(r.usage));
  const avgCost = costs.some((x) => x === null) ? null : costs.reduce<number>((s, x) => s + (x ?? 0), 0) / Math.max(costs.length, 1);
  const accuracy = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}% (${n}/${d})` : 'n/a';
  console.log(`Nance evaluation · fixed date ${suite.today}`);
  const considered = onlyId ? 1 : suite.prompts.length;
  const skipped = considered - results.length;
  console.log(`Prompts: ${results.length}/${considered} executed${skipped ? ` · ${skipped} LLM-only prompts skipped (${skipLlm ? 'EVAL_SKIP_LLM=1' : 'no API key'})` : ''}`);
  console.log(`Intent accuracy: ${accuracy(results.filter((r) => r.okIntent).length, results.length)}`);
  console.log(`UI type accuracy: ${accuracy(results.filter((r) => r.okUi).length, results.length)}`);
  console.log(`Expected-field accuracy: ${accuracy(matchedFields, expectedFields)}`);
  console.log(`Numeric checkpoint accuracy: ${accuracy(matchedNumbers, allNumbers)}`);
  console.log(`Handler latency: p50 ${percentile(elapsed, 50).toFixed(2)} ms · p95 ${percentile(elapsed, 95).toFixed(2)} ms (includes routing, model call if enabled, DB query and spec validation; excludes HTTP/browser)`);
  if (llmElapsed.length) console.log(`LLM-only prompt latency: p50 ${percentile(llmElapsed, 50).toFixed(2)} ms · p95 ${percentile(llmElapsed, 95).toFixed(2)} ms`);
  console.log(`Average cost/request: ${avgCost === null ? 'unknown (set LLM_INPUT_USD_PER_1M_TOKENS and LLM_OUTPUT_USD_PER_1M_TOKENS)' : `$${avgCost.toFixed(8)} USD`}`);
  console.log(`LLM token usage: ${results.reduce((s, r) => s + (r.usage?.in ?? 0), 0)} input · ${results.reduce((s, r) => s + (r.usage?.out ?? 0), 0)} output across ${results.filter((r) => r.usage).length} model calls`);
  const failed = results.filter((r) => !r.okIntent || !r.okUi || r.failures.length);
  if (failed.length) {
    console.log('\nFailures:');
    for (const r of failed) console.log(`  ${r.id}: ${r.failures.join('; ')}`);
  }
  if (failed.length) process.exitCode = 1;
}

await main();
