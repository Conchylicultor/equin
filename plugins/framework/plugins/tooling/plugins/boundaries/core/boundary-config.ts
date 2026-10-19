import { defineBoundaries, zone, allow } from "./config";

export default defineBoundaries({
  zones: [zone("plugin", { match: "plugins", discover: "plugin-tree" })],

  // Layer 1: Folder isolation (default-deny — unlisted = blocked). One row per
  // folder a plugin may contain (`PluginFolder`), and a row can only list
  // barrel folders (`RuntimeFolder`): nothing imports a leaf folder.
  //
  // Test code (`isTestCodePath`: `*.test.ts(x)`, `__tests__/`, `<runtime>/testing/`)
  // has NO rows of its own: it follows the row of the folder it sits in. The one
  // extra rule — only code that verifies (test code, `VERIFYING_FOLDERS`) may
  // import test code — is `judgeImport`'s first step, so a test reaches exactly
  // the `testing` barrels of the folders its row already allows.
  folders: {
    // `data-dirs` is absent from `web` and `core` ON PURPOSE. A data-dir
    // declaration reaches `paths/core`, which calls `homedir()` at module scope
    // — a single such edge into the web bundle breaks it at module eval. `core`
    // is web-importable, so granting `core -> data-dirs` would open that path
    // transitively; the browser names a directory through the `paths/display`
    // string literals instead.
    //
    // The row holds inside a plugin too: `boundary-rules` reads a plugin's own
    // relative imports, so `core/` reaching its own `../data-dirs` is flagged
    // like `@plugins/other/data-dirs` is. The known exceptions are the
    // host-only `core/` files listed under `runtimeExceptions` below.
    web: ["web", "core", "shared"],
    server: ["server", "core", "shared", "data-dirs", "deps"],
    // machine/ — the desktop-only half of a plugin's backend (fs, git, spawn,
    // the pg pool, graphile). It may reach everything `server` may, plus other
    // machine barrels. NO other row lists `machine` but `cli` and `check` (a
    // CLI verb and a check are host processes too — a check reads the same
    // desktop facts a machine half serves, e.g. the migration files on disk):
    // a `server/` file importing a machine barrel is a
    // boundary error, so portable server code cannot quietly grow a
    // desktop-only dependency — the split spreads by itself.
    machine: ["machine", "server", "core", "shared", "data-dirs", "deps"],
    central: ["central", "core", "shared", "data-dirs", "deps"],
    core: ["core"],
    shared: ["shared", "core", "data-dirs"],
    // Declarations of the directories a plugin owns under the data root. A leaf
    // runtime: it reads `paths/core` to build its paths and nothing else, so it
    // can be imported cross-plugin (two plugins sharing one directory — e.g.
    // pgbouncer writing into the embedded cluster's dir — import the single
    // declaration rather than each joining the root).
    "data-dirs": ["data-dirs", "core"],
    // provision/ — install-time provisioning steps (postinstall). A step may
    // read `core` and other plugins' `provision` barrels; NOTHING may read a
    // `provision` barrel back, because provisioning DOWNLOADS AND INSTALLS —
    // work no request path may ever start. That is not hypothetical: the
    // chromium installer used to sit in `browser-fetch/core`, and a thumbnail
    // render called it, so a missing binary blocked a backend's event loop for
    // a ~150 MB download. (Chromium is now an on-demand `infra/deps`
    // dependency, and no provisioning step remains; the registry still works
    // with zero entries.)
    //
    // The row polices it in both directions: a provisioning step may not import
    // `@plugins/x/web` or its own `../web`, and no other folder's row lists
    // `provision`.
    //
    // `runtimeNames` derives from `RUNTIME_FOLDERS`, so `@plugins/<p>/provision`
    // is also a legal cross-plugin barrel (plugin-boundaries R4) — which is how
    // two plugins share ONE installer instead of copying it. Its R6 DAG edges
    // are tagged `provision` and fall outside the web/server/central cycle
    // graphs; a provisioning graph is a handful of leaf steps, not a lattice.
    provision: ["provision", "core"],
    // e2e/ — Playwright scripts that drive the deployed app from OUTSIDE it.
    // They may use other plugins' `core` types and other plugins' `e2e` flow
    // helpers (the shared harness, the "open a blank Pages doc" flow), and are
    // denied `web`/`server`/`shared`: an end-to-end test asserts on the running
    // app through the browser, never by importing the code under test.
    //
    // `data-dirs` is granted for the same reason `server` has it: an e2e script
    // is a Node process on the host, and some of them assert on a file the app
    // wrote under the data root (the config override a filter edit persists).
    // Without the declaration the only way to name that file is to join the
    // root by hand — an undeclared path, spelled a second time, which is the
    // whole failure mode the registry exists to end. Importing a declaration
    // reads a path; it does not import the code under test.
    e2e: ["e2e", "core", "data-dirs", "deps"],
    // cli/ — a plugin's `./singularity <verb>` contribution. A CLI command is a
    // host process like a server, so it may reach `core`, its own `shared`,
    // declared `data-dirs`, other plugins' `server` barrels, and other plugins'
    // `cli` barrels. That last edge is the point: shared CLI machinery lives in
    // a `cli/` barrel rather than being copied, exactly as `tooling/e2e-harness`
    // shares one Playwright harness through its `e2e/` barrel.
    // `runtimeNames` derives from `RUNTIME_FOLDERS`, so `@plugins/<p>/cli` is a
    // legal cross-plugin barrel with no other edit.
    //
    // `web` is denied: a terminal verb that reached a browser barrel would drag
    // React into the CLI process, and there is no such thing as a CLI rendering
    // a component.
    //
    // THIS ROW DOES NOT CARRY THE EAGER-WEIGHT RULE, and must not be read as
    // doing so. Every plugin's `cli/index.ts` is loaded on EVERY `./singularity`
    // invocation (commander needs names and flags before it parses), while the
    // command's implementation must not be. That constraint is a property of one
    // file, not of the runtime, so it is enforced by
    // `cli:command-declarations-light` — which measures each `cli/index.ts`'s
    // STATIC closure only. An implementation sitting next to the declaration is
    // free to reach `server`; the declaration reaching it is the error.
    cli: ["cli", "core", "shared", "data-dirs", "server", "machine", "deps"],
    // deps/ — on-demand dependency declarations (`defineDep`) and, in
    // `infra/deps`, the install engine. Host-only: the engine reads
    // `paths/core` (`homedir()` at module eval) and declares its cache through
    // `data-dirs`, so `web` and `core` do not list it — which is also why the
    // engine is a barrel of its own rather than `core/`. Every host-process row
    // (server, central, cli, check, e2e, scripts, bin) lists it, so a CLI op, a
    // check or `./singularity start` reaches a declaration and `ensureDep`
    // without booting a backend. Host admission, a server barrel, is injected
    // through the `ExecContext` rather than imported.
    deps: ["deps", "core", "data-dirs"],

    // Leaf folders (`LEAF_FOLDERS`): found by discovery or run by path, never
    // imported. `shared` in a row is the plugin's own; plugin-boundaries R10
    // forbids reaching another plugin's. `web` is in no host-process row.
    lint: ["core"],
    check: ["core", "shared", "data-dirs", "server", "machine", "deps"],
    facet: ["core"],
    bin: ["core", "shared", "data-dirs", "server", "central", "cli", "deps"],
    scripts: ["core", "shared", "data-dirs", "server", "deps"],
    // Exhibits (`plugin-meta/exhibits`) render a plugin's own real components
    // standalone. Co-built into the plugin's web artifact, so its own `web/`
    // may be imported deeply (runtime-isolation/no-deep-own-folder-import).
    exhibits: ["web", "core"],
    vite: ["core"],
    prewarm: ["core", "shared"],
    // One uv project (`infra/deps/plugins/python`): Python source plus
    // `pyproject.toml` / `uv.lock`. It holds no TypeScript, so it imports nothing.
    python: [],
    // An exemption manifest (`tooling/exempt`): plain data that names its own
    // plugin's files, typed by the exempt primitive's `core`.
    exempt: ["core"],
    // Contributed hook guards (`tooling/guards`): loaded by the PreToolUse hook,
    // a host process, so a guard may read its owner's data-dir declaration.
    guard: ["core", "data-dirs"],
  },

  // Which folders may import a platform API (a Node builtin, `bun`, `pg`,
  // graphile, a native watcher — the matcher is `./platform-apis`), enforced
  // by the `boundaries/no-platform-api` lint rule. Exhaustive over
  // `PluginFolder`, so a new folder kind is a tsc error until it answers.
  //
  // Forbidden where the code must run on every host: `server` (portable app
  // logic — tables, queries, handlers; the desktop-only half is `machine`),
  // `core` and `shared` (reachable from `server` and `web`) and `web`. Every
  // other folder runs only on a host process (a backend's `machine`, central,
  // a CLI verb, a check, a script) or holds no code that loads.
  platformApis: {
    web: "forbidden",
    server: "forbidden",
    core: "forbidden",
    shared: "forbidden",
    machine: "allowed",
    central: "allowed",
    e2e: "allowed",
    provision: "allowed",
    "data-dirs": "allowed",
    cli: "allowed",
    deps: "allowed",
    check: "allowed",
    lint: "allowed",
    facet: "allowed",
    bin: "allowed",
    scripts: "allowed",
    exhibits: "allowed",
    vite: "allowed",
    prewarm: "allowed",
    python: "allowed",
    exempt: "allowed",
    guard: "allowed",
  },

  runtimeExceptions: [
    "plugin.infra.secrets.central -> plugin.infra.paths.server",

    // Host-only (Node) code that sits in `core/` and reads its own plugin's
    // data-dir declaration. `core/` has two meanings today: code the browser
    // and the host share, and Node-only code that is not tied to one server
    // runtime. These files are the second kind. No `web/` file imports any of
    // these `core/` barrels, so the browser never loads `paths/core` through
    // them. Each line is scoped to one plugin's own `data-dirs`, never
    // `core -> data-dirs` at large.
    "plugin.database.core -> plugin.database.data-dirs",
    "plugin.framework.tooling.checks.core -> plugin.framework.tooling.checks.data-dirs",
    "plugin.framework.tooling.web-artifacts.core -> plugin.framework.tooling.web-artifacts.data-dirs",
    "plugin.packages.signal-origin.sink.core -> plugin.packages.signal-origin.sink.data-dirs",
    "plugin.reports.outbox.core -> plugin.reports.outbox.data-dirs",
  ],

  // Layer 2: Zone DAG (first-match, default-deny)
  edges: [
    // packages/ umbrella children are utility code, globally accessible
    allow("** -> plugin.plugin-meta.plugin-tree"),
    allow("** -> plugin.packages.retry"),
    allow("** -> plugin.packages.semaphore"),

    // Config origin codegen and check import config_v2 core (hash, types) and barrel-import
    allow("tooling -> plugin.config_v2"),
    allow("tooling -> plugin.config_v2.store"),
    allow("tooling -> plugin.plugin-meta.barrel-import"),

    // Plugins can import other plugins
    allow("plugin.** -> plugin.**"),
  ],

  // Composition roots that wire plugins together — exempt from boundary checks
  exclude: [
    "plugins/framework/plugins/web-sdk/core/web.generated.ts",
    "plugins/framework/plugins/web-core/web/App.tsx",
    "plugins/framework/plugins/server-core/core/server.generated.ts",
    "plugins/framework/plugins/server-core/core/machine.generated.ts",
    "plugins/framework/plugins/server-core/bin/index.ts",
    "plugins/framework/plugins/central-core/core/central.generated.ts",
    "plugins/framework/plugins/central-core/bin/index.ts",
    "plugins/framework/plugins/tooling/plugins/checks/core/check.generated.ts",
    "plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts",
    "eslint.config.ts",
  ],
});
