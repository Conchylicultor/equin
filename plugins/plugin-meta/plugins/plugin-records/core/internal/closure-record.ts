import type {
  RepoFiles,
  RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { sharedWork } from "@plugins/packages/plugins/shared-work/core";
import { recordKey } from "./keys";
import {
  buildModuleGraph,
  NO_OUTSIDE_FILES,
  type BundledClosure,
} from "./module-graph";
import { npmCodeKey } from "./npm-identity";
import { codeIdentity } from "./code-identity";
import { currentRecordStore } from "./store";

/**
 * The answer of a process that LOADS repo modules — a probe script that
 * `require`s every schema file and reports what they declare — as a record:
 * keyed by the code that computes the answer, the modules of the file set it
 * loads, the input it is handed, the runtime and the npm code those closures
 * import. So the process runs once per distinct closure host-wide, and an edit
 * to a file outside every loaded closure is a lookup.
 *
 * Two kinds of module key it, and they are read from two different places:
 *
 *   - `code` — the PRODUCER: the modules whose code computes the answer (the
 *     module that spawns and reads the process, the probe script it runs), by
 *     URL (`import.meta.url`, or a URL resolved against it). Each is keyed by
 *     its code identity (`codeIdentity`), read from the checkout it lives in —
 *     the code that really runs, never a copy the file set happens to hold. A
 *     producer can only be named by URL, so it cannot be looked up in the set.
 *   - `data` — the modules OF THE FILE SET the process loads (schema files, a
 *     config the process `require`s), repo-relative, each by its Merkle key in
 *     the set.
 *
 * `data` must name every module of the set the process loads besides what
 * their static and dynamic imports reach — a module it loads by a computed
 * path is an input no key names. `input` is checkout-free plain data (a
 * repo-relative path, never an absolute one: a record is shared by every
 * checkout), and so is the answer. Only a success is stored: a failed run (a
 * crash, a timeout — a function of the host, not of the code) runs again next
 * time.
 *
 * A process that PARSES modules without running them — a `Bun.build` of one
 * entry, whose answer is the bundle (its tree-shaking) — names them as
 * `bundled`: the closure it parses, as `fileSetClosure` measured it (dynamic
 * edges cut or followed per edge, as the bundler does). Each member is keyed
 * by its path, its blob and its out-edges — and only those: a module the
 * bundler never reads (behind a cut `import()`) is no input, so an edit there
 * leaves the record standing, where `data`'s Merkle keys (static and dynamic
 * reach) would move. The out-edges are part of it because a bundle also
 * depends on what each specifier resolved to. The caller asserts on a miss
 * that the process parsed exactly `bundled.modules`: the key covers what the
 * graph says the bundler reads, and only that check proves the two agree.
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
    /** The producer's modules, by URL — read from the checkout they live in. */
    code: readonly string[];
    /** The set's modules the process loads, repo-relative. */
    data?: readonly string[];
    /** The modules a bundler parses (see above), keyed by content and edges only. */
    bundled?: Pick<BundledClosure, "modules" | "children">;
    input: unknown;
  },
  run: () => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
): Promise<{ ok: true; value: T; hit: boolean } | { ok: false; error: E }> {
  if (spec.code.length === 0)
    throw new Error(
      `[plugin-records] closure record ${spec.name} names no producer code: the code that computes a record is part of its key`,
    );
  const store = currentRecordStore();
  const input = { snapshot: repo, store, readOutside: NO_OUTSIDE_FILES };
  const data = [...(spec.data ?? [])].sort();
  const graph = await buildModuleGraph(input, data);
  const code = await Promise.all(
    spec.code.map((url) => codeIdentity(input, url, "closure-code")),
  );
  const key = recordKey(
    "closure-record",
    spec.name,
    store.environment,
    "code",
    ...code.sort(),
    "data",
    ...data.map((m) => `${m}=${graph.keyOf(m)}`),
    ...(spec.bundled === undefined
      ? []
      : await bundledKeyParts(repo, spec.bundled)),
    JSON.stringify(spec.input),
    await npmCodeKey(repo, graph.packages),
  );
  const stored = (await store.getMany("closure", [key])).get(key);
  if (stored !== undefined)
    return { ok: true, value: JSON.parse(stored) as T, hit: true };
  // Computing a record is shared work: its answer is every later caller's,
  // host-wide, so its file calls are the store's, never the caller's that
  // happened to miss first (`packages/shared-work`).
  const result = await sharedWork("plugin records", run);
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
