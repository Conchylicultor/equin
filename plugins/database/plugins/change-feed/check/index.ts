import type TS from "typescript";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  entityRefIdentifiers,
  findProducedWrites,
  findProducerDecls,
  resolveEntityRefNames,
  resolveTableNames,
  type Source,
} from "./producer-writes";

// `typescript`'s module object is invariant for the process's lifetime, so a
// per-process memo is safe. Loaded lazily, so the check runner's "load every
// check" burst does not pay its eval cost.
let tsPromise: Promise<typeof TS> | undefined;
function loadTypescript(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

// Where a write that bypasses the producer is legitimate, each with its reason.
// Nothing here runs inside the serving backend on a live table:
//  - test code (`outOfScope: ["test"]`): a DB fixture seeds and clears rows of a
//    throwaway database no live reader subscribes to, and a suite defines its
//    own fixture producers;
//  - the migration runner and its SQL (the migrations plugin's `exempt/`):
//    schema DDL and data migrations run in the boot barrier, before any
//    subscriber exists, and every client loads in full after the deploy anyway.

const check: Check = {
  id: "change-feed:producer-writes",
  // INPUT-KEYED: a pure scan over tracked sources.
  inputKeyed: true,
  description:
    "Every write to a table with a change producer (`defineChangeProducer`) goes through the producer's `mutate` — the only write that reaches live readers, since a produced table has no trigger. Flags a drizzle insert / update / delete on the table's binding (under any alias) that is not the builder a producer's `mutate` callback returns, and a raw SQL write (insert / update / delete / truncate / merge) naming the table. Test fixtures are out of scope and the migration runner is exempt (migrations' `exempt/index.ts`). See research/2026-10-01-global-scoped-change-routing-p5-p8.md (A11).",
  exemptable: {
    "change-feed:producer-writes":
      "writes a table that has a change producer without going through the producer's `mutate`, so the write reaches no live reader",
  },
  outOfScope: ["test"],
  async run(ctx) {
    const ts = await loadTypescript();
    const pathspecs = ["plugins/**/*.ts", "plugins/**/*.tsx"];
    const declSources = (
      await listCandidateSources({ grepArg: "defineChangeProducer", pathspecs })
    ).filter((s) => ctx.inScope(s.rel));
    const decls = findProducerDecls(ts, declSources);
    if (decls.length === 0) return { ok: true };

    const bindings = new Set(decls.map((d) => d.binding));
    const alternation = (words: Iterable<string>): string =>
      `(${[...words].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
    const bindingSources = await listCandidateSources({
      grepArg: alternation(bindings),
      pathspecs,
    });
    // An entity built from a ref is named by the ref, declared in another
    // file (the plugin's `core/`): find those files by the ref identifiers.
    const refs = entityRefIdentifiers(ts, bindingSources, bindings);
    const refNames =
      refs.size === 0
        ? new Map<string, Set<string>>()
        : resolveEntityRefNames(
            ts,
            await listCandidateSources({
              grepArg: alternation(refs),
              pathspecs,
            }),
            refs,
          );
    const tables = resolveTableNames(ts, bindingSources, bindings, refNames);
    const unresolved = decls.filter((d) => !tables.has(d.binding));
    if (unresolved.length > 0) {
      // A producer whose table this scan cannot name would make every check of
      // it vacuous: fail rather than pass on a scan that saw nothing.
      return {
        ok: false,
        message: `Cannot resolve the table of ${unresolved.length} change producer(s) — no \`const <binding> = …pgTable("<name>", …)\` / \`…defineEntity("<name>", …)\` / \`…defineEntity(<ref>, …)\` over an \`entityRef("<name>", …)\` (or \`<entity>.table\` of one) found:\n    ${unresolved.map((d) => `${d.path}:${d.line}  table: ${d.binding}`).join("\n    ")}`,
        hint: "Pass `defineChangeProducer` the table's own binding (the identifier its `pgTable(…)` / `defineEntity(…)` declaration — or that entity's `.table` — is assigned to), not an alias or an expression.",
      };
    }

    const names = new Set([...tables.values()].flatMap((s) => [...s]));
    const writeSources: Source[] = (
      await listCandidateSources({
        grepArg: alternation([...bindings, ...names]),
        pathspecs,
      })
    ).filter((s) => ctx.inScope(s.rel));
    const producers = new Set(
      decls.flatMap((d) => (d.producer === null ? [] : [d.producer])),
    );
    const exempt = await ctx.exempt("change-feed:producer-writes");
    const writes = findProducedWrites(
      ts,
      writeSources,
      tables,
      producers,
    ).filter((w) => !exempt.skips(w.path));
    if (writes.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${writes.length} write(s) to a produced table bypass its change producer — they reach no live reader:\n    ${writes
        .map((w) => `${w.path}:${w.line}  [${w.kind} → ${w.table}]  ${w.text}`)
        .join("\n    ")}`,
      hint: "Run the write through the table's producer: `producer.mutate(db, (q, t) => q.update(t).set(…).where(…), { latency })` — it returns the touched PKs and routes them. A raw SQL write has no producer form: express it as a drizzle builder inside `mutate`.",
    };
  },
};

export default check;
