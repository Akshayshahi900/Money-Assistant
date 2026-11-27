import type { DatabaseSync } from "node:sqlite";
import type { UiSpec } from "./ui/spec";

export interface Ctx {
  db: DatabaseSync;
  today: string;
}
export interface ToolResult {
  text: string;
  ui: UiSpec;
}

export const notice = (
  text: string,
  tone: "info" | "error" | "success" = "info",
): ToolResult => ({
  text,
  ui: { type: "notice", tone, text },
});

/** "A", "A and B", "A, B and C" */
export const joinNames = (xs: string[]) =>
  xs.length <= 1
    ? xs.join("")
    : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** Equal split in integer paise so the shares always add up to the total exactly. The remainder stays with the user. */
export function equalSplit(total: number, friends: number) {
  const people = friends + 1,
    paise = Math.round(total * 100),
    each = Math.floor(paise / people);
  return { people, each: each / 100, you: (paise - each * friends) / 100 };
}
