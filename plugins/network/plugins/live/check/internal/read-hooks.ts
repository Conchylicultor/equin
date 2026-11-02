import type TS from "typescript";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { parsedTsSource } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { LIVE_WEB_HOOKS } from "../../core";

// ── live:read-hooks ────────────────────────────────────────────────────────
// network/live's design rule is ONE read hook: a new way to read server data
// is an option `useLive` reads, never a hook beside it (the deleted
// `useLiveRow` was one). The web barrel's `use*` value exports are held to a
// data table in live/core (`LIVE_WEB_HOOKS`), each with what it is — so a
// second read hook cannot ship as one more export line: it has to be written
// into the table, as a read, where review sees the rule broken.

/** The web barrel the table describes. */
export const LIVE_WEB_BARREL = "plugins/network/plugins/live/web/index.ts";

let tsPromise: Promise<typeof TS> | undefined;
function loadTypescript(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

/** The `use*` VALUE names a parsed barrel exports (type-only exports left out). */
export function exportedHookNames(
  ts: typeof TS,
  file: TS.SourceFile,
): string[] {
  const names: string[] = [];
  const add = (name: string) => {
    if (/^use[A-Z0-9]/.test(name)) names.push(name);
  };
  for (const stmt of file.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      const clause = stmt.exportClause;
      if (clause === undefined || !ts.isNamedExports(clause)) {
        throw new Error(
          `${LIVE_WEB_BARREL}: a star export hides which hooks it publishes — name them`,
        );
      }
      for (const spec of clause.elements) {
        if (!spec.isTypeOnly) add(spec.name.text);
      }
      continue;
    }
    const exported = ts.canHaveModifiers(stmt)
      ? (ts.getModifiers(stmt) ?? []).some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        )
      : false;
    if (!exported) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) add(stmt.name.text);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) add(d.name.text);
      }
    }
  }
  return names;
}

/** What differs between the barrel's hooks and the table: hooks it lacks, and entries no export backs. */
export function readHookDrift(
  exported: readonly string[],
  table: Readonly<Record<string, string>>,
): { unlisted: string[]; stale: string[] } {
  const listed = new Set(Object.keys(table));
  const published = new Set(exported);
  return {
    unlisted: [...published].filter((n) => !listed.has(n)).sort(),
    stale: [...listed].filter((n) => !published.has(n)).sort(),
  };
}

export const readHooks: Check = {
  id: "live:read-hooks",
  // Not input-keyed: the verdict also reads the table's module, imported
  // rather than read through `ctx.repo()`, so a replay could not see it change.
  description:
    "Every `use*` value network/live's web barrel exports is listed, with what it is, in live/core's `LIVE_WEB_HOOKS` table (useLive the read, useLiveReader the event read, the slot-registry reads) — and every table entry is exported. The design rule is one read hook: a new way to read server data is a `useLive` query, never a hook beside it.",
  async run(ctx) {
    const repo = await ctx.repo();
    const src = await repo.read(LIVE_WEB_BARREL);
    if (src === null) {
      return { ok: false, message: `${LIVE_WEB_BARREL} is missing` };
    }
    const ts = await loadTypescript();
    const { unlisted, stale } = readHookDrift(
      exportedHookNames(
        ts,
        await parsedTsSource(ts, { rel: LIVE_WEB_BARREL, src }),
      ),
      LIVE_WEB_HOOKS,
    );
    if (unlisted.length === 0 && stale.length === 0) return { ok: true };
    const lines = [
      ...unlisted.map(
        (n) => `${n} — exported by the web barrel, not in LIVE_WEB_HOOKS`,
      ),
      ...stale.map(
        (n) => `${n} — in LIVE_WEB_HOOKS, not exported by the web barrel`,
      ),
    ];
    return {
      ok: false,
      message: `network/live's web hooks and their table disagree:\n    ${lines.join("\n    ")}`,
      hint: "A new way to read server data is a query `useLive` reads (a `CollectionQueries` member, or an option on liveValue / liveCollection), never a hook beside it — see the design rule in plugins/network/plugins/live/CLAUDE.md. A hook that reads no server data (a slot registry) is listed in plugins/network/plugins/live/core/internal/read-hooks.ts as such; a removed one leaves the table.",
    };
  },
};
