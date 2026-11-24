# Nance: Generative-UI money assistant (prototype)

Ask a money question in plain language; get a short answer **plus an interactive UI** (chart, form, picker, confirmation card) whose numbers always come from the data. What you do in the UI goes back to the server as **structured actions**, never as invented chat text.

All **six** scenarios are implemented and tested.

| # | User says | UI the assistant draws |
|---|---|---|
| 1 | "Where did my money go last month?" | category breakdown, tap a category to drill into its transactions |
| 2 | "I want to spend less on food." | budget editor (history chart + slider) → confirm card → saved budget |
| 3 | "Make a Goa trip group with Rahul and Priya and add yesterday's hotel and cab." | pre-filled group builder (people, transactions, equal split) → confirm card → saved group |
| 4 | "Can I afford an ₹80k phone by March?" | savings plan: change the monthly amount or the target month and the result updates → "Save as goal" → confirm |
| 5 | "Add the Swiggy ones to the group." | a **picker** (19 matches across 3 Swiggy merchants, none pre-selected) → confirm |
| 6 | "Which stock should I buy?" | polite decline + facts from your data (surplus, emergency-fund target) + follow-up button |

**Why all six, not four:** 3 and 5 are one mechanism (draft → edit → confirm) and 5 is the "don't guess" counterpart of 3; 4 is the only scenario that needs a live what-if; 6 is cheap and shows refusal handled as UI. Depth was not traded away: each has tests for the happy path, hostile input, and refresh.

## Run it

```bash
cp .env.example .env            # no key needed
cd server && npm install && npm run seed && npm test
npm run dev                     # API on :3000
cd ../web && npm install && npm run dev   # UI on :5173 (proxies /api)
# or: docker compose up --build  (single container on :3000)
npm run bench                   # in-process latency (server/)
npm run bench:http              # end-to-end latency, needs the server running
```
`CURRENT_DATE` is pinned (2026-11-23) so "yesterday", "last month", "by March" are reproducible.

## How the assistant "draws" UI

**The model never writes UI or numbers. It only chooses.**

```
user text ──► router ──► tool (pure code) ──► { text, ui spec }  ──► zod validation ──► SSE ──► React registry
              rules first (0 ms)                reads SQLite            (typed catalog)          type → component
              LLM tool-call fallback            builds sentence from
              (enum args, zod-checked)          a template + the data
```

* **A typed UI catalog** (`server/src/ui/spec.ts`): `spending_breakdown`, `transaction_list`, `budget_editor`, `group_builder`, `choice_picker`, `savings_plan`, `confirm_card`, `info_card`, `notice`. Each is a zod schema. A tool returns one; invalid specs degrade to a `notice` and never reach the client as-is.
* **One registry on the client** (`web/src/registry.tsx`): `spec.type` → React component. Types are imported from the server schema (type-only), so server and client cannot drift. Adding a UI = one schema + one component.
* **Routing is two-tier for latency:** deterministic rules cover the common phrasings in ~0 ms; otherwise an LLM picks one of the tools with enum-constrained args. LLM output is re-validated, and **prices are never taken from the model**: `₹80k` is parsed from the user's own words by code (`parseAmount`).
* **Why not let the model emit UI/JSX?** Slower, unvalidatable, inconsistent look, and it would put numbers under the model's control. The tradeoff: new UI kinds need code. For a finance product I'd take that trade every time.

## Human in the loop

* Every UI interaction is a **zod-validated action** (`ActionPayload`): `drill_down`, `update_group`, `update_choice`, `adjust_plan`, `propose_*`, `confirm`, `cancel`, ...
* **The assistant continues from what the user did.** Untick the cab and the total and split are recomputed on the server and the card is replaced in place; move the date to June and the plan, verdict and chart update.
* **Writes need explicit confirmation.** Tools can only *propose*: they store a draft in `pending_actions` and return a confirm card. The single writer is `resolvePending()` (`server/src/pending.ts`), reached only by a `confirm` action. It is transactional, **idempotent** (double-click = one write), **session-scoped**, and re-validates ids at commit time. Re-proposing from the same editor supersedes the earlier proposal, so a stale card can't be confirmed.
* **The client is never trusted with data.** It sends *ids and a month/amount only*. Names, amounts, totals and splits are re-read from the DB; ids that were never offered are dropped; amounts are clamped.
* **Refresh survives mid-task.** Transcript *and* in-progress editors are stored server-side in `messages.ui_json` and updated in place on every edit; confirm cards show live status from the DB. Confirming locks the editor it came from.
* **Errors never destroy an editor** (an invalid date appends a notice; the plan stays editable).

## "No hallucinated numbers": the guarantee and how it was checked

**Design (structural, not a prompt):**
1. All numbers come from `queries.ts`, and "what counts as spending" is defined once in the `spend_events` SQL view (excludes own-account transfers, card-bill payments, wallet loads, 10-minute duplicate postings; nets refunds and reversals).
2. Sentences are **templates filled from query results**. The LLM never produces assistant text, so it has no channel to inject a figure.
3. UI specs carry numbers as numeric fields; the browser only formats them (INR grouping).
4. Splits use integer paise so shares sum exactly (₹19,850 ÷ 3 → ₹6,616.66 + ₹6,616.66 + ₹6,616.68).
5. **Runtime provenance guard** (`grounding.ts`): every numeric token in a sentence must also exist in the data-built UI payload, else the sentence is replaced by a neutral one and logged.

**Verification (`npm test`: 69 tests):**
* **Independent oracle.** The seed generator writes `ground_truth.json` from the *intended* purchases before messy rows are injected. Per-month, per-category totals from the SQL views are compared to it for all 8 months. The Goa total (₹18,400 + ₹1,450 = ₹19,850) and the phone-plan surplus are recomputed in plain JS from `dataset.json`, bypassing the views.
* **Provenance scan** over every scenario output *and* every follow-up (drill-downs, 5 slider values, group edits, confirmations, picker, plan adjustments), asserting no numeric token is ungrounded **and that the runtime guard never had to intervene**. A negative control proves the checker really catches an invented number.
* **Adversarial LLM:** a stubbed model answers with "You spent ₹1,23,456", injected `total`/`amount` args, an invented category, a bogus tool, malformed args, a `price: 1` for a ₹50k item, and a network outage. None of it reaches the user; amounts are recomputed and the price comes from the user's text.
* **Hostile input:** malformed/oversized actions, foreign ids, NaN/∞/negative amounts, SQL-ish text in names and search terms: no crash, no write, DB intact.

*Honest limit:* the guard checks that numbers *exist in the payload*, not that they are *relevant*. Correctness of the payload itself rests on the oracle tests above. The checker also doesn't understand units, so "6 months" and "₹6" would look alike.

## Latency

Targets: first visible response < 1 s, complete UI ≤ 5 s. The server streams SSE: a `placeholder` event is written **before any work starts** (client shows a skeleton), then `text`, `ui`, `done`. The LLM call has a 4 s abort and falls back to the fixed reply.

**Measured: in-process, full server pipeline** (route → query → validate → guard → SQLite writes), rule-routed path, Node 22, N=300 per row after warm-up (`npm run bench`):

| scenario | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|
| 1 breakdown | 3.6 | 5.1 | 10.2 |
| 2 food budget | 6.0 | 6.6 | 10.5 |
| 3 goa group | 7.8 | 9.5 | 12.9 |
| 4 phone plan | 8.9 | 11.8 | 21.0 |
| 5 swiggy picker | 3.7 | 4.4 | 6.8 |
| 6 stock advice | 3.4 | 4.8 | 7.6 |
| action: plan slider | 7.0 | 8.0 | 11.4 |
| action: group tick | 1.9 | 2.3 | 7.6 |
| action: budget slider | 4.4 | 5.4 | 11.0 |

**What this does NOT include, so don't over-read it:** HTTP/browser time, and the LLM-routed tier. The rule path never calls an LLM, so for the six scenarios the work is milliseconds and the network dominates. For unusual phrasings an LLM call is added (typically a few hundred ms to ~1–2 s on Groq/Gemini free tiers, **not measured here**, and bounded at 4 s by the abort, so complete-UI stays under 5 s even on failure). `npm run bench:http` (and `LLM=1 npm run bench:http`) measures the real end-to-end p50/p95 for both tiers and prints MET/MISSED per target; run it on your machine and paste the numbers here.

Where the time goes: ~4 ms of each query is the window-function duplicate detection in `txn_flagged`; materialising it at seed time would cut that if it ever mattered.

## Data

`data/dataset.json`: one synthetic user, **633 transactions**, 3 accounts (savings, credit card, wallet), 5 contacts, **8 months** (Apr–Nov 2026). Deliberately messy: duplicate postings, card-bill and wallet-load transfers (two legs), refunds, a failed-UPI reversal, friends' repayments (credits that are *not* income), ~4% missing categories, merchants with no name, and plain-text cash withdrawals. Seed is deterministic (`SEED=42`; verified byte-identical on re-seed). No real data.

## Limits / what I'd do next

* Single user, no auth; groups are global to the DB (sessions scope drafts and confirmations only).
* Group candidates come from the requested period plus keyword hints ("GOA"), not an arbitrary search; the split is equal-only.
* The savings plan assumes nothing saved yet and one deposit a month; surplus = 3-month average income − spend. It's stated in the card, but a real version would read balances.
* Date parsing covers common phrasings ("by March", "in 6 months", "by Jan 2028"); anything else gets a clarifying question rather than a guess.
* English only; the LLM tier is only as good as its tool descriptions.
