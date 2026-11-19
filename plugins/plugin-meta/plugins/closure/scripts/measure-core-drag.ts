/**
 * Measures what a composition's closure costs because it is computed per
 * PLUGIN: an import of a plugin's light barrel (`core/`, `data-dirs/`,
 * `deps/`) ships its whole plugin — `web/` UI, `server/` endpoints and jobs,
 * `machine/` halves — and everything THOSE import.
 *
 *   ./equin run plugins/plugin-meta/plugins/closure/scripts/measure-core-drag.ts \
 *     [--composition <id>,…] [--top 30] [--edges 12] [--dist-links <file>] [--json <out>]
 *
 * For every composition (packs, main and base-exclusions skipped), under each
 * host it declares, three closures over the same edge graph:
 *
 *   plugin  — today's (`resolveComposition`'s bundle; re-derived here and
 *             asserted equal, so the counterfactuals share its semantics).
 *   barrel  — a light-barrel import ships only that barrel (and what the
 *             barrel imports — `core/` imports only `core/`, per the boundary
 *             table); any runtime-barrel import, token, companion, usage rule
 *             or seed still ships the whole plugin. "Option B".
 *   folder  — every barrel separately: an import of `x/web` ships x's web
 *             (+ what its boundary row lets it import of its own plugin),
 *             not its server/machine halves. The finer bound.
 *
 * Then the DRAG ranking: each plugin present only as a light barrel under
 * `barrel`, with its marginal cost — how many plugins become whole if that one
 * edge shipped the whole plugin (today's semantics) — and the importing sites
 * (plugin, folder, file, symbol). Bytes: web artifact bytes (from a dist's
 * links into the content-addressed store) and backend source bytes (server,
 * machine, central, shared, data-dirs, deps, core .ts/.tsx, tests excluded).
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { webArtifactsDir } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/data-dirs";
import { join, relative } from "node:path";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  buildRegistryGenContext,
  codegenPassOver,
  readCompositionManifestsFromDisk,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { manifestItemToManifest } from "@plugins/plugin-meta/plugins/composition/core";
import {
  ALL_EXCLUSIONS_ID,
  BASE_EXCLUSIONS_ID,
  MAIN_COMPOSITION_ID,
} from "@plugins/infra/plugins/namespace/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { crossRefsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/core";
import type { CrossRefsData } from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/core";
import {
  hostRuntimeFolders,
  type HostId,
  type PluginId,
  type RuntimeFolder,
} from "@plugins/framework/plugins/plugin-id/core";
import type { PluginTreeData } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  expandEntrySeeds,
  flattenManifest,
  graphForHosts,
  resolveComposition,
} from "../core";
import type { EdgeGraph } from "../core";

// ── args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const onlyIds = arg("composition")?.split(",");
const TOP = Number(arg("top") ?? 30);
const EDGES = Number(arg("edges") ?? 12);
const jsonOut = arg("json");
/** `--probe a.b,c.d`: print which halves of these plugins each composition
 *  ships, today vs the contract-aware closure (a plugin whose half a
 *  framework seam needs must keep it). */
const probe = arg("probe")?.split(",");

/** Light barrels: importing one reaches declarations, not a runtime half. */
const LIGHT: ReadonlySet<RuntimeFolder> = new Set([
  "core",
  "data-dirs",
  "deps",
]);
/** A plugin's own folders a reached folder may import (the boundary table's
 *  rows, own-plugin half) — what "folder" granularity ships with it. */
const OWN: Partial<Record<RuntimeFolder, RuntimeFolder[]>> = {
  web: ["web", "core", "shared"],
  server: ["server", "core", "shared", "data-dirs", "deps"],
  machine: ["machine", "server", "core", "shared", "data-dirs", "deps"],
  central: ["central", "core", "shared", "data-dirs", "deps"],
  core: ["core"],
  shared: ["shared", "core", "data-dirs"],
  "data-dirs": ["data-dirs", "core"],
  deps: ["deps", "core", "data-dirs"],
};
const BACKEND: RuntimeFolder[] = [
  "server",
  "machine",
  "central",
  "core",
  "shared",
  "data-dirs",
  "deps",
];

// ── inputs ───────────────────────────────────────────────────────────────
const root = await getWorktreeRoot();
const repo = await loadRepoSnapshot(root);
const { tree, graph } = await buildRegistryGenContext(codegenPassOver(repo));
const items = readCompositionManifestsFromDisk(root);
const manifests = items.map(manifestItemToManifest);

const nodes = [...(tree as PluginTreeData).byDir.values()];
/** Absolute plugin directories (`PluginNode.dir` is an absolute AppPath). */
const dirOf = new Map<PluginId, string>(
  nodes.map((n) => [n.id, String(n.dir)]),
);
/** The barrel folders each plugin actually has — a reached folder it lacks
 *  ships nothing, so a core-only plugin is the same under every mode. */
const foldersOf = new Map<PluginId, Set<RuntimeFolder>>(
  nodes.map((n) => [
    n.id,
    new Set(
      [...Object.keys(OWN), "web", "server", "machine", "central"].filter((f) =>
        existsSync(join(String(n.dir), f)),
      ) as RuntimeFolder[],
    ),
  ]),
);
const refsOf = new Map<PluginId, CrossRefsData | undefined>(
  nodes.map((n) => [n.id, getFacet(n, crossRefsFacetDef)]),
);

// ── contracts ────────────────────────────────────────────────────────────
/**
 * The factories whose result is a CONTRACT: a descriptor in `core/` that
 * means something only once the owner's runtime half serves or registers it.
 * Read from `export const X = <factory>(` in each plugin's light barrels — a
 * lower bound (a function wrapping a contract reads as a plain value).
 */
const CONTRACT_FACTORIES = new Set([
  "defineEndpoint",
  "liveValue",
  "liveCollection",
  "liveArm",
  "defineRoute",
  "defineApp",
  "defineConfig",
  "defineIdKind",
  "defineFieldType",
  "defineFieldIdentity",
  "defineBlock",
  "defineContainerBlock",
  "defineAnnotationBlock",
  "defineInlineTokenNode",
  "defineHint",
  "defineHintAnchor",
  "defineHintSignal",
  "defineCapability",
  "defineMandate",
  "defineLaunchOption",
  "defineTagTree",
  "tagTreeEntityRef",
  "entityRef",
  "defineExtensionShape",
  "defineDeploySecret",
  "defineReportSink",
  "defineRequestSink",
  "defineObservationSink",
  "defineVariantRegion",
  "defineIconFamily",
  "defineThreadResult",
  "defineSourceSet",
  "defineTokenGroup",
  "defineHostService",
]);
/** `<plugin>\0<symbol>` → the factory its `export const` calls. */
const factoryOf = new Map<string, string>();
const EXPORT_CONST = /^export const (\w+)(?::[^=]+)? = (\w+)(?:<[^(]*>)?\(/gm;
for (const n of nodes)
  for (const f of LIGHT) {
    const walk = (p: string) => {
      if (!existsSync(p)) return;
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const fp = join(p, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__" && e.name !== "testing") walk(fp);
        } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
          for (const m of readFileSync(fp, "utf8").matchAll(EXPORT_CONST))
            factoryOf.set(`${n.id}\0${m[1]}`, m[2]!);
      }
    };
    walk(join(String(n.dir), f));
  }
const isContract = (t: PluginId, symbol: string): boolean =>
  CONTRACT_FACTORIES.has(factoryOf.get(`${t}\0${symbol}`) ?? "");

// ── contract-aware closure: which half provides each contract ───────────
/**
 * The half of its owner that serves / registers a contract, by factory:
 * a SERVED contract is answered by the backend (server, machine, central),
 * a PAGE contract by the page (web), a REGISTERED one by whichever halves
 * register it (both, for configs and id kinds). Within the class the owner's
 * folders that actually NAME the symbol are its providers (a live value
 * served from `machine/` only ships `machine/`); none naming it ⇒ every
 * existing folder of the class (conservative).
 */
const BACKEND_HALVES: RuntimeFolder[] = ["server", "machine", "central"];
const PAGE_HALVES: RuntimeFolder[] = ["web"];
const ALL_HALVES: RuntimeFolder[] = ["web", "server", "machine", "central"];
const PROVIDER_CLASS: Record<string, RuntimeFolder[]> = {
  defineEndpoint: BACKEND_HALVES,
  liveValue: BACKEND_HALVES,
  liveCollection: BACKEND_HALVES,
  liveArm: BACKEND_HALVES,
  entityRef: BACKEND_HALVES,
  tagTreeEntityRef: BACKEND_HALVES,
  defineExtensionShape: BACKEND_HALVES,
  defineMandate: BACKEND_HALVES,
  defineCapability: BACKEND_HALVES,
  defineHostService: BACKEND_HALVES,
  defineDeploySecret: BACKEND_HALVES,
  defineSourceSet: BACKEND_HALVES,
  defineReportSink: BACKEND_HALVES,
  defineRequestSink: BACKEND_HALVES,
  defineObservationSink: BACKEND_HALVES,
  defineApp: PAGE_HALVES,
  defineRoute: PAGE_HALVES,
  defineFieldIdentity: PAGE_HALVES,
  defineHint: PAGE_HALVES,
  defineHintAnchor: PAGE_HALVES,
  defineHintSignal: PAGE_HALVES,
  defineTokenGroup: PAGE_HALVES,
  defineIconFamily: PAGE_HALVES,
  defineVariantRegion: PAGE_HALVES,
  defineInlineTokenNode: PAGE_HALVES,
};
const classOf = (factory: string): RuntimeFolder[] =>
  PROVIDER_CLASS[factory] ?? ALL_HALVES;

/** Source text of every non-test file of one (plugin, folder). */
const folderText = new Map<string, string[]>();
function textsOf(id: PluginId, folder: RuntimeFolder): string[] {
  const k = `${id}\0${folder}`;
  let out = folderText.get(k);
  if (out) return out;
  out = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const fp = join(p, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "testing") walk(fp);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
        out!.push(readFileSync(fp, "utf8"));
    }
  };
  walk(join(dirOf.get(id)!, folder));
  folderText.set(k, out);
  return out;
}

/** `<plugin>\0<symbol>` → the export's own body (for wrapper detection). */
const bodyOf = new Map<string, string>();
const EXPORT_ANY = /^export (?:async )?(?:function|const|class) (\w+)/gm;
for (const n of nodes)
  for (const f of LIGHT)
    for (const t of textsOf(n.id, f))
      for (const m of t.matchAll(EXPORT_ANY)) {
        const rest = t.slice(m.index);
        const end = /\n(?=[^\s}\])])/.exec(rest.slice(1));
        bodyOf.set(
          `${n.id}\0${m[1]}`,
          end ? rest.slice(0, end.index + 1) : rest,
        );
      }

/**
 * HIDDEN COUPLINGS, as their fixes would declare them (see the design doc):
 * a plugin whose `core/` works only once its own half ran ships that half
 * with any import of its core. `runtime-profiler`: the recorder's runtimes
 * become a host service its `server/` provides. Field kinds: `Fields.Renderer`
 * / `Fields.Sample` become keyed companions, so a field kind's `web/` ships
 * with its core (modelled here as every `Fields.Renderer` contributor).
 */
const COUPLED = new Map<PluginId, RuntimeFolder[]>([
  ["infra.runtime-profiler" as PluginId, ["server"]],
]);
for (const n of nodes)
  for (const t of textsOf(n.id, "web"))
    if (
      /Fields\.(?:Renderer|Sample)\(/.test(t) &&
      t.includes("satisfies PluginDefinition")
    )
      COUPLED.set(n.id, [...(COUPLED.get(n.id) ?? []), "web"]);

/**
 * The halves a light-barrel import of `symbol` from `t` brings beside the
 * barrel itself: a contract's providers, a wrapper's (an export whose body
 * names one of its plugin's contracts, to a fixpoint), a coupled plugin's
 * declared halves. Empty ⇒ a plain value: the barrel alone.
 */
const providersMemo = new Map<string, RuntimeFolder[]>();
function providersOf(
  t: PluginId,
  symbol: string,
  seen = new Set<string>(),
): RuntimeFolder[] {
  const k = `${t}\0${symbol}`;
  const memo = providersMemo.get(k);
  if (memo) return memo;
  if (seen.has(k)) return [];
  seen.add(k);
  const out = new Set<RuntimeFolder>(COUPLED.get(t) ?? []);
  const factory = factoryOf.get(k);
  const has = foldersOf.get(t)!;
  if (factory && CONTRACT_FACTORIES.has(factory)) {
    const cls = classOf(factory).filter((h) => has.has(h));
    const word = new RegExp(`(?<![\\w.])${symbol}\\b`);
    const naming = cls.filter((h) => textsOf(t, h).some((x) => word.test(x)));
    for (const h of naming.length > 0 ? naming : cls) out.add(h);
  } else {
    const body = bodyOf.get(k);
    if (body)
      for (const m of body.matchAll(/\b(\w+)\b/g))
        if (m[1] !== symbol && bodyOf.has(`${t}\0${m[1]}`))
          for (const h of providersOf(t, m[1]!, seen)) out.add(h);
  }
  const list = [...out];
  providersMemo.set(k, list);
  return list;
}

// ── bytes ────────────────────────────────────────────────────────────────
function pickDistLinks(): string | undefined {
  const explicit = arg("dist-links");
  if (explicit) return explicit;
  const dir = String(webArtifactsDir.file("dist-links"));
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  // The newest dist holding the whole fleet's page artifacts (a worktree
  // build: ~one artifact per web/core barrel, not a composition subset).
  for (const f of files.slice(0, 60)) {
    const d = JSON.parse(readFileSync(f, "utf8")) as {
      dirs: Record<string, string[]>;
    };
    const store = Object.entries(d.dirs).find(([k]) => k.endsWith("/store"));
    if (store && store[1].filter((n) => !n.endsWith(".worker")).length > 2000)
      return f;
  }
  return undefined;
}

/** `<id>.<folder>` → bytes of the emitted JS/CSS (raw and brotli). */
const webBytes = new Map<string, { raw: number; br: number }>();
const distLinks = pickDistLinks();
if (distLinks) {
  const d = JSON.parse(readFileSync(distLinks, "utf8")) as {
    dirs: Record<string, string[]>;
  };
  for (const [storeDir, names] of Object.entries(d.dirs)) {
    if (!storeDir.endsWith("/store")) continue;
    for (const name of new Set(names)) {
      if (name.endsWith(".worker")) continue;
      const m = /^(.*)\.([a-z-]+)\.[0-9a-f]{16}$/.exec(name);
      if (!m) continue;
      let raw = 0;
      let br = 0;
      const walk = (p: string, depth: number) => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const fp = join(p, e.name);
          if (e.isDirectory()) {
            if (depth < 3) walk(fp, depth + 1);
          } else if (/\.(m?js|css)$/.test(e.name)) raw += statSync(fp).size;
          else if (/\.(m?js|css)\.br$/.test(e.name)) br += statSync(fp).size;
        }
      };
      const p = join(storeDir, name);
      if (existsSync(p)) walk(p, 0);
      webBytes.set(`${m[1]}.${m[2]}`, { raw, br });
    }
  }
}

/** Backend source bytes per (plugin, folder): its .ts/.tsx, tests excluded. */
const srcBytes = new Map<string, number>();
for (const n of nodes) {
  for (const f of BACKEND) {
    const base = join(String(n.dir), f);
    if (!existsSync(base)) continue;
    let total = 0;
    const walk = (p: string) => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        if (e.name === "__tests__" || e.name === "testing") continue;
        const fp = join(p, e.name);
        if (e.isDirectory()) walk(fp);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
          total += statSync(fp).size;
      }
    };
    walk(base);
    srcBytes.set(`${n.id}.${f}`, total);
  }
}

// ── closures ─────────────────────────────────────────────────────────────
type Reach = Map<PluginId, Set<RuntimeFolder>>;

interface Mode {
  /** What reaching barrel `b` of plugin `target` ships of it. */
  ships(
    target: PluginId,
    b: RuntimeFolder,
    folders: ReadonlySet<RuntimeFolder>,
    symbol: string | undefined,
  ): RuntimeFolder[];
}
const allOf = (folders: ReadonlySet<RuntimeFolder>) => [...folders];
const lightOf = (b: RuntimeFolder, folders: ReadonlySet<RuntimeFolder>) =>
  OWN[b]!.filter((f) => folders.has(f));
const PLUGIN: Mode = { ships: (_t, _b, folders) => allOf(folders) };
const BARREL: Mode = {
  ships: (_t, b, folders) =>
    LIGHT.has(b) ? lightOf(b, folders) : allOf(folders),
};
const FOLDER: Mode = {
  ships: (_t, b, folders) => (OWN[b] ?? [b]).filter((f) => folders.has(f)),
};
/**
 * Option B made sound: a light-barrel import ships light only when the
 * symbol it binds is a plain value — never a CONTRACT (a descriptor its
 * owner's runtime half serves or registers: an endpoint, a live value, an
 * app or route, a config, an id kind, …) nor an unnamed import.
 */
const CONTRACT_AWARE: Mode = {
  ships: (t, b, folders, symbol) =>
    LIGHT.has(b) && symbol !== undefined && !isContract(t, symbol)
      ? lightOf(b, folders)
      : allOf(folders),
};
/**
 * The CONTRACT-AWARE CLOSURE (design B′): a light-barrel import ships the
 * barrel plus, when its symbol is a contract (or wraps one, or its plugin is
 * coupled), only the half that provides it — never the whole plugin. An
 * unnamed import (namespace, side effect) still ships the whole plugin.
 */
const CONTRACT_HALF: Mode = {
  ships: (t, b, folders, symbol) => {
    if (!LIGHT.has(b)) return allOf(folders);
    if (symbol === undefined) return allOf(folders);
    const out = new Set(lightOf(b, folders));
    for (const h of providersOf(t, symbol))
      for (const f of OWN[h] ?? [h]) if (folders.has(f)) out.add(f);
    return [...out];
  },
};
/** Option A after all its splits: the pure values of these plugins moved to
 *  core-only leaves, so a light import of them binding no contract ships
 *  light; everything else per plugin, as today. */
const A_SPLITS = new Set<string>([
  "debug.timeline",
  "debug.sentinel.machine-usage",
  "debug.browser-recordings",
  "infra.launcher",
  "conversations.model-provider",
  "reports.render-loop",
  "plugin-meta.exhibits",
]);
const A_AFTER: Mode = {
  ships: (t, b, folders, symbol) =>
    A_SPLITS.has(t) &&
    LIGHT.has(b) &&
    symbol !== undefined &&
    !isContract(t, symbol)
      ? lightOf(b, folders)
      : allOf(folders),
};
/** CONTRACT_AWARE, but a reference to another app or route (`defineApp`,
 *  `defineRoute`) ships light — cross-app navigation as an optional edge,
 *  drawn only when the destination is in the composition. */
const NAV_SOFT_FACTORIES = new Set(["defineApp", "defineRoute"]);
const NAV_SOFT: Mode = {
  ships: (t, b, folders, symbol) =>
    LIGHT.has(b) &&
    symbol !== undefined &&
    (!isContract(t, symbol) ||
      NAV_SOFT_FACTORIES.has(factoryOf.get(`${t}\0${symbol}`) ?? ""))
      ? lightOf(b, folders)
      : allOf(folders),
};
/** Today's semantics, but light-barrel imports of `only` ship light: what
 *  splitting that ONE plugin (or barrel-granularity for it alone) saves. */
const barrelFor = (only: PluginId): Mode => ({
  ships: (t, b, folders) =>
    t === only && LIGHT.has(b) ? lightOf(b, folders) : allOf(folders),
});

/**
 * The closure over (plugin, folder) under `mode`, from `whole` seeds (every
 * folder of each). Imports are read per reached folder from cross-refs;
 * tokens and companions from the host view's hard edges (they ship the
 * named runtime — the whole plugin under PLUGIN/BARREL); usage rules fire
 * once their owner and a user are present, shipping the companion whole.
 */
function closure(
  view: EdgeGraph,
  host: HostId[],
  whole: Iterable<PluginId>,
  mode: Mode,
): Reach {
  const folders = hostRuntimeFolders(host);
  const reach: Reach = new Map();
  const stack: [PluginId, RuntimeFolder][] = [];
  const add = (id: PluginId, fs: RuntimeFolder[]) => {
    let set = reach.get(id);
    if (!set) reach.set(id, (set = new Set()));
    const has = foldersOf.get(id)!;
    for (const f of fs)
      if (has.has(f) && !set.has(f)) {
        set.add(f);
        stack.push([id, f]);
      }
  };
  const nonImport = new Map<PluginId, { to: PluginId; rt: RuntimeFolder }[]>();
  for (const e of view.edges) {
    if (e.kind !== "hard" || e.via === "import") continue;
    const list = nonImport.get(e.from) ?? [];
    for (const rt of e.runtimes) list.push({ to: e.to, rt });
    nonImport.set(e.from, list);
  }
  for (const id of whole) add(id, allOf(folders));
  let rules = view.rules;
  for (;;) {
    while (stack.length) {
      const [id, f] = stack.pop()!;
      for (const use of refsOf.get(id)?.apiUses[f] ?? []) {
        if (use.plugin === id || !dirOf.has(use.plugin)) continue;
        add(
          use.plugin,
          mode.ships(use.plugin, use.barrel, folders, use.symbol),
        );
      }
      // Tokens / companions hold through a folder of `from`: follow them
      // from that folder (a token from web, a server companion from server).
      for (const e of nonImport.get(id) ?? [])
        if (e.rt === f) add(e.to, mode === FOLDER ? [e.rt] : allOf(folders));
    }
    const fired = rules.filter(
      (r) => reach.has(r.owner) && r.users.some((u) => reach.has(u)),
    );
    if (fired.length === 0) break;
    rules = rules.filter((r) => !fired.includes(r));
    for (const r of fired)
      add(r.then, mode === FOLDER ? ["web"] : allOf(folders));
  }
  return reach;
}

/** Whether a reached plugin ships runtime code: one of its web / server /
 *  machine / central halves (what registers slots, endpoints, jobs). */
const RUNTIME_HALVES: ReadonlySet<RuntimeFolder> = new Set([
  "web",
  "server",
  "machine",
  "central",
]);
const isWhole = (set: Set<RuntimeFolder>) =>
  [...set].some((f) => RUNTIME_HALVES.has(f));
const halvesOf = (r: Reach) =>
  [...r.values()].reduce(
    (n, set) => n + [...set].filter((f) => RUNTIME_HALVES.has(f)).length,
    0,
  );
const wholeIds = (r: Reach) =>
  new Set([...r].filter(([, s]) => isWhole(s)).map(([id]) => id));

function bytesOf(r: Reach): { web: number; webBr: number; backend: number } {
  let web = 0;
  let webBr = 0;
  let backend = 0;
  for (const [id, set] of r)
    for (const f of set) {
      const w = webBytes.get(`${id}.${f}`);
      if (w && (f === "web" || f === "core")) {
        web += w.raw;
        webBr += w.br;
      }
      backend += srcBytes.get(`${id}.${f}`) ?? 0;
    }
  return { web, webBr, backend };
}

/** Which files of `importer/folder` import `target/barrel`, and what. */
function importSites(
  importer: PluginId,
  folder: RuntimeFolder,
  target: PluginId,
  barrel: RuntimeFolder,
): string[] {
  // `@plugins/<fs path under plugins/>/<barrel>`.
  const spec = `@${relative(root, dirOf.get(target)!)}/${barrel}`;
  const base = join(dirOf.get(importer)!, folder);
  const out: string[] = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const fp = join(p, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "testing") walk(fp);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        const src = readFileSync(fp, "utf8");
        if (src.includes(`"${spec}"`) || src.includes(`'${spec}'`))
          out.push(fp.slice(root.length + 1));
      }
    }
  };
  walk(base);
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────
interface Row {
  id: string;
  host: HostId;
  plugin: { present: number; whole: number };
  barrel: { present: number; whole: number; lightOnly: number };
  folder: { present: number; withRuntime: number };
  contract: { present: number; whole: number };
  navSoft: { present: number; whole: number };
  contractHalf: { present: number; whole: number };
  aAfter: { present: number; whole: number };
  bytes: Record<
    | "plugin"
    | "barrel"
    | "contract"
    | "navSoft"
    | "contractHalf"
    | "aAfter"
    | "folder",
    ReturnType<typeof bytesOf>
  >;
  /** Runtime halves shipped ((plugin, web|server|machine|central) pairs). */
  halves: Record<"plugin" | "contract" | "aAfter" | "contractHalf", number>;
  drags: Drag[];
}
interface Drag {
  target: PluginId;
  /** Plugins that become whole if T alone shipped whole, all else per-barrel. */
  marginal: number;
  /** Whole plugins today's closure sheds if T alone shipped per-barrel. */
  alone: number;
  sites: {
    importer: PluginId;
    folder: RuntimeFolder;
    barrel: RuntimeFolder;
    symbols: string[];
  }[];
}

const rows: Row[] = [];
for (const item of items) {
  if (item.category === "pack") continue;
  if (
    item.id === MAIN_COMPOSITION_ID ||
    item.id === BASE_EXCLUSIONS_ID ||
    item.id === ALL_EXCLUSIONS_ID
  )
    continue;
  if (onlyIds && !onlyIds.includes(item.id)) continue;
  const flat = flattenManifest(manifestItemToManifest(item), manifests);
  for (const host of flat.hosts) {
    const view = graphForHosts(graph, [host]);
    const resolved = resolveComposition(graph, flat, host);
    const { seeds } = expandEntrySeeds(flat, graph, host);
    const whole = [
      ...seeds,
      ...flat.selectedContributors,
      // resolveComposition also seeds what the host's process root runs (ac6aa97cc5).
      ...[...view.hostRoots.values()].flat(),
    ];
    const p = closure(view, [host], whole, PLUGIN);
    if (p.size !== resolved.bundle.size)
      throw new Error(
        `${item.id}/${host}: re-derived plugin closure ${p.size} ≠ resolveComposition ${resolved.bundle.size} — the counterfactual would not share its semantics.`,
      );
    const b = closure(view, [host], whole, BARREL);
    const f = closure(view, [host], whole, FOLDER);
    const c = closure(view, [host], whole, CONTRACT_AWARE);
    const n = closure(view, [host], whole, NAV_SOFT);
    const ch = closure(view, [host], whole, CONTRACT_HALF);
    const aa = closure(view, [host], whole, A_AFTER);
    if (probe)
      for (const id of probe) {
        const today =
          [...(p.get(id as PluginId) ?? [])].sort().join("+") || "-";
        const next =
          [...(ch.get(id as PluginId) ?? [])].sort().join("+") || "-";
        if (today !== next)
          console.log(`probe ${item.id}/${host} ${id}: ${today} → ${next}`);
      }
    const bWhole = wholeIds(b);
    const pWhole = wholeIds(p).size;
    const light = [...b.keys()].filter((id) => !bWhole.has(id));

    const drags: Drag[] = [];
    for (const t of light) {
      const withT = wholeIds(closure(view, [host], [...bWhole, t], BARREL));
      const marginal = withT.size - bWhole.size;
      // Against TODAY: the whole plugins that leave if only T's light
      // barrels shipped light (split T, everything else per-plugin).
      const alone =
        pWhole - wholeIds(closure(view, [host], whole, barrelFor(t))).size;
      const sites: Drag["sites"] = [];
      for (const [importer, set] of b)
        for (const folder of set)
          for (const use of refsOf.get(importer)?.apiUses[folder] ?? [])
            if (use.plugin === t && importer !== t) {
              let s = sites.find(
                (x) =>
                  x.importer === importer &&
                  x.folder === folder &&
                  x.barrel === use.barrel,
              );
              if (!s)
                sites.push(
                  (s = { importer, folder, barrel: use.barrel, symbols: [] }),
                );
              const sym = use.symbol
                ? isContract(t, use.symbol)
                  ? `${use.symbol}*`
                  : use.symbol
                : "<unnamed>";
              if (!s.symbols.includes(sym)) s.symbols.push(sym);
            }
      drags.push({ target: t, marginal, alone, sites });
    }
    drags.sort((x, y) => y.alone - x.alone || y.marginal - x.marginal);
    rows.push({
      id: item.id,
      host,
      plugin: { present: p.size, whole: pWhole },
      barrel: { present: b.size, whole: bWhole.size, lightOnly: light.length },
      contract: { present: c.size, whole: wholeIds(c).size },
      navSoft: { present: n.size, whole: wholeIds(n).size },
      contractHalf: { present: ch.size, whole: wholeIds(ch).size },
      aAfter: { present: aa.size, whole: wholeIds(aa).size },
      folder: {
        present: f.size,
        withRuntime: [...f.values()].filter(isWhole).length,
      },
      bytes: {
        plugin: bytesOf(p),
        barrel: bytesOf(b),
        contract: bytesOf(c),
        navSoft: bytesOf(n),
        contractHalf: bytesOf(ch),
        aAfter: bytesOf(aa),
        folder: bytesOf(f),
      },
      halves: {
        plugin: halvesOf(p),
        contract: halvesOf(c),
        aAfter: halvesOf(aa),
        contractHalf: halvesOf(ch),
      },
      drags,
    });
  }
}

// ── report ───────────────────────────────────────────────────────────────
const kb = (n: number) => `${(n / 1024).toFixed(0)}K`;
console.log(
  `dist links: ${distLinks ?? "(none — web bytes are 0)"}\n\n` +
    "plugins: present = in the closure; runtime = ships a web/server/machine/central half (slots, endpoints, jobs); light = present only as core/data-dirs/deps\n" +
    "contract = barrel, but an import binding a contract (* in the sites below: endpoint, live value, app, route, config, id kind, …) or nothing nameable still ships the whole plugin\n" +
    "nav = contract, but an app / route reference ships light (cross-app links optional)\n" +
    "composition/host          plugin: present (runtime) | barrel: present (runtime + light) | contract | nav | folder: runtime | web raw (br) plugin→barrel→contract→nav→folder | backend src plugin→barrel→contract→nav→folder",
);
for (const r of rows)
  console.log(
    `${`${r.id}/${r.host}`.padEnd(28)}${String(r.plugin.present).padStart(5)} (${String(r.plugin.whole).padStart(4)}) | ` +
      `${String(r.barrel.present).padStart(5)} (${String(r.barrel.whole).padStart(4)} +${String(r.barrel.lightOnly).padStart(4)}) | ` +
      `${String(r.contract.whole).padStart(5)} | ${String(r.navSoft.whole).padStart(4)} | ${String(r.folder.withRuntime).padStart(5)} | ` +
      `${kb(r.bytes.plugin.web)} (${kb(r.bytes.plugin.webBr)}) → ${kb(r.bytes.barrel.web)} → ${kb(r.bytes.contract.web)} → ${kb(r.bytes.navSoft.web)} → ${kb(r.bytes.folder.web)} | ` +
      `${kb(r.bytes.plugin.backend)} → ${kb(r.bytes.barrel.backend)} → ${kb(r.bytes.contract.backend)} → ${kb(r.bytes.navSoft.backend)} → ${kb(r.bytes.folder.backend)}`,
  );

// The design comparison: today, option A after its splits, sound B (a
// contract ships its whole plugin), and the contract-aware closure B′ (a
// contract ships only its provider half).
console.log(
  "\nCOMPARISON — runtime plugins / runtime halves / web KB / backend src KB\n" +
    "composition/host            today                    | A after splits           | sound B                  | contract-aware B′",
);
const cell = (w: number, h: number, b: ReturnType<typeof bytesOf>) =>
  `${String(w).padStart(4)} / ${String(h).padStart(4)} / ${kb(b.web).padStart(6)} / ${kb(b.backend).padStart(6)}`;
for (const r of rows)
  console.log(
    `${`${r.id}/${r.host}`.padEnd(28)}${cell(r.plugin.whole, r.halves.plugin, r.bytes.plugin)} | ` +
      `${cell(r.aAfter.whole, r.halves.aAfter, r.bytes.aAfter)} | ` +
      `${cell(r.contract.whole, r.halves.contract, r.bytes.contract)} | ` +
      `${cell(r.contractHalf.whole, r.halves.contractHalf, r.bytes.contractHalf)}`,
  );

// How the contract-aware rule classifies every symbol imported cross-plugin
// through a light barrel (unique target × symbol).
{
  const seen = new Set<string>();
  const by = { factory: 0, wrapper: 0, coupled: 0, plain: 0, unnamed: 0 };
  const byFactory = new Map<string, number>();
  for (const id of dirOf.keys())
    for (const rt of Object.keys(OWN) as RuntimeFolder[])
      for (const use of refsOf.get(id)?.apiUses[rt] ?? []) {
        if (!LIGHT.has(use.barrel) || use.plugin === id) continue;
        const k = `${use.plugin}\0${use.symbol ?? "*"}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (use.symbol === undefined) by.unnamed++;
        else if (isContract(use.plugin, use.symbol)) {
          by.factory++;
          const fac = factoryOf.get(k)!;
          byFactory.set(fac, (byFactory.get(fac) ?? 0) + 1);
        } else if (providersOf(use.plugin, use.symbol).length === 0) by.plain++;
        else if (COUPLED.has(use.plugin)) by.coupled++;
        else by.wrapper++;
      }
  console.log(
    `\nlight-barrel symbols imported cross-plugin: ${seen.size} — contract ${by.factory}, wrapper of a contract ${by.wrapper}, coupled plugin ${by.coupled}, plain value ${by.plain}, unnamed ${by.unnamed}`,
  );
  console.log(
    "  contracts imported, by factory: " +
      [...byFactory]
        .sort((a, b) => b[1] - a[1])
        .map(([f, n]) => `${f} ${n}`)
        .join(", "),
  );
}

// Aggregate drag across desktop compositions: one line per target.
const agg = new Map<
  PluginId,
  {
    total: number;
    max: number;
    marginal: number;
    per: string[];
    sites: Map<string, Drag["sites"][number]>;
  }
>();
for (const r of rows) {
  if (r.host !== "desktop") continue;
  for (const d of r.drags) {
    if (d.alone === 0 && d.marginal === 0) continue;
    let a = agg.get(d.target);
    if (!a)
      agg.set(
        d.target,
        (a = { total: 0, max: 0, marginal: 0, per: [], sites: new Map() }),
      );
    a.total += d.alone;
    a.max = Math.max(a.max, d.alone);
    a.marginal += d.marginal;
    a.per.push(`${r.id}:${d.alone}`);
    for (const s of d.sites) {
      const k = `${s.importer}/${s.folder}->${s.barrel}`;
      const prev = a.sites.get(k);
      if (!prev) a.sites.set(k, { ...s, symbols: [...s.symbols] });
      else
        for (const y of s.symbols)
          if (!prev.symbols.includes(y)) prev.symbols.push(y);
    }
  }
}
// Ranked by the worst single composition (what a per-composition guard
// sees), then by the sum.
const ranked = [...agg]
  .sort((x, y) => y[1].max - x[1].max || y[1].total - x[1].total)
  .slice(0, TOP);
console.log(
  `\nTop ${TOP} drag targets (desktop). max / Σalone = runtime-bearing plugins today's closure sheds (worst composition / summed) if ONLY this target's light-barrel imports shipped light (split it), summed over desktop compositions; Σmarginal = plugins it re-adds on top of a full barrel closure`,
);
for (const [t, a] of ranked) {
  console.log(
    `\n${t}  max ${a.max}  Σalone ${a.total}  Σmarginal ${a.marginal}  [${a.per.join(" ")}]`,
  );
  for (const s of [...a.sites.values()].slice(0, EDGES)) {
    const files = importSites(s.importer, s.folder, t, s.barrel);
    console.log(
      `   ${s.importer} ${s.folder}/ → ${s.barrel}  {${s.symbols.join(", ")}}  ${files.join(" ")}`,
    );
  }
  if (a.sites.size > EDGES)
    console.log(`   … ${a.sites.size - EDGES} more importers`);
}

if (jsonOut) {
  await Bun.write(
    jsonOut,
    JSON.stringify(
      {
        distLinks,
        rows: rows.map((r) => ({
          ...r,
          drags: r.drags.filter((d) => d.alone > 0 || d.marginal > 0),
        })),
      },
      null,
      1,
    ),
  );
  console.log(`\nwrote ${jsonOut}`);
}
