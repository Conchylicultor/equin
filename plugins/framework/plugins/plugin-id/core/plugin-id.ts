/** A plugin's canonical hierarchy id, dot-separated, e.g. "conversations.conversation-view". */
export type PluginId = string & { readonly __brand: "PluginId" };

/** Cast a raw string from a serialization boundary (DB, URL, JSON, codegen literal) to PluginId. */
export const asPluginId = (s: string): PluginId => s as PluginId;

/** Slash form for the config store path: "conversations/conversation-view". NOT the fs path. */
export const asPath = (id: PluginId): string => id.split(".").join("/");

/** Real filesystem path under plugins/: "conversations/plugins/conversation-view". */
export const asFsPath = (id: PluginId): string =>
  id.split(".").join("/plugins/");

/** Segments for breadcrumbs / last-segment matching. */
export const pluginIdSegments = (id: PluginId): string[] => id.split(".");

/** The workspace package name of the plugin whose directory is `fsPath` (relative
 *  to `plugins/`, the `asFsPath` form): `@singularity/plugin-<chain>`, the chain
 *  joining every non-`plugins` segment with `-` — unique across the nested tree
 *  (`tasks` → `plugin-tasks`, `stats/plugins/tasks` → `plugin-stats-tasks`).
 *
 *  DERIVED, never authored: the repo-tree codegen (`./singularity build` /
 *  `./singularity regen-generated`) writes it into each plugin's `package.json`,
 *  and the plugin-boundaries check (R1) holds the file to it. Bun needs the field
 *  (a nameless workspace member fails `bun install`), but nothing reads it. */
export const packageNameFor = (fsPath: string): string =>
  `@singularity/plugin-${fsPath
    .split("/")
    .filter((s) => s !== "plugins")
    .join("-")}`;

/** The plugin source/barrel runtime folders — the isolation + bundling vocabulary
 *  and single source of truth. Every per-runtime grouping derives from this;
 *  never hardcode the list elsewhere. (The boundary table's keys are the wider
 *  `PLUGIN_FOLDERS` below.)
 *
 *  `e2e` holds a plugin's Playwright scripts. It is a first-class runtime because
 *  its `e2e/index.ts` barrel is genuine cross-plugin API (one plugin's e2e script
 *  imports another's domain flow helpers) and it carries its own isolation policy
 *  — `e2e` may reach `core` and other `e2e` barrels, never `web`/`server`, since
 *  an end-to-end test drives the deployed app through the browser rather than
 *  importing the code under test.
 *
 *  `provision` holds a plugin's install-time provisioning step (postinstall).
 *  Same two reasons: its `provision/index.ts` is genuine cross-plugin API (the
 *  e2e harness and `browser-fetch` share ONE chromium installer rather than
 *  copying it), and it carries its own isolation policy — a provisioning step
 *  may reach `core` and other `provision` barrels, and NOTHING may reach back
 *  into it, because provisioning downloads and installs: work no request path
 *  may ever start.
 *
 *  `deps` holds a plugin's on-demand dependency declarations (`defineDep`
 *  values; `infra/deps` collects every `deps/index.ts` into a generated
 *  registry) and, in `infra/deps` itself, the install engine. It is a runtime
 *  of its own so every HOST process — a backend, a CLI op, a check, an e2e
 *  script, the gateway's `start` — can reach a declaration and the engine
 *  without booting a backend, while `web` and `core` cannot: the engine reads
 *  `paths/core` (`homedir()` at module eval).
 *
 *  `machine` holds the desktop-only half of a plugin's backend: the code that
 *  needs the computer (fs, git, spawn, the pg pool, graphile). `server/` stays
 *  portable — it may not import a platform API (`boundaries/no-platform-api`)
 *  nor a `machine` barrel — so the same server code can boot on another host
 *  (the browser). A desktop backend boots both halves as one plugin graph
 *  (`machineEntries`, nodes keyed `<plugin>#machine`). */
export const RUNTIME_FOLDERS = [
  "web",
  "server",
  "machine",
  "central",
  "core",
  "shared",
  "e2e",
  "provision",
  "data-dirs",
  "cli",
  "deps",
] as const;
export type RuntimeFolder = (typeof RUNTIME_FOLDERS)[number];

/** The plugin folders that are NOT barrels: each is found by discovery (a
 *  collected-dir loader, a process entry point, a script run by path), and
 *  nothing imports it. `check/` and `lint/` are collected by the check runner
 *  and the ESLint config, `facet/` by the facet pipeline, `exhibits/`,
 *  `vite/` and `prewarm/` by their own collected dirs; `bin/` and `scripts/`
 *  are run by path; `python/` holds one uv project (`pyproject.toml`, `uv.lock`)
 *  that `infra/deps`' python kind installs and runs, and holds no TypeScript;
 *  `exempt/` holds the plugin's exemption manifest (which of its own files may
 *  violate which rule, and why), collected by `tooling/exempt`.
 *
 *  Together with `RUNTIME_FOLDERS` this is the whole folder vocabulary a
 *  plugin may contain (plus `plugins/`, which holds child plugins, not code).
 *  The boundary table is keyed on it, so a folder name added here is a type
 *  error until it declares what it may import. */
export const LEAF_FOLDERS = [
  "check",
  "lint",
  "facet",
  "bin",
  "scripts",
  "exhibits",
  "vite",
  "prewarm",
  "python",
  "exempt",
] as const;
export type LeafFolder = (typeof LEAF_FOLDERS)[number];

/** Every folder of code a plugin may contain: the barrels and the leaves. */
export const PLUGIN_FOLDERS = [...RUNTIME_FOLDERS, ...LEAF_FOLDERS] as const;
export type PluginFolder = RuntimeFolder | LeafFolder;

/** Whether a runtime folder's facts belong in the GENERATED plugin docs
 *  (`docs/plugins-details.md` and each plugin's `CLAUDE.md` reference block).
 *
 *  Doc visibility is a property of the runtime, so it is declared here beside the
 *  runtime set — the doc renderer consumes the derived set below and never names a
 *  folder itself. `Record<RuntimeFolder, boolean>` is exhaustive by construction:
 *  adding a runtime folder is a type error until it declares its doc policy.
 *
 *  `e2e` is omitted: an e2e barrel is real cross-plugin API, but only to other e2e
 *  scripts — no `web`/`server`/`core` caller can reach it, so its `Uses`/`Exports`
 *  facts spend every agent's context on a surface none of them can depend on. */
const RUNTIME_FOLDER_DOCUMENTED: Record<RuntimeFolder, boolean> = {
  web: true,
  server: true,
  // Documented like `server`: a machine barrel is the desktop backend's API
  // (endpoints, registrations, host-service providers) other machine code uses.
  machine: true,
  central: true,
  core: true,
  shared: true,
  e2e: false,
  // `provision` is undocumented for the same reason as `e2e`: the barrel is
  // real cross-plugin API, but only to other provisioning steps — no
  // `web`/`server`/`core` caller may import it (that is the whole point), so
  // its `Uses`/`Exports` facts would spend every agent's context on a surface
  // none of them can depend on.
  provision: false,
  // `data-dirs` holds a plugin's declarations of the directories it owns under
  // the singularity data root. Undocumented not because the facts are private —
  // the folder IS a legal cross-plugin barrel, so two plugins sharing one
  // directory import a single declaration — but because the generated reference
  // is the wrong reader for them. "Who owns this directory, and may I delete
  // it?" is answered against the LIVE filesystem by
  // `paths:no-undeclared-data-dirs` and by `getDataDirs()`, which a stale doc
  // block cannot do; duplicating the set into every CLAUDE.md would spend
  // context on a second, drift-prone copy of a registry that is already
  // enumerable at runtime.
  "data-dirs": false,
  // `cli` is the one non-web/server runtime that IS documented. Unlike `e2e` and
  // `provision`, whose barrels only other e2e scripts / provisioning steps can
  // reach, a `cli/` folder's headline fact is user-facing: this plugin owns
  // `./singularity <verb>`. That is precisely what an agent needs to read out of
  // the generated reference before adding a second verb for the same job, and it
  // is not answerable from anywhere else — a command name is not a filename.
  cli: true,
  // `deps` is documented: its barrels are what a feature imports to declare,
  // install and run a dependency (`infra/deps`' engine, a kind's runner, one
  // plugin's declaration another ensures), so its exports are real API that
  // server, CLI and check code depends on.
  deps: true,
};

/** Runtime folders the generated plugin docs omit — the doc renderer's generic
 *  filter over a fact's folder key (non-runtime groups are never members). */
export const UNDOCUMENTED_RUNTIME_FOLDERS: ReadonlySet<string> = new Set(
  RUNTIME_FOLDERS.filter((rt) => !RUNTIME_FOLDER_DOCUMENTED[rt]),
);

/** Whether a runtime folder's imports SHIP — whether an import written there is
 *  a reason to put its target inside a composition's bundled closure.
 *
 *  This is the question "does the deployed app execute this folder?", and it is a
 *  property of the runtime, so it is declared here beside the runtime set — the
 *  edge classifier consumes the derived allowlist below and never names a folder
 *  itself. `Record<RuntimeFolder, boolean>` is exhaustive by construction: adding
 *  a runtime folder is a type error until it declares whether it ships.
 *
 *  It is spelled as the full map rather than a bare allowlist array ON PURPOSE.
 *  An array would let a NEW shipping runtime default silently to "does not ship",
 *  which does not fail — it quietly drops plugins out of every composition's
 *  registry and surfaces as a missing feature at runtime. The map makes the new
 *  runtime's author answer.
 *
 *  `e2e`, `provision` and `cli` are developer surfaces that run on a developer's
 *  machine and are never compiled into a release. Counting their imports as
 *  closure edges is not merely wasteful, it is how a plugin's throwaway Playwright
 *  script drags Chromium into every shipped backend: `reorder/e2e` imports the
 *  shared harness, whose `provision/` imports `browser-fetch`, which imports
 *  `playwright` — and the website release's `bun build --compile` then died on a
 *  `chromium-bidi` require inside playwright-core that nothing ever executes. */
const RUNTIME_FOLDER_SHIPPED: Record<RuntimeFolder, boolean> = {
  web: true,
  server: true,
  // The desktop backend boots it (`machineEntries`), so it ships in the
  // desktop release.
  machine: true,
  central: true,
  core: true,
  shared: true,
  "data-dirs": true,
  e2e: false,
  provision: false,
  cli: false,
  // A backend imports its declarations and the engine (`requestDep`,
  // `readyNow`, the install job), so a `deps` import is a reason to bundle.
  deps: true,
};

/** The runtimes whose imports define the shipped closure — the ALLOWLIST the
 *  edge classifier walks instead of every runtime's `apiUses`. */
export const SHIPPED_RUNTIME_FOLDERS: readonly RuntimeFolder[] =
  RUNTIME_FOLDERS.filter((rt) => RUNTIME_FOLDER_SHIPPED[rt]);

/** A plugin's `machine/` half is its own node in a desktop backend's plugin
 *  graph, beside the plugin's `server/` node: keyed `<pluginPath>#machine`, with
 *  the id `<plugin id>#machine` (so the two halves never collide in the
 *  loader's by-path map, the duplicate-id guard or a phase's `dependsOn`). The
 *  machine registry (`server-core/core/machine.generated.ts`) spells its
 *  entries' ids and `dependsOn` this way, and the boot loader reads them back
 *  with `isMachineNode`. */
export const MACHINE_NODE_SUFFIX = "#machine";

/** The machine node of a plugin path or plugin id. */
export const machineNode = (pathOrId: string): string =>
  `${pathOrId}${MACHINE_NODE_SUFFIX}`;

/** Whether a registry id or node key names a plugin's machine half. */
export const isMachineNode = (idOrKey: string): boolean =>
  idOrKey.endsWith(MACHINE_NODE_SUFFIX);

/**
 * The PLUGIN a graph node belongs to: a machine node's own plugin id (or path),
 * any other node unchanged. A node key is a loader concern; everything keyed
 * by plugin identity — what a contribution or a registration names as its
 * plugin (a config's store path, a job's "declared in") — reads this, so a
 * plugin's two halves are one plugin to the rest of the app.
 */
export const pluginOfNode = (idOrKey: string): string =>
  isMachineNode(idOrKey)
    ? idOrKey.slice(0, -MACHINE_NODE_SUFFIX.length)
    : idOrKey;

/** The directory a runtime folder publishes its test helpers from:
 *  `<runtime>/testing/index.ts`, imported as `@plugins/<p>/<runtime>/testing`.
 *  It sits directly under a runtime folder (never under `e2e/`) and nowhere
 *  else, so the name means the same thing wherever it appears and a file walker
 *  may skip it by name, as it skips `__tests__`. */
export const TESTING_FOLDER = "testing";

/** The directory vitest's jsdom suites live in (see `test-layout`). */
export const TESTS_DIR = "__tests__";

const TEST_FILE_RE = /\.test(\.tsx?)?$/;

/** Whether a path inside a plugin (its segments below the plugin directory, the
 *  file name last) is TEST CODE: a `*.test.ts(x)` file, or anything under a
 *  `__tests__/` or `testing/` directory. A relative specifier's segments work
 *  too — its extension is optional, and a directory specifier (`…/testing`)
 *  names that directory's index. This is the one definition; test code
 *  follows its folder's boundary row, and only code that verifies may import it. */
export function isTestCodePath(segments: readonly string[]): boolean {
  if (TEST_FILE_RE.test(segments.at(-1) ?? "")) return true;
  // Every segment, the last included: `@plugins/x/core/testing` and
  // `../core/testing` name the directory itself (its index).
  return segments.some((s) => s === TESTS_DIR || s === TESTING_FOLDER);
}

/** The plugin folders whose ORDINARY files verify rather than ship, and so may
 *  import test code like a test may. A check reads code and never runs in the
 *  product. `e2e` is deliberately absent: it verifies by driving the running
 *  app, not by importing code. */
export const VERIFYING_FOLDERS: readonly PluginFolder[] = ["check"];
