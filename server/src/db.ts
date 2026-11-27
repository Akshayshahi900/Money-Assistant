import { createRequire } from "node:module";
import type { DatabaseSync as DB } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Vite/vitest can't resolve the `node:sqlite` builtin via import, so load it with require.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
const here = dirname(fileURLToPath(import.meta.url));
export const DB_PATH =
  process.env.DB_PATH ?? resolve(here, "../../data/nance.db");

export function openDb(path = DB_PATH): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(resolve(here, "schema.sql"), "utf8"));
  // Backward-compatible schema migration for existing local demo databases.
  const accountCols = db.prepare("PRAGMA table_info(accounts)").all() as {
    name: string;
  }[];
  if (!accountCols.some((c) => c.name === "opening_balance"))
    db.exec(
      "ALTER TABLE accounts ADD COLUMN opening_balance REAL NOT NULL DEFAULT 0",
    );
  return db;
}
