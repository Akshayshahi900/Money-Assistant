/**
 * Number-provenance guard ("no hallucinated numbers", enforced mechanically).
 * Rule: every numeric token in the assistant's sentence must also appear in the structured UI payload that the
 * query layer produced (as a number field, inside a formatted string, or as the length of a rendered list).
 * Used (1) at runtime as a last-line safety net and (2) in tests across every scenario.
 */
import type { UiSpec } from "./ui/spec";

const TOKEN = /\d[\d,]*(?:\.\d+)?/g;
const norm = (raw: string) => {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : null;
};
export const numbersIn = (s: string): string[] =>
  (s.match(TOKEN) ?? []).map(norm).filter((x): x is string => x !== null);

export function specNumbers(x: unknown, out = new Set<string>()): Set<string> {
  if (typeof x === "number")
    out.add(String(Math.abs(Math.round(x * 100) / 100))); // magnitude: "spend ₹X more" is the abs of a negative saving
  else if (typeof x === "string") numbersIn(x).forEach((n) => out.add(n));
  else if (Array.isArray(x)) {
    out.add(String(x.length));
    x.forEach((v) => specNumbers(v, out));
  } else if (x && typeof x === "object")
    Object.values(x).forEach((v) => specNumbers(v, out));
  return out;
}

/** Numbers that appear in `text` but nowhere in the UI payload. Empty array = grounded. */
export function ungrounded(text: string, ui: UiSpec): string[] {
  const allowed = specNumbers(ui);
  return numbersIn(text).filter((n) => !allowed.has(n));
}

export const SAFE_TEXT =
  "Here's what I found. The details are in the card below.";
/** Runtime net: if a sentence ever contains a number the data didn't produce, show a neutral sentence instead. */
export function guardText(text: string, ui: UiSpec): string {
  const bad = ungrounded(text, ui);
  if (!bad.length) return text;
  console.warn("[grounding] blocked ungrounded numbers:", bad);
  return SAFE_TEXT;
}
