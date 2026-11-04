import {
  declarePluginSlots,
  declaredSlotSources,
  isSlot,
  moduleEvaluation,
  slotSite,
  slotSitesTracked,
  type SlotHandle,
  type SlotDeclaringPlugin,
} from "@plugins/framework/plugins/slot-declaration/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  importBarrel,
  registerBarrelStubs,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { recordKey } from "./keys";
import {
  buildModuleGraph,
  type ModuleGraph,
  type ModuleGraphInput,
} from "./module-graph";
import { reviveValue, serializeValue, type Json } from "./serialize";

/**
 * EVALUATED RECORDS: what importing a plugin barrel produced — its plugin
 * definition, with its slots, contributions and registrations — stored as data
 * under the barrel's module Merkle key, so a build reads it without importing
 * anything. Only a barrel whose closure changed (or that no worktree has
 * evaluated yet) is imported, live, in this process.
 *
 * Slots get an identity that needs no declaration pass: the module whose
 * top-level evaluation created the slot, and its ordinal among that module's
 * slots. A contribution records the identity of the slot it targets; the
 * naming (which plugin owns a slot, and so its id) is settled over the records
 * by the reader, exactly as a declaration pass settles it over live barrels.
 *
 * Two facts are not a function of one barrel's closure, and are recorded per
 * MODULE instead: the slots it created (what the orphan guard compares with
 * what is declared) and whether it subscribes to declaration passes. A barrel
 * whose own plugin subscribes (reorder's config registrations, pane's header
 * titles) fills its contributions from the WHOLE declared set; its declared
 * facts are a second record, keyed also by that set (see
 * {@link EvaluatedBarrels.resolveDeclarationDependent}).
 */

export type BarrelRuntime = "web" | "server" | "machine" | "central";

export interface BarrelRef {
  /** Repo-relative path of the barrel module. */
  path: string;
  pluginId: string;
  runtime: BarrelRuntime;
}

/** One evaluated barrel, as stored. */
interface EvaluatedRecord {
  module: Json;
  /** Its own plugin's modules subscribe to declaration passes. */
  dependent: boolean;
}

/** One module's evaluation facts, as stored. */
interface ModuleRecord {
  /** The slots its top-level evaluation created, by ordinal. */
  created: { ordinal: number; meta: Json }[];
  subscribes: boolean;
}

/** A slot created by an evaluated module, as the orphan guard reads it. */
export interface CreatedSlot {
  identity: string;
  module: string;
  meta: { kind: string; reorderable?: boolean };
}

/**
 * The code an evaluation runs besides the barrels': its identity is part of
 * every evaluated record's key. The stubs patch `globalThis` and stand in for
 * packages, so they shape what a barrel evaluates to.
 */
const EVALUATOR_MODULES = [
  "plugins/plugin-meta/plugins/plugin-records/core/internal/evaluate.ts",
  "plugins/plugin-meta/plugins/barrel-import/core/index.ts",
];

// ── Evaluation ────────────────────────────────────────────────────────────

export interface EvaluationInput extends ModuleGraphInput {
  /** A snapshot: the evaluated records are keyed by its blob ids. */
  snapshot: RepoSnapshot;
  /** The repo root as the runtime spells module paths (its realpath). */
  realRoot: string;
}

export interface EvaluatedBarrels {
  /** The revived module of an evaluated barrel: its `default` and its slot-bearing exports. */
  module(path: string): Record<string, unknown>;
  /** The slots the modules loaded with `paths` created (their static closure). */
  createdSlots(paths: Iterable<string>): CreatedSlot[];
  /** The identity of a slot stand-in this evaluation revived. */
  identityOf(slot: unknown): string | undefined;
  /**
   * Re-read every declaration-dependent barrel among `barrels` as it stands
   * after a declaration pass over all of `barrels` (`"source"` scope): from
   * its declared record, or — on a miss — by importing every barrel, running
   * the pass live and serializing again. Throws if a barrel NOT marked
   * dependent changed across the pass (its key would miss an input).
   */
  resolveDeclarationDependent(barrels: readonly BarrelRef[]): Promise<void>;
  /** How many barrels this evaluation imported live. */
  readonly imported: number;
}

function pluginDirOf(barrel: string): string {
  // `<plugin>/<runtime>/index.ts` — a barrel's folder is one level below its plugin.
  return barrel.split("/").slice(0, -2).join("/");
}

/**
 * Evaluated records for `barrels`: read from the store, imported live only
 * where one missed.
 */
export async function evaluateBarrels(
  input: EvaluationInput,
  barrels: readonly BarrelRef[],
): Promise<EvaluatedBarrels> {
  const { store, snapshot } = input;
  const graph = await buildModuleGraph(input, [
    ...EVALUATOR_MODULES,
    ...barrels.map((b) => b.path),
  ]);
  const evaluator = recordKey(
    "evaluator",
    ...EVALUATOR_MODULES.map((m) => graph.keyOf(m)),
    store.environment,
    snapshot.has("bun.lock") ? snapshot.blobOf("bun.lock") : "-",
  );
  const memo = (f: (p: string) => string) => {
    const m = new Map<string, string>();
    return (p: string): string => {
      let v = m.get(p);
      if (v === undefined) m.set(p, (v = f(p)));
      return v;
    };
  };
  const keyOf = memo((b) => recordKey(evaluator, "barrel", b, graph.keyOf(b)));
  const moduleKeyOf = memo((m) =>
    recordKey(evaluator, "module", m, graph.keyOf(m)),
  );

  const records = new Map<string, EvaluatedRecord>();
  for (const [k, v] of store.getMany(
    "evaluated",
    barrels.map((b) => keyOf(b.path)),
  ))
    records.set(k, JSON.parse(v) as EvaluatedRecord);

  const loaded = graph.staticClosureOf(barrels.map((b) => b.path));
  const moduleRecords = new Map<string, ModuleRecord>();
  for (const [k, v] of store.getMany("module", [...loaded].map(moduleKeyOf)))
    moduleRecords.set(k, JSON.parse(v) as ModuleRecord);

  // A barrel misses when its record does, or when a module it loads has no
  // module record (a store that lost one rebuilds it from the barrel).
  const unrecorded = new Set(
    [...loaded].filter((m) => !moduleRecords.has(moduleKeyOf(m))),
  );
  const missed = barrels.filter((b) => {
    if (!records.has(keyOf(b.path))) return true;
    if (unrecorded.size === 0) return false;
    for (const m of graph.staticClosure(b.path))
      if (unrecorded.has(m)) return true;
    return false;
  });

  const rel = (abs: string): string => {
    const prefix = `${input.realRoot}/`;
    if (!abs.startsWith(prefix))
      throw new Error(
        `[plugin-records] a slot was created by ${abs}, outside the repo: a slot is made at a repo module's top level`,
      );
    return abs.slice(prefix.length);
  };
  const metaOf = (slot: SlotHandle): Json => {
    const m = slot.meta as unknown as Record<string, unknown>;
    return serializeValue(
      {
        kind: m.kind,
        reorderable: m.reorderable,
        ...(m.companions ? { companions: m.companions } : {}),
        ...(m.pageWide ? { pageWide: true } : {}),
      },
      { slot: () => undefined },
    );
  };
  const serializeOptions = {
    slot(value: object) {
      if (!isSlot(value)) return undefined;
      const real = (value as SlotHandle)._slot ?? (value as SlotHandle);
      const site = slotSite(real);
      if (!site)
        throw new Error(
          "[plugin-records] a barrel exports a slot whose creation was not tracked (its module was evaluated before the first barrel import, or it was not made through `defineSlot`): it has no identity a record can name.",
        );
      return {
        identity: `${rel(site.module)}#${site.ordinal}`,
        meta: metaOf(real),
      };
    },
  };
  const serializeBarrel = (mod: Record<string, unknown>): Json => {
    const exports: Record<string, unknown> = {};
    for (const key of Object.keys(mod)) {
      if (key === "default") continue;
      let val: unknown;
      try {
        val = mod[key];
      } catch (err) {
        if (err instanceof ReferenceError) continue;
        throw err;
      }
      // A module with no default export declares through a named `slots`
      // (web-sdk's core seed): kept whole, as `declaredSlotSources` reads it.
      if (key === "slots" && mod.default === undefined) {
        exports.slots = val;
        continue;
      }
      if (isSlot(val)) {
        exports[key] = val;
        continue;
      }
      // Otherwise only its slot members: what the slots facet reads names from.
      if (val && (typeof val === "object" || typeof val === "function")) {
        const members: Record<string, unknown> = {};
        for (const m of Object.keys(val)) {
          let inner: unknown;
          try {
            inner = (val as Record<string, unknown>)[m];
          } catch (err) {
            if (err instanceof ReferenceError) continue;
            throw err;
          }
          if (isSlot(inner)) members[m] = inner;
        }
        if (Object.keys(members).length > 0) exports[key] = members;
      }
    }
    return serializeValue({ default: mod.default, exports }, serializeOptions);
  };

  let imported = 0;
  const live = new Map<string, Record<string, unknown>>();
  const importLive = async (b: BarrelRef): Promise<Record<string, unknown>> => {
    let mod = live.get(b.path);
    if (!mod) {
      mod = await importBarrel(`${input.realRoot}/${b.path}`);
      live.set(b.path, mod);
      imported++;
    }
    return mod;
  };

  if (missed.length > 0) {
    registerBarrelStubs(input.realRoot);
    for (const b of missed) await importLive(b);
    // Module facts for every module these imports loaded that has none yet.
    const fresh: [string, string][] = [];
    for (const b of missed) {
      for (const m of graph.staticClosure(b.path)) {
        const k = moduleKeyOf(m);
        if (moduleRecords.has(k)) continue;
        if (!slotSitesTracked())
          throw new Error("[plugin-records] slot sites are not tracked");
        const o = moduleEvaluation(`${input.realRoot}/${m}`);
        const rec: ModuleRecord = {
          created: o.created.map((slot, ordinal) => ({
            ordinal,
            meta: metaOf(slot),
          })),
          subscribes: o.subscribes,
        };
        moduleRecords.set(k, rec);
        fresh.push([k, JSON.stringify(rec)]);
      }
    }
    store.putMany("module", fresh);
    const freshBarrels: [string, string][] = [];
    for (const b of missed) {
      const dir = pluginDirOf(b.path);
      let dependent = false;
      for (const m of graph.staticClosure(b.path)) {
        if (!m.startsWith(`${dir}/`)) continue;
        if (moduleRecords.get(moduleKeyOf(m))!.subscribes) dependent = true;
      }
      const rec: EvaluatedRecord = {
        module: serializeBarrel(live.get(b.path)!),
        dependent,
      };
      records.set(keyOf(b.path), rec);
      freshBarrels.push([keyOf(b.path), JSON.stringify(rec)]);
    }
    store.putMany("evaluated", freshBarrels);
  }

  // ── Reading ──
  const stubs = new Map<string, SlotHandle>();
  const identities = new WeakMap<object, string>();
  const stubOf = (identity: string, meta: Json): SlotHandle => {
    let s = stubs.get(identity);
    if (!s) {
      const fail = (): never => {
        throw new Error(
          `[plugin-records] slot ${identity} was read from a record and cannot be rendered.`,
        );
      };
      const fn = Object.assign(fail, {
        meta: reviveValue(meta, { slot: () => undefined }),
        useContributions: fail,
      });
      s = fn as unknown as SlotHandle;
      stubs.set(identity, s);
      identities.set(s, identity);
    }
    return s;
  };
  const revived = new Map<string, Record<string, unknown>>();
  const resolved = new Map<string, EvaluatedRecord>();
  const recordOf = (path: string): EvaluatedRecord => {
    const r = resolved.get(path) ?? records.get(keyOf(path));
    if (!r) throw new Error(`[plugin-records] ${path} was not evaluated`);
    return r;
  };
  const reviveModule = (path: string): Record<string, unknown> => {
    let m = revived.get(path);
    if (!m) {
      const v = reviveValue(recordOf(path).module, { slot: stubOf }) as {
        default: unknown;
        exports: Record<string, unknown>;
      };
      m = {
        ...v.exports,
        ...(v.default === undefined ? {} : { default: v.default }),
      };
      revived.set(path, m);
    }
    return m;
  };

  return {
    get imported() {
      return imported;
    },
    module: reviveModule,
    identityOf: (slot) =>
      typeof slot === "function" || (typeof slot === "object" && slot !== null)
        ? identities.get(slot)
        : undefined,
    createdSlots(paths) {
      const modules = graph.staticClosureOf(paths);
      const out: CreatedSlot[] = [];
      for (const m of [...modules].sort()) {
        const rec = moduleRecords.get(moduleKeyOf(m));
        if (!rec) throw new Error(`[plugin-records] no module record for ${m}`);
        for (const c of rec.created)
          out.push({
            identity: `${m}#${c.ordinal}`,
            module: m,
            meta: reviveValue(c.meta, {
              slot: () => undefined,
            }) as CreatedSlot["meta"],
          });
      }
      return out;
    },
    async resolveDeclarationDependent(all) {
      const dependents = all.filter((b) => recordOf(b.path).dependent);
      if (dependents.length === 0) return;
      // The declared set as the records state it: every declaration, its
      // slot's identity, meta and creating module's content.
      const declared: string[] = [];
      for (const b of all) {
        const mod = reviveModule(b.path);
        const sources = declaredSlotSources(mod);
        if (!sources) continue;
        for (const [key, v] of Object.entries(
          sources as Record<string, unknown>,
        )) {
          const slots = isSlot(v)
            ? [v]
            : v && typeof v === "object"
              ? Object.values(v).filter(isSlot)
              : [];
          for (const s of slots) {
            const id = identities.get(s as object)!;
            const module = id.slice(0, id.lastIndexOf("#"));
            declared.push(
              `${b.pluginId}\t${key}\t${id}\t${graph.modules.get(module)?.blob ?? "-"}\t${JSON.stringify(s.meta)}`,
            );
          }
        }
      }
      const setHash = recordKey("declared", ...declared.sort());
      const declaredKey = (b: string): string =>
        recordKey(keyOf(b), "declared", setHash);
      const hits = store.getMany(
        "evaluated",
        dependents.map((b) => declaredKey(b.path)),
      );
      if (hits.size === dependents.length) {
        for (const b of dependents) {
          resolved.set(
            b.path,
            JSON.parse(hits.get(declaredKey(b.path))!) as EvaluatedRecord,
          );
          revived.delete(b.path);
        }
        return;
      }
      // A miss: the pass runs live, over every barrel, as the enriched tree's
      // did before records existed.
      registerBarrelStubs(input.realRoot);
      const mods = new Map<string, Record<string, unknown>>();
      for (const b of all) mods.set(b.path, await importLive(b));
      const before = new Map<string, string>();
      for (const b of all)
        if (!recordOf(b.path).dependent)
          before.set(
            b.path,
            JSON.stringify(serializeBarrel(mods.get(b.path)!)),
          );
      const declaring: SlotDeclaringPlugin[] = [];
      for (const b of all) {
        const slots = declaredSlotSources(mods.get(b.path)!);
        if (slots) declaring.push({ id: asPluginId(b.pluginId), slots });
      }
      declarePluginSlots(declaring, "source");
      for (const [path, text] of before) {
        if (JSON.stringify(serializeBarrel(mods.get(path)!)) !== text)
          throw new Error(
            `[plugin-records] ${path} changed across a declaration pass but its plugin does not subscribe to one: its evaluated record would miss an input.`,
          );
      }
      const fresh: [string, string][] = [];
      for (const b of dependents) {
        const rec: EvaluatedRecord = {
          module: serializeBarrel(mods.get(b.path)!),
          dependent: true,
        };
        resolved.set(b.path, rec);
        revived.delete(b.path);
        fresh.push([declaredKey(b.path), JSON.stringify(rec)]);
      }
      store.putMany("evaluated", fresh);
    },
  };
}

export type { ModuleGraph };
