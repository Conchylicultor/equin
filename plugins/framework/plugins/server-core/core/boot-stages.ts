import {
  asPluginId,
  isMachineNode,
  machineNode,
  pluginOfNode,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  computeLoadWaves,
  topoSortPlugins,
} from "@plugins/framework/plugins/plugin-loader/core";
import { setBootMode, setRegisteringPlugin } from "./boot-mode";
import { assertHostServices } from "./host-service";
import { collectContributions } from "./contributions";
import { profilerStart, recordMemoryCheckpoint } from "./profiler";
import {
  assertPreloadedResourcesDeclared,
  bindDeferredResources,
} from "./resources";
import type { LoadedServerPlugin, ServerPluginDefinition } from "./types";

// ── The boot sequence, once, for both boot MODES ────────────────────────────
//
// A backend process boots in one of two modes, and they share this file so they
// cannot drift:
//
// - `serve` — the gateway-spawned, long-lived backend (`../bin/index.ts`). Runs
//   every phase: this file's sequence, plus the socket bind interleaved into it
//   and the post-serving phases (`onReady`, `onAllReady`, `drainWarmups`) after
//   it.
// - `exec` — a short-lived process that runs ONE registered piece of work and
//   exits (`../cli/run-exec.ts`). Runs the sequence in this file and nothing else.
//
// The mode split is stated as a discriminated union (`BootSpec`) rather than a
// boolean, so the one phase that differs INSIDE the sequence — serve binding its
// socket between contribution collection and the ready barrier — is spellable
// only by `serve`. See `../cli/run-exec.ts` for what `exec` skips and why each
// skipped phase would be wrong in a short-lived process.
//
// A SECOND COPY of this sequence is the failure mode this file exists to
// prevent: a recovery/secondary path that nothing exercises until something has
// already gone wrong is the path that rots (see
// research/2026-09-01-global-supervised-run-survives-restart.md). Add a phase
// here, not in one of the two composition roots, unless it is genuinely
// serve-only.
//
// WHY A NON-BARREL `core/` FILE: `core/` is this plugin's public API, and its
// barrel is imported by nearly every server plugin — putting the boot sequence
// BEHIND the barrel would make the plugin loader statically reachable from a
// barrel a web file is allowed to import. So this file is not on the barrel:
// the two composition roots (`../bin/index.ts`, `../cli/run-exec.ts`) import it
// by path, and the one other host — a test booting a graph of its own (the
// portable boot test) — reaches it through `core/testing`. It is in `core/`
// rather than `shared/` because the sequence is portable (every import here is
// `core`), and a host that boots a portable graph without the computer needs
// it; `shared/` is unreachable from any other plugin (R10).

/**
 * One row of a generated backend registry (`core/server.generated.ts`'s or
 * `core/machine.generated.ts`'s `CollectedEntry`). Restated structurally so
 * this file does not import the generated registry — the composition root
 * passes the ACTIVE registries in, which is also what lets a filtered
 * composition registry boot unchanged.
 *
 * A desktop host passes `[...serverEntries, ...machineEntries]`: one graph.
 * A machine row's id is `<id>#machine` and its `dependsOn` names graph nodes
 * (`x` for a server half, `x#machine` for a machine half — see `machineNode`).
 */
export interface ServerRegistryEntry {
  pluginPath: string;
  id: string;
  loader: () => Promise<{ default: unknown }>;
  dependsOn: string[];
}

export type BootSpec = {
  entries: ServerRegistryEntry[];
  /**
   * Whether `plugins/<pluginPath>/core/index.ts` exists on disk. Supplied by the
   * composition root because answering it needs `PLUGINS_DIR` from `paths/core`
   * — and a `shared/` file naming it would close a cycle in the server import
   * graph (`paths/server` imports this plugin's `core`). In a `bun --compile`
   * release the whole graph is one bundle and `PLUGINS_DIR` may not exist on
   * disk; returning false there is correct (see the core-warming note below).
   */
  hasCoreBarrel: (pluginPath: string) => boolean;
} & (
  | {
      mode: "serve";
      /**
       * Runs after contributions are collected and BEFORE the ready barrier.
       * This is where `serve` populates its route tables and binds the unix
       * socket, so the gateway sees the process accept connections while the
       * barrier (migrations, config registry) is still running. `exec` has no
       * such interlude, and the union makes that unspellable rather than
       * optional.
       */
      beforeReadyBarrier: (
        ordered: LoadedServerPlugin[],
      ) => void | Promise<void>;
    }
  | { mode: "exec" }
  // A Web Worker in the page (`./browser-host.ts`): the portable graph only,
  // no socket — the page reaches it over a MessagePort.
  | { mode: "browser" }
);

/**
 * Load the plugin graph, run `register`, collect contributions, run the
 * `onReadyBlocking` barrier. Returns the topo-sorted plugins so the caller can
 * run the phases that belong to its mode.
 *
 * Fatality, unchanged from the single-mode boot this was extracted from: a load
 * failure, a `register` throw and an `onReadyBlocking` throw all abort boot
 * unconditionally (NOT gated on `loadBearing`); only the post-barrier phases are
 * gated, and those are serve-only.
 */
export async function bootPluginGraph(
  spec: BootSpec,
): Promise<LoadedServerPlugin[]> {
  // Before any plugin loads, so every phase hook can ask which mode it runs in.
  setBootMode(spec.mode);
  const ordered = await loadServerPlugins(spec.entries, spec.hasCoreBarrel);

  // ── Contributions ──────────────────────────────────────────────
  // Collect declarative contributions from all plugins — static data on the
  // loaded definitions — before the register phase, so a register token can
  // already read a host service (a durable log line written at `register`
  // reaches the host's `LogPersistence`). Consuming plugins read the other
  // kinds in their phase hooks.
  //
  // Stamped with the PLUGIN, not the graph node: a machine half's
  // contributions belong to its plugin (`pluginOfNode`), so anything keyed by
  // `_pluginId` — a config's store path, a resource's owner — sees one plugin,
  // never `<id>#machine`.
  collectContributions(
    ordered.map((p) => ({
      id: pluginOfNode(p.id),
      description: p.description,
      contributions: p.contributions,
    })),
  );

  // Every host service a loaded module declared has exactly one provider in
  // this graph — before any phase hook can read one. A host that loads a
  // consumer without its provider (or with two) fails here, naming both.
  assertHostServices();

  await runRegisterPhase(ordered);

  // A deferred resource compiles its server half from contributions (a
  // collection whose columns other plugins contribute), so it binds now: the
  // full contributor set is known, nothing has served yet, and the ready
  // barrier — whose change feed rebuilds triggers from the route layout — has
  // not run. In both modes, and before the preload assert reads the registry.
  bindDeferredResources();

  // Every server module has registered its resources (module eval) and every
  // `Resource.Declare` is now collected, so a preloaded resource whose plugin
  // forgot to declare it — which would serve but silently lose boot hydration
  // and L2 persistence — fails boot here, naming the key. In both modes, and
  // before the ready barrier: the barrier's L2 sweep (`live-state-snapshot`,
  // which `exec` runs too) deletes every persisted row whose key the Declare set
  // does not list as preloaded, so it must never run on a mis-declared graph.
  // A pure in-memory read, so it costs an `exec` child nothing, and it lands
  // before serve's socket bind, so such a graph never accepts a connection.
  assertPreloadedResourcesDeclared();

  if (spec.mode === "serve") await spec.beforeReadyBarrier(ordered);

  await runReadyBarrier(ordered);
  return ordered;
}

// ── Load all server plugins (topological waves) ────────────────
// Import in dependency-ordered waves over `dependsOn` rather than one flat
// `Promise.allSettled` over every entry. `dependsOn` is the codegen-derived
// cross-plugin import graph already carried by each entry (and already used to
// order the register/onReady phases below). Flat concurrent import races a
// barrel against a module that imports it: the dependent can evaluate while the
// barrel is suspended mid-re-export and observe the barrel's uninitialized
// `const` exports as a TDZ `ReferenceError` under Bun. Loading wave-by-wave
// (concurrent WITHIN a wave, serialized only across edges) guarantees a
// plugin's imports are fully evaluated before it is imported. See
// `computeLoadWaves` for the invariant and cycle handling.
async function loadServerPlugins(
  entries: ServerRegistryEntry[],
  hasCoreBarrel: (pluginPath: string) => boolean,
): Promise<LoadedServerPlugin[]> {
  // The graph is keyed by NODE: a plugin's server half is its `pluginPath`, its
  // machine half `<pluginPath>#machine`, so the two never collide.
  const nodes = entries.map((entry) => ({
    entry,
    pluginPath: isMachineNode(entry.id)
      ? machineNode(entry.pluginPath)
      : entry.pluginPath,
    dependsOn: entry.dependsOn,
  }));
  const waves = computeLoadWaves(nodes);
  const byPath = new Map<string, LoadedServerPlugin>();
  const seenIds = new Set<string>();
  // Collect ALL load failures across every wave and throw once at the end — the
  // operator needs the full list, not just the first plugin to blow up.
  const loadFailures: Array<{ pluginPath: string; error: string }> = [];
  for (const wave of waves) {
    // ── Warm this wave's core barrels BEFORE loading its server barrels ──
    // Waves order plugins so a plugin's server barrel loads after its
    // dependencies' — but that is only HALF the invariant. A plugin's `server`
    // barrel imports its own `core` *submodules* directly (e.g. `../core/schemas`),
    // never the `core` *barrel index* — so loading a dependency's server does NOT
    // evaluate that dependency's core barrel. Dependents in a later wave that
    // import `@plugins/<dep>/core` then race the barrel's FIRST evaluation across
    // sibling plugins in the SAME wave, re-exposing the TDZ. Evaluating each core
    // barrel here, in its own (earlier) wave, closes that gap: it is fully
    // evaluated before any later-wave dependent reads it. Warming a wave's cores
    // concurrently is safe — every core they import transitively belongs to an
    // EARLIER wave and is already evaluated, so no cold barrel is first-imported by
    // two roots at once. Rejections here are not the reporting site: a genuinely
    // broken core barrel re-rejects when its own (or a dependent's) server barrel
    // imports it below, and is recorded there — so nothing is swallowed.
    // (In a `bun --compile` release the whole graph is one bundle, so the race
    // cannot occur and `PLUGINS_DIR` may not exist on disk; core-warming simply
    // no-ops via `hasCoreBarrel`.)
    const coreWave = wave.filter((n) => hasCoreBarrel(n.entry.pluginPath));
    await Promise.allSettled(
      coreWave.map((n) => import(`@plugins/${n.entry.pluginPath}/core`)),
    );

    const results = await Promise.allSettled(
      wave.map(
        (n) => n.entry.loader() as Promise<{ default: ServerPluginDefinition }>,
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const node = wave[i]!;
      const e = node.entry;
      if (r.status === "rejected") {
        console.error(`[plugin.${node.pluginPath}] load failed`, r.reason);
        // First line of the error (`Name: message`) for the aggregated summary;
        // the full reason/stack is on the console.error line above.
        loadFailures.push({
          pluginPath: node.pluginPath,
          error: String(r.reason).split("\n")[0]!,
        });
        continue;
      }
      // `id` is derived from the unique hierarchy path, never authored. The guard
      // is structurally unreachable but fails loud if codegen ever produces a
      // collision, rather than letting topo sort silently drop a plugin.
      if (seenIds.has(e.id)) {
        throw new Error(
          `[plugin] duplicate derived plugin id "${e.id}" (${node.pluginPath})`,
        );
      }
      seenIds.add(e.id);
      const plugin = r.value.default as LoadedServerPlugin;
      plugin.id = asPluginId(e.id);
      byPath.set(node.pluginPath, plugin);
    }
  }
  // A backend that cannot load its plugins MUST NOT report ready. This is the same
  // argument the file makes for `onReadyBlocking` barrier fatality below (a
  // half-loaded backend that passes its health probe silently serves a
  // degraded/half-functional app) and, like that barrier, is deliberately NOT
  // gated on `loadBearing`: a module that throws at import time is broken, full
  // stop. Aggregate every failure into one error so the whole list is visible.
  if (loadFailures.length > 0) throw aggregateLoadFailure(loadFailures);
  for (const n of nodes) {
    const plugin = byPath.get(n.pluginPath);
    if (!plugin) continue;
    plugin.dependsOn = n.dependsOn
      .map((p) => byPath.get(p))
      .filter((d): d is LoadedServerPlugin => d !== undefined);
  }
  const ordered = topoSortPlugins([...byPath.values()]);
  recordMemoryCheckpoint("after-import");
  return ordered;
}

// Phase 1 — register: sequential, topo-sorted. Each plugin's `register`
// array holds Registration tokens returned by helpers like `Mcp.tool`,
// `Runtime.define`, `defineJob`, `defineTriggerEvent`, and
// `UNSAFE_installDurableHooks`. This is the only place plugins write to
// global registries. A failure here is fatal: a half-initialized registry
// would let `onReady` run against an inconsistent world.
async function runRegisterPhase(ordered: LoadedServerPlugin[]): Promise<void> {
  for (const p of ordered) {
    for (const r of p.register ?? []) {
      const end = profilerStart(`register:${p.id}`, "register", p.id, p.id);
      // The plugin, not the graph node (see `collectContributions` above): a
      // registry records where an entry was declared by plugin identity.
      setRegisteringPlugin(pluginOfNode(p.id));
      try {
        await r.register();
      } catch (err) {
        console.error(`[plugin.${p.id}] register failed`, err);
        throw err;
      } finally {
        setRegisteringPlugin(null);
        end();
      }
    }
  }
}

// Run a lifecycle phase graph-driven by `dependsOn`: each plugin's `hook` starts
// only after all its `dependsOn` parents' hooks have resolved. `topoSortPlugins`
// guarantees every plugin appears after its deps in `ordered`, so
// `resolved.get(d.id)` is always defined when we reach a dependent. The per-plugin
// try/catch lives INSIDE the `.then` callback so one plugin's outcome propagates
// (or doesn't) to the final `Promise.all` per the phase's fatality contract below.
//
// Fatality differs by phase, because the two phases sit on opposite sides of the
// readiness flip:
//
// - `onReadyBlocking` is the HARD BARRIER *before* the backend serves. Its entire
//   contract is "this MUST finish before requests can be served correctly" — so a
//   throw means it did NOT finish, and boot MUST abort, for EVERY plugin regardless
//   of the plugin-wide `loadBearing` flag. `loadBearing` classifies docs detail /
//   criticality, not barrier participation; gating the barrier on it silently
//   promoted a degraded backend (a change-feed with no triggers, an empty config
//   registry) behind a green `/api/health/ready`. A plugin whose blocking work is
//   genuinely optional-for-correctness must make that explicit by handling its own
//   failure INSIDE the hook (see `live-state-snapshot`), never by relying on the
//   framework to swallow it.
// - `onReady` runs AFTER the server is already serving. Killing a live, serving
//   backend because a background poller/watcher threw is reserved for genuinely
//   critical plugins, so that phase stays gated on `loadBearing`.
export async function runGraphPhase(
  ordered: LoadedServerPlugin[],
  hook: "onReadyBlocking" | "onReady",
): Promise<void> {
  const resolved = new Map<string, Promise<void>>();
  for (const p of ordered) {
    const deps = (p.dependsOn ?? []).map((d) => resolved.get(d.id)!);
    const ready = Promise.all(deps).then(async () => {
      const fn = p[hook];
      if (!fn) return;
      const end = profilerStart(`${hook}:${p.id}`, hook, p.id, p.id);
      try {
        await fn.call(p);
      } catch (err) {
        console.error(`[plugin.${p.id}] ${hook} failed`, err);
        if (hook === "onReadyBlocking" || p.loadBearing) throw err;
      } finally {
        end();
      }
    });
    resolved.set(p.id, ready);
  }
  await Promise.all(resolved.values());
}

// ── onReadyBlocking ─────────────────────────────────────────────
// Hard barrier between socket-bind and serving-ready. Plugins that MUST finish
// before the backend can correctly serve requests (DB migrations + pool warm,
// config registry init) run here. The phase is graph-driven by `dependsOn`
// (exactly like `onReady`): each plugin's blocking hook starts only after all its
// `dependsOn` parents' blocking hooks have resolved, so DB-touching plugins
// auto-sequence after `database`'s migrations. In `serve`, once the whole phase
// resolves the caller flips the readiness flag — `GET /api/health/ready` returns
// 200 only after that point, and the gateway gates its hot-swap on that probe (so
// the old backend keeps serving until the new one is genuinely ready). Background
// `onReady` work runs after, now guaranteed to observe a migrated DB and a ready
// registry. ANY plugin's rejection here aborts boot — this is a hard barrier, so
// its fatality is NOT gated on `loadBearing` (a plugin with optional blocking work
// handles its own failure inside the hook). See `runGraphPhase`.
async function runReadyBarrier(ordered: LoadedServerPlugin[]): Promise<void> {
  const end = profilerStart(
    "onReadyBlocking",
    "onReadyBlocking",
    "Blocking Ready",
  );
  try {
    await runGraphPhase(ordered, "onReadyBlocking");
  } finally {
    end();
  }
  recordMemoryCheckpoint("after-onReadyBlocking");
}

// ── onAllReady ──────────────────────────────────────────────────
// Phase 3 — full barrier: every plugin's `onReady` has resolved. Plugins whose
// initialization must observe another plugin's onReady-produced state (without
// a dependsOn edge — e.g. a schedule whose definition reads config) run here.
// Parallel; a load-bearing plugin's rejection aborts boot.
export async function runAllReadyPhase(
  ordered: LoadedServerPlugin[],
): Promise<void> {
  await Promise.all(
    ordered.map(async (p) => {
      if (!p.onAllReady) return;
      const end = profilerStart(`onAllReady:${p.id}`, "onAllReady", p.id, p.id);
      try {
        await p.onAllReady();
      } catch (err) {
        console.error(`[plugin.${p.id}] onAllReady failed`, err);
        if (p.loadBearing) throw err;
      } finally {
        end();
      }
    }),
  );
  recordMemoryCheckpoint("after-onAllReady");
}

/**
 * Run every plugin's `onShutdown` — drain background workers, flush buffered
 * state, release connections. Rejections are logged, never rethrown: one
 * plugin's failed teardown must not prevent the others from running theirs.
 * Shared by `serve`'s signal handler and `exec`'s end-of-run teardown, so the
 * two cannot disagree about what "shut this process down" means.
 */
export async function runShutdownHooks(
  ordered: LoadedServerPlugin[],
): Promise<void> {
  await Promise.all(
    ordered.map((p) =>
      // eslint-disable-next-line promise-safety/no-bare-catch
      Promise.resolve()
        .then(() => p.onShutdown?.())
        .catch((err) =>
          console.error(`[plugin.${p.id}] onShutdown failed`, err),
        ),
    ),
  );
}

/** A load failure that is only a CONSEQUENCE of some other barrel throwing. */
const UNINITIALIZED_BINDING_RE = /Cannot access '.+' before initialization/;

/**
 * One error for the whole failed load, with the ROOT failures named first.
 *
 * When a barrel throws at module eval, its exports are left uninitialized — so
 * every plugin importing a symbol from it fails in turn with
 * `ReferenceError: Cannot access 'X' before initialization`. Those are
 * consequences, not causes, and they outnumber the cause badly: one unset env
 * var in `config_v2/server` produced 1 root failure and 82 TDZ lines after it.
 * A reader tailing that output sees only the consequences and goes hunting for a
 * load-order race that is not there.
 *
 * So partition the list. Roots come first and are labelled as the thing to fix;
 * the consequential ones are still printed in full (the operator needs the whole
 * blast radius) but under a heading that says what they are.
 *
 * When there is no root — every failure is an uninitialized binding — that is a
 * genuine load-ORDER problem (the cold-barrel race the per-wave core warming
 * exists to prevent), and the message says so rather than inventing a cause.
 */
function aggregateLoadFailure(
  failures: Array<{ pluginPath: string; error: string }>,
): Error {
  const line = (f: { pluginPath: string; error: string }) =>
    `  - ${f.pluginPath}: ${f.error}`;
  const roots = failures.filter((f) => !UNINITIALIZED_BINDING_RE.test(f.error));
  const consequences = failures.filter((f) =>
    UNINITIALIZED_BINDING_RE.test(f.error),
  );

  const head = `[plugin] ${failures.length} plugin(s) failed to load`;
  if (consequences.length === 0) {
    return new Error(`${head}:\n${failures.map(line).join("\n")}`);
  }
  if (roots.length === 0) {
    return new Error(
      `${head}, ALL of them with an uninitialized binding and no plugin throwing on its own.\n` +
        `That is a load-ORDER failure — a barrel observed mid-evaluation — not a broken plugin. ` +
        `Check the per-wave core-barrel warming and \`computeLoadWaves\`:\n` +
        failures.map(line).join("\n"),
    );
  }
  return new Error(
    `${head}: ${roots.length} root failure(s), and ${consequences.length} that are only a ` +
      `consequence of them (a barrel that throws leaves its exports uninitialized, so every ` +
      `importer reports "Cannot access 'X' before initialization").\n` +
      `FIX THESE FIRST:\n${roots.map(line).join("\n")}\n` +
      `Downstream (uninitialized binding, expected to clear once the above are fixed):\n` +
      consequences.map(line).join("\n") +
      // Restated at the END as well as the top. The downstream list is the long
      // one, so anything reading the tail of this message — a piped `tail`, a
      // log viewer's last-N-lines, a truncated report — would otherwise see only
      // consequences. That is exactly how this failure was first misread.
      `\n→ ROOT CAUSE (repeated, the ${consequences.length} line(s) above are downstream of it):\n` +
      roots.map(line).join("\n"),
  );
}
