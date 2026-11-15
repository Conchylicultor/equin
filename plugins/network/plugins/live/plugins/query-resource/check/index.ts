import { join, relative } from "node:path";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { closureFiles } from "@plugins/packages/plugins/source-digest/server";

const ID = "query-resource:live-read-closure";

// The modules of the `liveReadCode` source set: each includes itself.
const INCLUDE = "liveReadCode.include(import.meta)";

/**
 * How many repo files the `liveReadCode` digest may cover — exactly what was
 * measured, so any new edge fails here and is decided on purpose.
 * Measured 2026-11-15: 58 (query-resource's compilers, the sql-projection /
 * sql-column / sql-rows decoders, zod-introspect, keyset, string-hash,
 * report-sink, and resource-runtime's `routing` leaf).
 * - Before the registration moved out of the digested compilers
 *   (`server/internal/register.ts`): 216 — the database and server-core
 *   barrels — and 25 of 115 commits on main moved it.
 * - Before `routes.ts` imported the `routing` leaf instead of
 *   resource-runtime's barrel, and `compile-alias.ts` took its params-gate
 *   error from its `CompileHost` instead of importing resource-protocol: 85
 *   — the whole runtime (`runtime.ts`, its ledgers, networking) and the wire
 *   protocol (with product-name) — and 21 of the 576 commits on main since
 *   2026-11-10 moved it, 16 of them touching only those files. Under this
 *   closure, 5 of the 576 do.
 * Each such commit is a restart whose successor inherits no handed-over tuple
 * (~1,150 point reads re-run instead of ~450). A rise past it names a new
 * edge: cut it (hand the dependency in, as `CompileHost` does; import a leaf,
 * not a barrel), or re-measure and raise the budget saying why the code
 * shapes a compiled read's rows (`core/internal/live-read-code.ts` says why
 * the runtime does not).
 */
const BUDGET = 58;

/**
 * The `liveReadCode` digest stamps the epoch handoff record and every L2
 * definition of an `all` set: a successor whose digest differs inherits
 * nothing, so the digest must move only with code that shapes a compiled
 * read's rows. Its closure is walked by source-digest's own walk
 * (`closureFiles`), so the guard and the digest cannot disagree.
 */
const check: Check = {
  id: ID,
  description: `the closure the \`liveReadCode\` digest covers (every module that \`${INCLUDE}\`s, with everything it statically loads) stays within ${BUDGET} repo files — so an edit to code that shapes no compiled row (a server barrel, a boot hook, a migration) does not move the digest and make the next restart reload every handed-over point read`,
  outOfScope: ["test"],
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const matches = await grepCode({
      root,
      pattern: /\bliveReadCode\.include\(import\.meta\)/,
      grepArg: "liveReadCode.include(import.meta)",
      fixed: true,
    });
    const entries = [...new Set(matches.map((m) => join(root, m.path)))];
    if (entries.length === 0) {
      return {
        ok: false,
        message: `no module calls \`${INCLUDE}\` — the liveReadCode digest would vouch for no code`,
        hint: "query-resource's compile-window.ts / compile-alias.ts and network/live's encode-row.ts include themselves; restore the call.",
      };
    }
    const files = (await closureFiles(entries)).map((f) => relative(root, f));
    if (files.length <= BUDGET) return { ok: true };
    const byPlugin = new Map<string, number>();
    for (const f of files) {
      const owner = f.replace(
        /\/(core|server|shared|machine|web|central)\/.*$/,
        "",
      );
      byPlugin.set(owner, (byPlugin.get(owner) ?? 0) + 1);
    }
    const top = [...byPlugin]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([p, n]) => `${n} ${p}`);
    return {
      ok: false,
      message: `the liveReadCode digest covers ${files.length} repo files (budget ${BUDGET}), from ${entries.length} including module(s):\n    ${top.join("\n    ")}`,
      hint: "A digested module (compile-window.ts, compile-alias.ts, encode-row.ts, or what they load) now imports code that shapes no row — a server barrel, a registry. Hand that dependency in from a module outside the set (query-resource's `server/internal/register.ts` and its `CompileHost`), or re-measure and raise BUDGET with the reason.",
    };
  },
};

export default check;
