/**
 * The create-vs-rename answers a regen can read off the branch's own history.
 *
 * A regen (push's normalize, `--reset-migration`) deletes the branch's schema
 * migrations and drizzle diffs schema.ts against main's tip in ONE step. That
 * merged diff can ask questions no single authored migration ever asked: a
 * table one migration created and a table a later one dropped meet in the same
 * diff, and drizzle asks whether the new one is the old one renamed
 * (2026-11-16: seven ledger tables, created over four migrations, each asked
 * against the `claude_spend_hours` a fifth one dropped).
 *
 * The branch already answered every such question when it was authored:
 *
 * - an entity one of its migrations CREATEs (`CREATE TABLE`, `ADD COLUMN`, …)
 *   is new — a rename would have been emitted as `RENAME`, and recorded in
 *   that migration's sidecar;
 * - a rename recorded in a sidecar whose source the branch itself created or
 *   renamed composes through it: create X then rename X→Z is create Z, and
 *   rename W→X then X→Z is rename W→Z.
 *
 * So the question is never put to anyone; only a prompt neither rule covers
 * (schema.ts changed after the last generation) is left unanswered.
 */
import { splitStatements } from "@plugins/database/plugins/migrations/core";
import type { MigrationAnswer } from "./migrations-interactive";

const IDENT = String.raw`"([^"]+)"`;
// `"name"` or `"schema"."name"` — drizzle prints a public entity unqualified
// in its prompts (`tableKey`), any other as `schema.name`.
const QUALIFIED = String.raw`${IDENT}(?:\.${IDENT})?`;

const qualifiedName = (a: string, b: string | undefined): string =>
  b === undefined ? a : a === "public" ? b : `${a}.${b}`;

/** One statement shape that creates an entity, and the prompt key it answers. */
const CREATES: readonly { re: RegExp; key: (m: RegExpExecArray) => string }[] =
  [
    {
      re: new RegExp(String.raw`^CREATE TABLE (?:IF NOT EXISTS )?${QUALIFIED}`),
      key: (m) => `table:${qualifiedName(m[1]!, m[2])}`,
    },
    {
      // A column prompt names its table unqualified (`entry.name`).
      re: new RegExp(
        String.raw`^ALTER TABLE ${QUALIFIED} ADD COLUMN (?:IF NOT EXISTS )?${IDENT}`,
      ),
      key: (m) => `column:${m[2] ?? m[1]!}.${m[3]!}`,
    },
    {
      re: new RegExp(String.raw`^CREATE TYPE ${QUALIFIED} AS ENUM`),
      key: (m) => `enum:${qualifiedName(m[1]!, m[2])}`,
    },
    {
      re: new RegExp(String.raw`^CREATE SCHEMA (?:IF NOT EXISTS )?${IDENT}`),
      key: (m) => `schema:${m[1]!}`,
    },
    {
      re: new RegExp(
        String.raw`^CREATE SEQUENCE (?:IF NOT EXISTS )?${QUALIFIED}`,
      ),
      key: (m) => `sequence:${qualifiedName(m[1]!, m[2])}`,
    },
    {
      re: new RegExp(
        String.raw`^CREATE (?:MATERIALIZED )?VIEW (?:IF NOT EXISTS )?${QUALIFIED}`,
      ),
      key: (m) => `view:${qualifiedName(m[1]!, m[2])}`,
    },
  ];

/** The prompt keys (`promptKey`) of every entity these migrations create. */
export function createdEntityKeys(sqls: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const sql of sqls)
    for (const { raw } of splitStatements(sql))
      for (const { re, key } of CREATES) {
        const m = re.exec(raw);
        if (m !== null) keys.add(key(m));
      }
  return keys;
}

/** The key a rename's source has: the same kind (and table) as the target. */
function sourceKey(key: string, from: string): string {
  if (key.startsWith("column:")) {
    const table = key.slice("column:".length, key.lastIndexOf("."));
    return `column:${table}.${from}`;
  }
  return `${key.slice(0, key.indexOf(":"))}:${from}`;
}

/**
 * Every answer the branch's history implies: its sidecars' `recorded` answers
 * with renames composed through what the branch created or renamed, plus
 * `create` for each `created` key no sidecar answers.
 */
export function branchAnswers(
  recorded: ReadonlyMap<string, MigrationAnswer>,
  created: ReadonlySet<string>,
): Map<string, MigrationAnswer> {
  const settle = (key: string, seen: Set<string>): MigrationAnswer => {
    const a = recorded.get(key)!;
    if (a.action === "create") return a;
    const src = sourceKey(key, a.from);
    if (seen.has(src)) throw new Error(`rename answers loop at ${src}`);
    seen.add(src);
    if (recorded.has(src)) return settle(src, seen);
    if (created.has(src)) return { action: "create" };
    return a;
  };
  const out = new Map<string, MigrationAnswer>();
  for (const key of created) out.set(key, { action: "create" });
  for (const key of recorded.keys()) out.set(key, settle(key, new Set([key])));
  return out;
}
