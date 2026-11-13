import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { recordKey } from "./keys";
import {
  buildModuleGraph,
  NO_OUTSIDE_FILES,
  type BundledClosure,
} from "./module-graph";
import { npmCodeKey } from "./npm-identity";
import { currentRecordStore } from "./store";

/**
 * The answer of a process that LOADS repo modules — a probe script that
 * `require`s every schema file and reports what they declare — as a record:
 * keyed by the Merkle key of every module it loads (the probe script itself
 * included, whose closure is the code that computes the answer), the input it
 * is handed, the runtime and the npm code those closures import. So the
 * process runs once per distinct closure host-wide, and an edit to a file
 * outside every loaded closure is a lookup.
 *
 * `modules` must name every module the process loads besides what their
 * static and dynamic imports reach — a module it loads by a computed path is
 * an input no key names. `input` is checkout-free plain data (a repo-relative
 * path, never an absolute one: a record is shared by every checkout), and so
 * is the answer. Only a success is stored: a failed run (a crash, a timeout —
 * a function of the host, not of the code) runs again next time.
 *
 * A process that PARSES modules without running them — a `Bun.build` of one
 * entry, whose answer is the bundle (its tree-shaking) — names them as
 * `bundled`: the closure it parses, as `fileSetClosure` measured it (dynamic
 * edges cut or followed per edge, as the bundler does). Each member is keyed
 * by its path, its blob and its out-edges — and only those: a module the
 * bundler never reads (behind a cut `import()`) is no input, so an edit there
 * leaves the record standing, where `modules`' Merkle keys (static and
 * dynamic reach) would move. The out-edges are part of it because a bundle
 * also depends on what each specifier resolved to. The caller asserts on a
 * miss that the process parsed exactly `bundled.modules`: the key covers what
 * the graph says the bundler reads, and only that check proves the two agree.
 *
 * What escapes the key, as for every record: a loaded module that reads a
 * file or the environment at load. Caught by `./equin check --verify-records`,
 * not prevented.
 */
export async function closureRecord<T, E>(
  repo: RepoFiles | RepoSnapshot,
  spec: {
    /** What is recorded (the producer), part of the key. */
    name: string;
    modules: readonly string[];
    /** The modules a bundler parses (see above), keyed by content and edges only. */
    bundled?: Pick<BundledClosure, "modules" | "children">;
    input: unknown;
  },
  run: () => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
): Promise<{ ok: true; value: T; hit: boolean } | { ok: false; error: E }> {
  const store = currentRecordStore();
  const graph = await buildModuleGraph(
    { snapshot: repo, store, readOutside: NO_OUTSIDE_FILES },
    spec.modules,
  );
  const key = recordKey(
    "closure-record",
    spec.name,
    store.environment,
    ...[...spec.modules].sort().map((m) => `${m}=${graph.keyOf(m)}`),
    ...(spec.bundled === undefined
      ? []
      : await bundledKeyParts(repo, spec.bundled)),
    JSON.stringify(spec.input),
    await npmCodeKey(repo, graph.packages),
  );
  const stored = (await store.getMany("closure", [key])).get(key);
  if (stored !== undefined)
    return { ok: true, value: JSON.parse(stored) as T, hit: true };
  const result = await run();
  if (!result.ok) return result;
  store.putMany("closure", [[key, JSON.stringify(result.value)]]);
  return { ok: true, value: result.value, hit: false };
}

/** Each bundled member as `path@blob>child,child…`, sorted by path. */
async function bundledKeyParts(
  repo: RepoFiles | RepoSnapshot,
  bundled: Pick<BundledClosure, "modules" | "children">,
): Promise<string[]> {
  const members = [...bundled.modules].sort();
  const graph = await buildModuleGraph(
    {
      snapshot: repo,
      store: currentRecordStore(),
      readOutside: NO_OUTSIDE_FILES,
    },
    members,
  );
  return [
    "bundled",
    ...members.map(
      (m) =>
        `${m}@${graph.modules.get(m)!.blob}>${[...bundled.children(m)].sort().join(",")}`,
    ),
  ];
}
