# Nance: Generative-UI money assistant (prototype)

Ask a money question in plain language; get a short answer **plus an interactive UI** (chart, form, picker, confirmation card) whose numbers always come from the data. What you do in the UI goes back to the server as **structured actions**, never as invented chat text.

All six assignment scenarios have an end-to-end path. Common versions use the deterministic router; the evaluation set also has LLM-only phrasings that require a configured, reachable model endpoint.

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
cp .env.example .env            # no model key needed for the six common scenarios
docker compose up --build       # single command; app on http://localhost:3000
```

Optional LLM routing: set **one** of `GROQ_API_KEY` or `GEMINI_API_KEY` in `.env`; `LLM_MODEL` and `LLM_TIMEOUT_MS` are optional. No key is needed for the deterministic scenario routes. `CURRENT_DATE` defaults to `2026-11-23`, pinned for reproducible relative dates.

For development, install `server/` and `web/` dependencies separately, run `npm run seed` and `npm test` in `server/`, then start `npm run dev` in both directories. The Vite server on `:5173` proxies API requests to `:3000`.

## Architecture and UI generation

**The model never writes UI or numbers. It only chooses.**

```
user text ──► router ──► tool (pure code) ──► { text, ui spec }  ──► zod validation ──► SSE ──► React registry
              rules first (0 ms)                reads SQLite            (typed catalog)          type → component
              LLM tool-call fallback            builds sentence from
              (enum args, zod-checked)          a template + the data
```

UI actions travel back as typed action payloads to deterministic server handlers; they are not converted into pretend chat messages. SQLite stores the transcript, drafts, and pending writes.

* **A typed UI catalog** (`server/src/ui/spec.ts`): `spending_breakdown`, `transaction_list`, `budget_editor`, `group_builder`, `choice_picker`, `savings_plan`, `confirm_card`, `info_card`, `notice`. Each is a zod schema. A tool returns one; invalid specs degrade to a `notice` and never reach the client as-is.
* **One registry on the client** (`web/src/registry.tsx`): `spec.type` → React component. Types are imported from the server schema (type-only), so server and client cannot drift. Adding a UI = one schema + one component.
* **Intent choice:** deterministic rules recognize the assignment's common asks without a network call. If a rule does not match, an optional LLM chooses from tool calls with constrained arguments. The server validates the choice and arguments; unknown categories and invalid tool calls fall back to a notice.
* **Rendering:** tools return a discriminated UI spec from `server/src/ui/spec.ts`; Zod validates it, SSE streams it, and `web/src/registry.tsx` maps the `type` to a React component. The same schema supplies client types, so the UI contract has one source of truth.
* **Why this approach:** letting a model return JSX would make it harder to validate the UI, keep styling consistent, and keep invented values out of the interface. A typed catalog keeps the model's role narrow and makes number provenance auditable. The tradeoff is that each new UI needs a schema and component.

## Human in the loop

* Every UI interaction is a **zod-validated action** (`ActionPayload`): `drill_down`, `update_group`, `update_choice`, `adjust_plan`, `propose_*`, `confirm`, `cancel`, ...
* **The assistant continues from what the user did.** Untick the cab and the total and split are recomputed on the server and the card is replaced in place; move the date to June and the plan, verdict and chart update.
* **Writes need explicit confirmation.** Tools can only *propose*: they store a draft in `pending_actions` and return a confirm card. The single writer is `resolvePending()` (`server/src/pending.ts`), reached only by a `confirm` action. It is transactional, **idempotent** (double-click = one write), **session-scoped**, and re-validates ids at commit time. Re-proposing from the same editor supersedes the earlier proposal, so a stale card can't be confirmed.
* **The client is never trusted with data.** It sends *ids and a month/amount only*. Names, amounts, totals and splits are re-read from the DB; ids that were never offered are dropped; amounts are clamped.
* **Refresh survives mid-task.** Transcript *and* in-progress editors are stored server-side in `messages.ui_json` and updated in place on every edit; confirm cards show live status from the DB. Confirming locks the editor it came from.
* **Errors never destroy an editor** (an invalid date appends a notice; the plan stays editable).

## Preventing wrong numbers

**Design (structural, not a prompt):**
1. Financial values come from database queries and deterministic calculations. "What counts as spending" is defined in the `spend_events` SQL view (excludes own-account transfers, card-bill payments, wallet loads, duplicate postings; nets refunds and reversals).
2. Sentences are **templates filled from query results**. The LLM never produces assistant text, so it has no channel to inject a figure.
3. UI specs carry numbers as numeric fields; the browser only formats them (INR grouping).
4. Splits use integer paise so shares sum exactly (₹19,850 ÷ 3 → ₹6,616.66 + ₹6,616.66 + ₹6,616.68).
5. **Runtime provenance guard** (`grounding.ts`): every numeric token in a sentence must also exist in the data-built UI payload, else the sentence is replaced by a neutral one and logged. Purchase prices and target dates are parsed from the user's words by code; if either is missing, the assistant asks instead of accepting a model-supplied value.

**Verification (`npm test`: 71 tests):**
* **Independent oracle.** The seed generator writes `ground_truth.json` from the *intended* purchases before messy rows are injected. Per-month, per-category totals from the SQL views are compared to it for all 8 months. The Goa total (₹18,400 + ₹1,450 = ₹19,850) and the phone-plan surplus are recomputed in plain JS from `dataset.json`, bypassing the views.
* **Provenance scan** over every scenario output *and* every follow-up (drill-downs, 5 slider values, group edits, confirmations, picker, plan adjustments), asserting no numeric token is ungrounded **and that the runtime guard never had to intervene**. A negative control proves the checker really catches an invented number.
* **Adversarial LLM:** a stubbed model answers with "You spent ₹1,23,456", injected `total`/`amount` args, an invented category, a bogus tool, malformed args, a `price: 1` for a ₹50k item, and a network outage. None of it reaches the user; amounts are recomputed and the price comes from the user's text.
* **Hostile input:** malformed/oversized actions, foreign ids, NaN/∞/negative amounts, SQL-ish text in names and search terms: no crash, no write, DB intact.

## Prompt evaluation

`server/eval/prompts.json` contains 40 prompts: common phrasings, ambiguous transaction requests, missing/invalid purchase details, investment questions, and four phrasings intended to exercise LLM routing. Each prompt names an expected intent, UI type, and numeric/data-field profile. Profiles contain exact expected values (including full category amounts and percentages, candidate transaction amounts and dates, and savings projections) from the seeded synthetic dataset.

Run `cd server && npm run seed && npm run eval`. The evaluator clones the seed database into a temporary file, creates its group fixture there, and removes the clone afterward; evaluation writes do not touch the working database. Without an LLM key, the four LLM-only prompts are reported as skipped. To include them, set `GROQ_API_KEY` or `GEMINI_API_KEY`; use `EVAL_SKIP_LLM=1` to explicitly run only the deterministic subset when provider access is unavailable. `.env.example` includes the published Groq rates for the default `openai/gpt-oss-20b` model: **$0.075 / million input tokens and $0.30 / million output tokens** ([Groq model pricing](https://console.groq.com/docs/model/openai/gpt-oss-20b)). Update those variables if you choose another model/provider. Rule-routed calls have zero model cost.

The report includes intent and UI accuracy, exact expected-field checks, numeric checkpoint accuracy, p50/p95 handler latency, token totals, and average request cost. Handler latency includes routing (and a configured model request), queries and spec validation, but excludes HTTP/browser time; use `npm run bench:http` for end-to-end SSE latency. Numeric checkpoints target displayed financial values and category percentages. Exact field checks also cover dates, selected items and transaction details. With LLM prompts enabled, scores reflect the model's actual tool choices rather than a stub.

Latest full run (40 prompts, fixed date 2026-11-23, Groq `openai/gpt-oss-20b`): **40/40 intent**, **40/40 UI type**, **313/313 expected fields**, and **536/536 numeric checkpoints** matched. The run made four model calls (the other 36 prompts took the deterministic path), used 3,113 input and 226 output tokens, and cost **$0.000301 USD total**, or **$0.00000753 per prompt** at the published rates above. Handler latency was **9.50 ms p50 / 409.29 ms p95**; the four LLM-only prompts were **409.29 ms p50 / 614.05 ms p95**. This is one successful run, not a claim of stable provider availability; a subsequent HTTP stress run encountered the free-tier TPM limit.

*Honest limit:* the guard checks that numbers *exist in the payload*, not that they are *relevant*. Correctness of the payload itself rests on the oracle tests above. The checker also doesn't understand units, so "6 months" and "₹6" would look alike.

## Latency and responsiveness

Targets: first visible response < 1 s, complete UI ≤ 5 s. The server streams SSE: a `placeholder` event is written **before routing and database work** (the client shows a skeleton), then `text`, `ui`, `done`. The LLM call has a 3.5 s timeout and falls back to a fixed notice. The common scenario phrasings use rules and do not wait on an LLM.

**Measured end-to-end over local HTTP/SSE:** 100 sequential samples per scenario, Node 26.13.1, six common rule-routed prompts. “First” is receipt of the first SSE bytes (a server-side proxy for the placeholder; actual browser paint is not instrumented); “full” is receipt of the `done` event. The client displays a local skeleton immediately when the user submits. These figures are from the earlier six-route benchmark; the fresh LLM-enabled run used 10 samples per scenario below.

| scenario | first p50 ms | first p95 ms | full p50 ms | full p95 ms |
|---|---:|---:|---:|---:|
| spending breakdown | 16.9 | 20.1 | 26.7 | 30.9 |
| food budget | 16.6 | 20.1 | 33.5 | 38.6 |
| Goa group draft | 15.3 | 17.2 | 36.8 | 40.9 |
| phone savings plan | 15.8 | 18.2 | 39.9 | 44.0 |
| Swiggy picker | 15.7 | 19.0 | 25.4 | 30.2 |
| investment refusal | 15.0 | 18.7 | 24.1 | 28.9 |
| **all six** | **15.8** | **19.6** | **30.9** | **41.5** |

All six rule-routed prompts met both latency targets. A fresh HTTP/SSE run with 10 samples per scenario measured all routes at **6.9 ms first-response p50 / 10.1 ms p95** and **21.4 ms complete-UI p50 / 615.1 ms p95**. For four LLM-only phrases (40 total attempts), first response was **8.1 ms p50 / 10.6 ms p95** and complete UI was **90.0 ms p50 / 709.9 ms p95**. These LLM samples are not all model successes: the provider returned HTTP 429 after its 8,000 TPM free-tier limit was reached, and the app correctly returned its fallback notice. Treat the full-UI aggregate and those LLM figures as rate-limit-contaminated, not model-service latency. Successful model-call latency and token cost are reported separately from the 40-prompt run above. All are local HTTP measurements; browser paint remains uninstrumented and another machine/network will differ.

`npm run bench` is available for in-process query profiling. It excludes HTTP, browser paint, and LLM routing. `npm run bench:http` measures the first SSE response and complete response for the six rule-routed prompts; pass `LLM=1` with a reachable API key to include all four LLM-only evaluation phrasings and report their p50/p95 separately.

## Data

`data/dataset.json`: one synthetic user, **633 transactions**, 3 accounts (savings, credit card, wallet), 5 contacts, **8 months** (Apr–Nov 2026). Deliberately messy: duplicate postings, card-bill and wallet-load transfers (two legs), refunds, a failed-UPI reversal, friends' repayments (credits that are *not* income), ~4% missing categories, merchants with no name, and plain-text cash withdrawals. Seed is deterministic (`SEED=42`; verified byte-identical on re-seed). No real data.

## Limits / what I'd do next

### Known failure cases

* Unusual wording depends on the optional LLM tier. If its endpoint is unreachable, rate-limited, or returns an invalid tool call, the assistant falls back to a generic notice. The full evaluation did validate all four LLM-only prompts in one successful run; later stress samples were limited by the provider's free-tier TPM quota.
* Date and amount extraction is deliberately narrow. Relative dates such as “by March” and “in 6 months” work; unsupported date language asks for clarification. Missing a price or date returns a question instead of a projection.
* Group matching searches the requested period and a limited keyword window, not arbitrary transaction history. Multiple matching hotels/cabs remain unselected; expense splits are equal-only.
* Savings projections assume no amount has already been saved and one deposit per month starting next month. The “surplus” estimate is recent average income minus spend, not a bank balance or affordability guarantee.
* One synthetic user, English only, no authentication. Groups are global in this prototype; sessions scope drafts and confirmations, not group visibility.

### Deliberately left out

* **Bank connections and real financial data:** excluded to keep this standalone evaluation synthetic and avoid transmitting sensitive information.
* **Authentication and multi-user permissions:** not needed for the assignment's single-user prototype; add them before any shared or production deployment.
* **Model-written JSX and free-form financial answers:** excluded so the model cannot control UI structure or financial values. New UI types require code and schema changes.
* **Flexible group search, custom splits, and recurring budgets:** excluded to keep transaction selection and writes reviewable within the time-boxed scenarios.
* **Balances, existing goal savings, debt obligations, and future cash-flow simulation:** excluded because the synthetic dataset does not model reliable account balances or future events.
* **Personalized investment picks:** deliberately not offered; the assistant declines stock recommendations and offers data-grounded budgeting context instead.
* **Voice and additional languages:** omitted because the assignment evaluates text interactions in English.

## Demo recording

The end-to-end flows can be demonstrated locally using the six prompts in the scenario table. Record a 3–5 minute screen capture showing a spending drill-down, budget edit and confirmation, trip-group review and confirmation, savings-plan adjustment, ambiguous Swiggy picker, and stock-advice refusal. Include a refresh while an editor or confirmation card is open. A recording is not included in this repository because this execution environment has no available browser surface or screen-capture tool; the application itself is runnable with the command above.
