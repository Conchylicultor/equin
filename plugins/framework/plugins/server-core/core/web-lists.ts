import type {
  Fact,
  WebListEntry,
} from "@plugins/framework/plugins/list-catalog/core";
import { composedWebPlugins } from "./composed-web-plugins";

// The server cannot see web slots, so what the browser's plugins add to a web
// list reaches it as the list catalog: the build's facts of every web list
// entry (`web-list-entries.generated.json`, codegen's `list-catalog-gen.ts`),
// each with the plugin that contributed it. Loaded ONCE per process, by the
// process root that knows its composition (`bin/serve.ts`, `cli/run-exec.ts`),
// beside `declareComposedWebPlugins` — never imported by a barrel, so a
// changed entry re-keys no plugin record. A read before that throws rather
// than answering for nobody.

let installed: ReadonlyMap<string, readonly WebListEntry[]> | null = null;

/**
 * Install the build's web-list entries (the generated table). Set by the
 * process root, once; never call it from plugin code.
 */
export function installWebListEntries(entries: readonly WebListEntry[]): void {
  const byList = new Map<string, WebListEntry[]>();
  for (const e of entries) {
    let list = byList.get(e.list);
    if (list === undefined) byList.set(e.list, (list = []));
    list.push(e);
  }
  installed = byList;
}

/** One web list entry's fact, with the web plugin that contributed it. */
export interface WebListFact<P> {
  /** The contributing web plugin's dot-form id. */
  plugin: string;
  fact: Fact<P>;
}

const kept = new Map<string, readonly WebListFact<unknown>[]>();

/**
 * The facts of web list `listId` (a web slot's id) whose contributing plugin
 * this composition's browser loads, in catalog order — what that list holds in
 * this composition's pages, as data. `P` is the list's entry type, owned by the
 * list's plugin (`Fact<P>` drops its code fields: a component is the plugin's,
 * never the catalog's). Memoized per list: the composition is fixed for the
 * process.
 *
 * Throws when the process installed no entries (`installWebListEntries`).
 */
export function webListFacts<P>(listId: string): readonly WebListFact<P>[] {
  if (installed === null) {
    throw new Error(
      `[list-catalog] webListFacts("${listId}") read before the process installed the build's web list entries — ` +
        "only a host that booted a composition registry (serve, exec) can answer what its browser's lists hold",
    );
  }
  let out = kept.get(listId);
  if (out === undefined) {
    const plugins = composedWebPlugins();
    const facts: readonly WebListFact<unknown>[] = (installed.get(listId) ?? [])
      .filter((e) => plugins.has(e.plugin))
      .map((e) => ({ plugin: e.plugin, fact: e.fact as Fact<unknown> }));
    kept.set(listId, facts);
    out = facts;
  }
  return out as readonly WebListFact<P>[];
}

/** Forget the installed entries. Test support (`core/testing`). */
export function clearWebListEntries(): void {
  installed = null;
  kept.clear();
}
