/**
 * UI spec catalog. The LLM never writes UI code: tools return one of these typed specs,
 * validated here, and the frontend maps `type` -> React component (web/src/registry.tsx).
 * To add a new UI: add a schema here + a component in the registry. All amounts are numbers (INR)
 * that came from the query layer; the frontend only formats them.
 */
import { z } from "zod";

const Period = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string(),
});

export const NoticeSpec = z.object({
  type: z.literal("notice"),
  tone: z.enum(["info", "error", "success"]),
  text: z.string(),
});

export const SpendingBreakdownSpec = z.object({
  type: z.literal("spending_breakdown"),
  period: Period,
  total: z.number(),
  categories: z.array(
    z.object({
      category: z.string(),
      amount: z.number(),
      pct: z.number(),
      count: z.number(),
    }),
  ),
});
export const TransactionListSpec = z.object({
  type: z.literal("transaction_list"),
  title: z.string(),
  total: z.number(),
  rows: z.array(
    z.object({
      id: z.string(),
      date: z.string(),
      merchant: z.string(),
      description: z.string(),
      amount: z.number(),
    }),
  ),
});
export const BudgetEditorSpec = z.object({
  type: z.literal("budget_editor"),
  category: z.string(),
  basis: z.string(),
  history: z.array(z.object({ month: z.string(), amount: z.number() })),
  average: z.number(),
  suggested: z.number(),
  limit: z.number(),
  min: z.number(),
  max: z.number(),
  step: z.number(),
  savingsPerMonth: z.number(),
  savingsPerYear: z.number(),
});
export const ConfirmCardSpec = z.object({
  type: z.literal("confirm_card"),
  pendingId: z.string(),
  title: z.string(),
  lines: z.array(z.object({ label: z.string(), value: z.string() })),
  status: z.enum(["proposed", "confirmed", "cancelled"]),
  confirmLabel: z.string().optional(),
});


export const InfoCardSpec = z.object({
  type: z.literal("info_card"),
  title: z.string(),
  body: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
  points: z.array(z.string()),
  actions: z.array(z.object({ label: z.string(), ask: z.enum(["spending_last_month", "spending_last_3_months"]) })),
});

export const GroupBuilderSpec = z.object({
  type: z.literal("group_builder"),
  status: z.enum(["editing", "done"]),
  name: z.string(),
  members: z.array(z.object({ id: z.string(), name: z.string(), selected: z.boolean() })),
  transactions: z.array(
    z.object({
      id: z.string(), date: z.string(), merchant: z.string(), description: z.string(),
      amount: z.number(), selected: z.boolean(), hint: z.string().optional(),
    }),
  ),
  selectedCount: z.number(),
  total: z.number(),
  split: z.object({ people: z.number(), each: z.number(), you: z.number() }).nullable(),
  notes: z.array(z.string()),
});

export const ChoicePickerSpec = z.object({
  type: z.literal("choice_picker"),
  status: z.enum(["open", "done"]),
  question: z.string(),
  group: z.object({ id: z.string(), name: z.string() }),
  options: z.array(
    z.object({
      id: z.string(), label: z.string(), detail: z.string(), amount: z.number(), selected: z.boolean(),
    }),
  ),
  selectedCount: z.number(),
  selectedTotal: z.number(),
});

export const SavingsPlanSpec = z.object({
  type: z.literal("savings_plan"),
  status: z.enum(["editing", "done"]),
  item: z.string(),
  price: z.number(),
  targetMonth: z.string(),
  targetLabel: z.string(),
  targetOptions: z.array(z.object({ value: z.string(), label: z.string() })),
  monthsLeft: z.number(),
  monthly: z.number(),
  min: z.number(),
  max: z.number(),
  step: z.number(),
  requiredMonthly: z.number(),
  gapMonthly: z.number(),            // requiredMonthly - monthly, floored at 0
  avgIncome: z.number(),
  avgSpend: z.number(),
  avgSurplus: z.number(),
  basis: z.string(),
  projected: z.number(),
  shortfall: z.number(),
  verdict: z.enum(["on_track", "stretch", "short"]),
  reachedLabel: z.string().nullable(),
  earliestLabel: z.string().nullable(),
  series: z.array(z.object({ label: z.string(), saved: z.number() })),
  levers: z.array(z.object({ category: z.string(), savePerMonth: z.number() })),
});

export const UiSpec = z.discriminatedUnion("type", [
  NoticeSpec,
  SpendingBreakdownSpec,
  TransactionListSpec,
  BudgetEditorSpec,
  ConfirmCardSpec,
  InfoCardSpec,
  GroupBuilderSpec,
  ChoicePickerSpec,
  SavingsPlanSpec,
]);
export type UiSpec = z.infer<typeof UiSpec>;

/** Validate before anything leaves the server; fall back to a notice instead of crashing the UI. */
export function safeSpec(raw: unknown): UiSpec {
  const r = UiSpec.safeParse(raw);
  return r.success
    ? r.data
    : {
        type: "notice",
        tone: "error",
        text: "Could not render that view. Please try again.",
      };
}

/** Structured input coming back from the UI (never free chat text). */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ym = z.string().regex(/^\d{4}-\d{2}$/);
const ids = z.array(z.string().max(64)).max(200);
export const ActionPayload = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("drill_down"),
    category: z.string().max(60),
    from: date,
    to: date,
    label: z.string().max(60),
  }),
  z.object({
    action: z.literal("adjust_budget"),
    category: z.string().max(60),
    limit: z.number().finite(),
  }),
  z.object({
    action: z.literal("propose_budget"),
    category: z.string().max(60),
    limit: z.number().finite(),
  }),
  z.object({ action: z.literal("update_group"), name: z.string().max(80), memberIds: ids, txnIds: ids }),
  z.object({ action: z.literal("propose_group"), name: z.string().max(80), memberIds: ids, txnIds: ids }),
  z.object({ action: z.literal("update_choice"), ids }),
  z.object({ action: z.literal("submit_choice"), ids }),
  z.object({ action: z.literal("adjust_plan"), targetMonth: ym, monthly: z.number().finite() }),
  z.object({ action: z.literal("propose_goal"), targetMonth: ym, monthly: z.number().finite() }),
  z.object({ action: z.literal("quick_ask"), ask: z.enum(["spending_last_month", "spending_last_3_months"]) }),
  z.object({ action: z.literal("confirm"), pendingId: z.string().max(64) }),
  z.object({ action: z.literal("cancel"), pendingId: z.string().max(64) }),
]);
export type ActionPayload = z.infer<typeof ActionPayload>;
