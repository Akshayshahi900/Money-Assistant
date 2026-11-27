import { rmSync } from "node:fs";
import { openDb } from "../src/db";

let n = 0;
/** Fresh copy of the seeded DB with all assistant-owned state cleared. */
export function freshCtx() {
  const TMP = `/tmp/nance-test-${process.pid}-${n++}.db`; // one DB per call: test files never share state
  rmSync(TMP, { force: true });
  openDb().exec(`VACUUM INTO '${TMP}'`);
  const db = openDb(TMP);
  for (const t of [
    "group_transactions",
    "group_members",
    "groups",
    "goals",
    "budgets",
    "pending_actions",
    "messages",
    "sessions",
  ])
    db.exec(`DELETE FROM ${t}`);
  db.prepare("INSERT INTO sessions VALUES ('s1','x')").run();
  db.prepare("INSERT INTO sessions VALUES ('s2','x')").run();
  return { db, today: "2026-11-23" };
}
export const count = (db: any, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
