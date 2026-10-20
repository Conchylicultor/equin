import type { Check } from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
// Own-plugin, so relative — the `@plugins/infra/plugins/launcher/core` alias
// would name this plugin from inside itself.
import {
  RUNTIME_FORWARDED_ENV,
  RUNTIME_FORWARDED_PREFIXES,
  RUNTIME_WITHHELD_ENV,
} from "../core";
import { stripComments } from "./internal/strip-comments";

const DECLARATION = "plugins/infra/plugins/launcher/core";

/** Test sources are exempt from every check here: a test builds its own environment. */
function isTestFile(path: string): boolean {
  return (
    /\.test\.tsx?$/.test(path) ||
    path.includes("/__tests__/") ||
    path.endsWith("_test.go")
  );
}

// ── launcher:runtime-env-declared ──────────────────────────────────────────
//
// Every SINGULARITY_* variable is one of two kinds, and the difference decides
// whether a backend may carry it:
//
//  - an installation setting (the data root, a release's vendored-file
//    locations, an operator knob), which must reach every backend; or
//  - somebody's own state (an agent's conversation id, a CLI run's build id, a
//    host grant), which must never reach one — a backend that inherited it
//    would act as whichever process happened to start the gateway.
//
// The launcher's declaration lists both kinds, and the gateway spawn forwards
// only the first. So a name that is on neither list fails in one of two quiet
// ways: an installation setting that silently never arrives (a release reads
// its dev default instead of the vendored file), or — had the lists been a
// denylist — a session value that silently leaks. This check makes adding the
// name the moment that question gets answered.
//
// The question only means something for code that reads or sets a variable,
// so that is all this scans. Comments are dropped first (a comment describing
// a retired variable reads nothing, and in TypeScript neither does a regex
// literal), and so are lint rules (a rule that names
// a variable to ban it neither reads nor sets it). What is left: TypeScript
// under plugins/, the gateway's Go, the git hooks, and the desktop shell's
// Rust (it sets variables for the release launcher it starts).
//
// The reverse holds too: a declared name that no scanned code reads or sets any
// more is reported as stale, so the lists cannot fill up with names nothing
// uses.
const NAME_PATHSPECS = [
  ":(glob)plugins/**/*.ts",
  ":(glob)plugins/**/*.tsx",
  ":(glob)gateway/*.go",
  ":(glob).githooks/*",
  ":(glob)tauri/**/*.rs",
];

// The declaration itself spells every declared name; scanning it would make
// every entry look used.
const DECLARATION_FILE = `${DECLARATION}/internal/runtime-env.ts`;

function isScanned(path: string): boolean {
  return (
    !isTestFile(path) && !path.includes("/lint/") && path !== DECLARATION_FILE
  );
}

// A variable name, and not the tail of a longer identifier: the lookbehind is
// what leaves out the vite build-time defines `__SINGULARITY_GRAPH__` /
// `__SINGULARITY_COMMIT__`, which are substituted into the bundle at build time
// and never read from any environment.
const NAME_RE = /(?<![A-Za-z0-9_])SINGULARITY_[A-Z0-9_]+/g;

const DECLARED_NAMES: readonly string[] = [
  ...Object.keys(RUNTIME_FORWARDED_ENV),
  ...Object.keys(RUNTIME_WITHHELD_ENV),
];
const PREFIXES: readonly string[] = Object.keys(RUNTIME_FORWARDED_PREFIXES);

/** The declared entry that covers `name`: itself, or the prefix it starts with. */
function declaredEntryFor(name: string): string | undefined {
  if (DECLARED_NAMES.includes(name)) return name;
  // A template that builds the name (`SINGULARITY_AUTH_${provider}_…`) scans
  // as the bare prefix, which the prefix covers too.
  return PREFIXES.find((p) => name.startsWith(p));
}

const runtimeEnvDeclaredCheck: Check = {
  id: "launcher:runtime-env-declared",
  description:
    "Every SINGULARITY_* variable the code reads or sets must be declared as forwarded to the runtime tree or withheld from it, in plugins/infra/plugins/launcher/core — and every declared name must still be used",
  async run() {
    const root = await getWorktreeRoot();
    const sources = await listCandidateSources({
      root,
      grepArg: "SINGULARITY_",
      fixed: true,
      pathspecs: NAME_PATHSPECS,
    });

    // name → every place it is spelled, so one undeclared name is one entry.
    const undeclared = new Map<string, string[]>();
    const used = new Set<string>();
    // The check runner's thread is shared by every check in the pass: pause
    // every ~10 ms of scanning rather than holding it for the whole file set.
    const slice = createTimeSlicer();
    for (const { rel, src } of sources) {
      if (!isScanned(rel)) continue;
      await slice();
      const lines = stripComments(rel, src).split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const match of lines[i]!.matchAll(NAME_RE)) {
          const name = match[0];
          const entry = declaredEntryFor(name);
          if (entry !== undefined) {
            used.add(entry);
            continue;
          }
          const sites = undeclared.get(name) ?? [];
          sites.push(`${rel}:${i + 1}`);
          undeclared.set(name, sites);
        }
      }
    }
    const stale = [...DECLARED_NAMES, ...PREFIXES]
      .filter((entry) => !used.has(entry))
      .sort();

    if (undeclared.size === 0 && stale.length === 0) return { ok: true };

    const problems: string[] = [];
    if (undeclared.size > 0) {
      const entries = [...undeclared.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, sites]) => `${name}\n        ${sites.join("\n        ")}`);
      problems.push(
        `${undeclared.size} SINGULARITY_* variable(s) not declared for the runtime tree:\n    ${entries.join("\n    ")}`,
      );
    }
    if (stale.length > 0) {
      problems.push(
        `${stale.length} declared name(s) that no code reads or sets any more:\n    ${stale.join("\n    ")}`,
      );
    }
    return {
      ok: false,
      message: problems.join("\n"),
      hint:
        "For each undeclared name, answer one question: should a backend inherit this from whoever starts the gateway? " +
        `Add it to RUNTIME_FORWARDED_ENV (yes — an installation setting every backend must see) or RUNTIME_WITHHELD_ENV (no — somebody's own state, delivered some other way) in ${DECLARATION}, with the one-line reason. ` +
        "Forwarded is what makes a variable the release launcher sets actually reach the backend; withheld is what keeps an agent shell's variables out of every backend on the host. " +
        "A stale name was declared for code that is gone: delete its entry.",
    };
  },
};

// ── launcher:gateway-env-explicit ──────────────────────────────────────────
//
// In Go, a command whose Env is left nil inherits the gateway's WHOLE
// environment — the leak the declaration exists to close, reachable again by
// one forgetful exec site. So the gateway has one file that reads its own
// environment and builds commands (gateway/env.go, which always sets Env from
// the declared names), and every other file goes through it. Go tests do not
// run in `./singularity check`, so the guard lives here.
const GATEWAY_ENV_FILE = "gateway/env.go";

// The calls that either read the gateway's own environment or start a process
// that inherits it when no Env is set. `exec.CommandContext` and
// `os.StartProcess` inherit exactly like `exec.Command`, so they are held to
// the same rule.
const INHERIT_RE =
  /\bos\.Environ\(|\bexec\.Command(?:Context)?\(|\bos\.StartProcess\(/;

const gatewayEnvExplicitCheck: Check = {
  id: "launcher:gateway-env-explicit",
  description:
    "Outside gateway/env.go, no non-test gateway file calls os.Environ(), exec.Command(Context)() or os.StartProcess(), so no child can fall back to inheriting the gateway's environment",
  async run() {
    const root = await getWorktreeRoot();
    const sources = await listCandidateSources({
      root,
      grepArg: "os\\.Environ\\(|exec\\.Command|os\\.StartProcess\\(",
      pathspecs: [":(glob)gateway/*.go"],
    });

    const offenders: string[] = [];
    for (const { rel, src } of sources) {
      if (rel === GATEWAY_ENV_FILE || isTestFile(rel)) continue;
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        // A comment that DESCRIBES the old call is not a call. Only whole-line
        // comments are skipped: a call followed by a trailing comment is still
        // caught, and a trailing comment that merely names one fails loudly
        // rather than hiding a real call behind a guess about where code ends.
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith("*")
        ) {
          continue;
        }
        if (INHERIT_RE.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${trimmed}`);
        }
      }
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `${offenders.length} gateway exec/environment call(s) outside ${GATEWAY_ENV_FILE}:\n    ${offenders.join("\n    ")}`,
      hint:
        `Start the process through the gateway's ChildEnv (${GATEWAY_ENV_FILE}): \`childEnv.Command(name, args...)\`, then \`cmd.Env = childEnv.With("NAME=value")\` for a per-child addition. ` +
        "A command built any other way leaves Env nil, and a nil Env in Go means the child inherits everything the gateway's starter carried. " +
        `The names a child may receive are declared in ${DECLARATION} and reach the gateway as -child-env.`,
    };
  },
};

// ── launcher:gateway-pure-go ───────────────────────────────────────────────
//
// The gateway builds with CGO_ENABLED=0 (`gateway-binary`, ../deps), so an
// install needs Go and nothing else — no clang, no SDK. Under that flag Go
// drops every file importing "C" from the build WITHOUT a word: a cgo file
// whose symbols nothing else names (an `init()` shim) simply never runs, and
// one that something does name fails the install on the user's machine rather
// than here. So a cgo import is refused at check time, tests included (a cgo
// test would be just as silently skipped).
const CGO_IMPORT_RE = /^\s*import\s+(?:\(\s*)?"C"/m;

const gatewayPureGoCheck: Check = {
  id: "launcher:gateway-pure-go",
  description:
    'No gateway Go file imports "C": the gateway builds with CGO_ENABLED=0, which would silently leave a cgo file out',
  async run() {
    const root = await getWorktreeRoot();
    const sources = await listCandidateSources({
      root,
      grepArg: '"C"',
      fixed: true,
      pathspecs: [":(glob)gateway/**/*.go"],
    });
    const offenders = sources
      .filter(({ src }) => CGO_IMPORT_RE.test(src))
      .map(({ rel }) => rel);

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `${offenders.length} gateway file(s) import "C":\n    ${offenders.join("\n    ")}`,
      hint:
        'The gateway is pure Go so installing it needs no C toolchain: with cgo, a darwin build links through clang + ld against the Command Line Tools SDK, and an ld older than its SDK fails every install ("tapi error: unknown architecture"). ' +
        "Rewrite it in Go (golang.org/x/sys/unix for a syscall). Native code that only a CLI op needs belongs in a fail-open build dependency, like packages/signal-origin's shim.",
    };
  },
};

// ── launcher:per-process-env-on-argv ───────────────────────────────────────
//
// Some values belong to ONE process: a backend's socket path is the socket
// that backend serves on, and nobody else's. In the environment such a value
// reaches every process the backend starts, forever — deleting it from
// `process.env` afterwards does not help, because a Bun child with no explicit
// `env` receives the environment its parent STARTED with. So these travel on
// argv, and their old environment names may not appear in code at all. A
// future move of a value onto argv can list transition sites — files still
// allowed to name the variable while old spawners and old readers coexist —
// and the check reports a site that no longer names it, so the list cannot
// outlive the transition code. SOCKET_PATH's transition is over: no sites.
//
// Comments are stripped first (a comment explaining the retirement reads
// nothing), and tests are exempt (a test asserting the variable's ABSENCE has
// to spell it).
const PER_PROCESS_ENV: Record<
  string,
  { argv: string; transitionSites: readonly string[] }
> = {
  SOCKET_PATH: {
    argv: "--socket",
    transitionSites: [],
  },
};

// This file spells every name it bans, in the table above.
const THIS_FILE = "plugins/infra/plugins/launcher/check/index.ts";

const perProcessEnvOnArgvCheck: Check = {
  id: "launcher:per-process-env-on-argv",
  description:
    "A per-process value (a backend's socket path) travels on argv, never in the environment: its old variable name may appear in code only at its listed transition sites (none for SOCKET_PATH)",
  async run() {
    const root = await getWorktreeRoot();
    const names = Object.keys(PER_PROCESS_ENV);
    const offenders: string[] = [];
    const named = new Set<string>();
    const slice = createTimeSlicer();
    for (const name of names) {
      const sources = await listCandidateSources({
        root,
        grepArg: name,
        fixed: true,
        pathspecs: NAME_PATHSPECS,
      });
      const re = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
      const allowed = PER_PROCESS_ENV[name]!.transitionSites;
      for (const { rel, src } of sources) {
        if (isTestFile(rel) || rel === THIS_FILE) continue;
        await slice();
        const lines = stripComments(rel, src).split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i]!)) continue;
          if (allowed.includes(rel)) named.add(`${name} ${rel}`);
          else offenders.push(`${name}  ${rel}:${i + 1}`);
        }
      }
    }
    const stale = names.flatMap((name) =>
      PER_PROCESS_ENV[name]!.transitionSites.filter(
        (site) => !named.has(`${name} ${site}`),
      ).map((site) => `${name}  ${site}`),
    );

    if (offenders.length === 0 && stale.length === 0) return { ok: true };

    const problems: string[] = [];
    if (offenders.length > 0) {
      problems.push(
        `${offenders.length} use(s) of a per-process variable outside its transition sites:\n    ${offenders.join("\n    ")}`,
      );
    }
    if (stale.length > 0) {
      problems.push(
        `${stale.length} transition site(s) that no longer name their variable:\n    ${stale.join("\n    ")}`,
      );
    }
    const argvHints = names
      .map((name) => `${name} → ${PER_PROCESS_ENV[name]!.argv}`)
      .join(", ");
    return {
      ok: false,
      message: problems.join("\n"),
      hint:
        `These values travel on argv (${argvHints}). A serving backend reads its socket with readServingSocket(), and code that must reach its own backend asks servingSocketPath() (@plugins/infra/plugins/runtime-identity/core). ` +
        "Never read or set the variable: in the environment it reaches every process the backend starts. " +
        `A stale site means its transition code is gone — delete the entry in ${THIS_FILE}.`,
    };
  },
};

export default [
  runtimeEnvDeclaredCheck,
  gatewayEnvExplicitCheck,
  gatewayPureGoCheck,
  perProcessEnvOnArgvCheck,
];
