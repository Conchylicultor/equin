/**
 * Sizes "list entries as plain data": what every contribution of a
 * composition weighs once its code (functions, components) and its non-data
 * values (zod schemas, React elements) are cut out — the always-available
 * half of an entry in the design "a list entry without its plugin's code"
 * (wiki: Import time and lazy imports). Reads the build's evaluated records;
 * no barrel is imported when nothing changed.
 *
 *   ./equin run plugins/framework/plugins/tooling/plugins/codegen/scripts/measure-list-descriptions.ts [composition…]
 *
 * Per composition (main's and `website` by default): the web lists and the
 * server lists, each with its entry count, contributing plugins, raw JSON
 * bytes, and how many entries carry code. The totals are an UPPER bound for a
 * description table: nothing is projected, so a drizzle table or a config
 * descriptor is dumped whole.
 */
import { brotliCompressSync } from "node:zlib";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  classifyEdges,
  flattenManifest,
  resolveComposition,
} from "@plugins/plugin-meta/plugins/closure/core";
import { manifestItemToManifest } from "@plugins/plugin-meta/plugins/composition/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import {
  codegenPassOver,
  evaluateAllBarrels,
  evaluateWebBarrels,
  readCompositionManifestsFromDisk,
  recordSlotNaming,
  type BarrelEvaluation,
} from "../core";

const root = await getWorktreeRoot();
const pass = codegenPassOver(await loadRepoSnapshot(root));
const evAll = await evaluateAllBarrels(pass);
const evWeb = await evaluateWebBarrels(pass);
const naming = await recordSlotNaming(pass, "registry");

interface Cut {
  code: number;
  nonData: number;
}

/** The slot a stand-in names, when it is one. */
function slotIdOf(value: object): string | undefined {
  const lookup = naming.idOf(value as SlotHandle);
  return lookup.kind === "named" ? lookup.id : undefined;
}

/** `value` as plain data: a function, a slot and a non-data value become markers. */
function toData(value: unknown, cut: Cut, depth: number): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
    case "symbol":
      return String(value);
    case "function": {
      const slot = slotIdOf(value);
      if (slot !== undefined) return { $slot: slot };
      cut.code++;
      return { $code: 1 };
    }
    case "object":
    case "undefined":
      break;
  }
  const obj = value as object;
  // An elided record value (a zod schema, a React element) throws on any read
  // but its tag.
  if (Object.prototype.toString.call(obj) === "[object Elided]") {
    cut.nonData++;
    return { $nonData: 1 };
  }
  // The contribution itself (depth 0) carries its slot as `_slot`: only a
  // nested value is a slot reference.
  if (depth > 0) {
    const slot = slotIdOf(obj);
    if (slot !== undefined) return { $slot: slot };
  }
  if (Array.isArray(obj)) return obj.map((x) => toData(x, cut, depth + 1));
  if (obj instanceof Map)
    return [...obj].map(([k, x]) => [
      toData(k, cut, depth + 1),
      toData(x, cut, depth + 1),
    ]);
  if (obj instanceof Set) return [...obj].map((x) => toData(x, cut, depth + 1));
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof RegExp) return String(obj);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(obj)) {
    if (k === "_slot" || k === "_doc" || k === "_kind") continue;
    out[k] = toData(x, cut, depth + 1);
  }
  return out;
}

interface ListRow {
  entries: number;
  plugins: Set<string>;
  bytes: number;
  withCode: number;
  withNonData: number;
  json: string[];
}

type RawContribution = Record<string, unknown> & {
  _slot?: SlotHandle;
  _kind?: unknown;
};

function webList(c: RawContribution): string | undefined {
  if (c._slot === undefined) return undefined;
  return slotIdOf(c._slot) ?? "(slot outside the registry)";
}

function serverList(c: RawContribution): string | undefined {
  return typeof c._kind === "symbol" ? c._kind.description : undefined;
}

const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;

function measure(
  label: string,
  ev: BarrelEvaluation,
  bundle: ReadonlySet<string>,
  runtimes: readonly string[],
  listOf: (c: RawContribution) => string | undefined,
): void {
  const rows = new Map<string, ListRow>();
  for (const node of ev.tree.byDir.values()) {
    if (!bundle.has(asPluginId(node.id))) continue;
    for (const { mod, runtime } of ev.modulesOf(node)) {
      if (!runtimes.includes(runtime)) continue;
      const def = mod.default as
        { contributions?: RawContribution[] } | undefined;
      for (const c of def?.contributions ?? []) {
        const list = listOf(c);
        if (list === undefined) continue;
        const cut: Cut = { code: 0, nonData: 0 };
        const json = JSON.stringify({
          plugin: node.id,
          entry: toData(c, cut, 0),
        });
        let row = rows.get(list);
        if (row === undefined) {
          row = {
            entries: 0,
            plugins: new Set(),
            bytes: 0,
            withCode: 0,
            withNonData: 0,
            json: [],
          };
          rows.set(list, row);
        }
        row.entries++;
        row.plugins.add(node.id);
        row.bytes += json.length;
        row.json.push(json);
        if (cut.code > 0) row.withCode++;
        if (cut.nonData > 0) row.withNonData++;
      }
    }
  }
  const all = [...rows.values()];
  const text = all.flatMap((r) => r.json).join("\n");
  const dataOnly = all.filter((r) => r.withCode === 0 && r.withNonData === 0);
  const sum = (xs: ListRow[], f: (r: ListRow) => number): number =>
    xs.reduce((a, r) => a + f(r), 0);
  console.log(
    `\n== ${label}: ${rows.size} lists, ${sum(all, (r) => r.entries)} entries; as data ${kb(text.length)} raw, ${kb(brotliCompressSync(Buffer.from(text)).length)} brotli`,
  );
  console.log(
    `   lists whose entries are all plain data: ${dataOnly.length} (${sum(dataOnly, (r) => r.entries)} entries, ${kb(sum(dataOnly, (r) => r.bytes))} raw)`,
  );
  console.log(
    `   entries carrying code: ${sum(all, (r) => r.withCode)}; carrying a non-data value (schema, element): ${sum(all, (r) => r.withNonData)}`,
  );
  console.log("     bytes  entries  plugins  with-code  list");
  for (const [list, r] of [...rows]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 25)) {
    console.log(
      `   ${String(r.bytes).padStart(7)}  ${String(r.entries).padStart(7)}  ${String(r.plugins.size).padStart(7)}  ${String(r.withCode).padStart(9)}  ${list}`,
    );
  }
}

const items = readCompositionManifestsFromDisk(root);
const manifests = items.map(manifestItemToManifest);
const graph = classifyEdges(evAll.tree);
const asked = process.argv.slice(2);
const ids = asked.length > 0 ? asked : [MAIN_COMPOSITION_ID, "website"];
for (const id of ids) {
  const item = items.find((m) => m.id === id);
  if (item === undefined) {
    throw new Error(
      `no composition "${id}" (have: ${items.map((m) => m.id).join(", ")})`,
    );
  }
  const bundle: ReadonlySet<string> = resolveComposition(
    graph,
    flattenManifest(manifestItemToManifest(item), manifests),
  ).bundle;
  measure(`${id} — web lists`, evWeb, bundle, ["web"], webList);
  measure(
    `${id} — server lists`,
    evAll,
    bundle,
    ["server", "machine"],
    serverList,
  );
}
