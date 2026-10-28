import type { Check } from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  DECLARED_ENV_KEYS,
  DECLARED_ENV_PREFIXES,
  ENV_PREFIX,
  envKeyOf,
  isDeclaredEnvName,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
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

// ── launcher:env-names ─────────────────────────────────────────────────────
//
// Every variable the app reads or sets is one of two kinds, and the difference
// decides whether a backend may carry it:
//
//  - an installation setting (the data root, a release's vendored-file
//    locations, an operator knob), which must reach every backend; or
//  - somebody's own state (an agent's conversation id, a CLI run's build id, a
//    host grant), which must never reach one — a backend that inherited it
//    would act as whichever process happened to start the gateway.
//
// The declaration (`core/internal/env-keys.ts`) lists both kinds BY KEY, and
// the gateway spawn forwards only the first. TypeScript reaches a variable only
// through the key-typed helpers (`readEnv`, `envEntries`, …), so an undeclared
// key is a type error. What a type cannot see, this check holds:
//
//  1. No TypeScript CODE spells a full name (`EQUIN_<key>`). A full name
//     written by hand bypasses the declaration. Comments may name one;
//     strings, identifiers and template text may not.
//  2. Every full name ANY tracked file spells — a mirror that cannot import the
//     keys (the gateway's Go, the git hooks, the desktop shell's Rust, a shell
//     script, a JSON config), a comment, a doc — is a declared key, so a mirror
//     cannot read a variable nobody sets and a doc cannot keep a dead name.
//     Tests are left out of this one: a test of the filter spells a name
//     nobody declared on purpose.
//  3. Every declared key is still used: named as a key in TypeScript code
//     outside the declaration, or as a full name in a mirror (docs do not
//     count). A dead entry is deleted, not left to look load-bearing.
//
// Research notes are history and out of scope, like generated files.
const ENV_NAMES_RULE = "launcher:env-names";

// The env-name registry (the `env-names` sub-plugin). Its declaration names
// keys, never full names, but it is the one file whose key spellings are
// definitions rather than uses.
const ENV_NAMES_CORE = `${DECLARATION.replace(/\/core$/, "")}/plugins/env-names/core`;
const DECLARATION_FILE = `${ENV_NAMES_CORE}/internal/env-keys.ts`;

// A full variable name, not the tail of a longer identifier: the lookbehind is
// what leaves out globals like `__EQUIN_SCOPE__` (a menu-bar script
// placeholder) and the web-artifact globals, which no environment holds.
const FULL_NAME_RE = new RegExp(
  `(?<![A-Za-z0-9_])${ENV_PREFIX}[A-Z0-9_]+`,
  "g",
);

function isTypeScript(path: string): boolean {
  return /\.tsx?$/.test(path);
}

function isProse(path: string): boolean {
  return /\.(?:md|mdx|txt)$/.test(path) || path.endsWith("package.json");
}

/** Whether `code` (comments already blanked) names `key` as a key: a quoted string or an object key. */
function namesKey(code: string, key: string): boolean {
  const k = key.replace(/[^A-Z0-9_]/g, "");
  if (DECLARED_ENV_PREFIXES.includes(key)) {
    return new RegExp(`["'\`]${k}`).test(code);
  }
  return new RegExp(`["'\`]${k}["'\`]|(?<![A-Za-z0-9_$.])${k}\\s*:`).test(code);
}

const envNamesCheck: Check = {
  id: ENV_NAMES_RULE,
  description:
    "The app's environment variables are spelled by key: no full EQUIN_* name in TypeScript code, every full name a mirror or doc spells is declared in launcher/core, and every declared key is still used",
  exemptable: {
    [ENV_NAMES_RULE]:
      "spells a full variable name on purpose (a fixture of the rule itself)",
  },
  outOfScope: ["research", "generated"],
  async run(ctx) {
    const root = await getWorktreeRoot();
    const exempt = await ctx.exempt(ENV_NAMES_RULE);
    const byPath = new Map<string, string>();
    for (const { rel, src } of await listCandidateSources({
      root,
      grepArg: ENV_PREFIX,
      fixed: true,
      pathspecs: ["."],
    })) {
      byPath.set(rel, src);
    }

    const handSpelled: string[] = [];
    const undeclared = new Map<string, string[]>();
    const usedByMirror = new Set<string>();
    const slice = createTimeSlicer();
    for (const [rel, src] of byPath) {
      if (rel === DECLARATION_FILE || exempt.skips(rel)) continue;
      await slice();
      const ts = isTypeScript(rel);
      const code = ts ? stripComments(rel, src).split("\n") : [];
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const match of lines[i]!.matchAll(FULL_NAME_RE)) {
          const name = match[0];
          if (!isDeclaredEnvName(name)) {
            if (isTestFile(rel)) continue;
            const sites = undeclared.get(name) ?? [];
            sites.push(`${rel}:${i + 1}`);
            undeclared.set(name, sites);
          } else if (!ts && !isProse(rel)) {
            usedByMirror.add(name);
          }
        }
        if (ts) {
          for (const match of code[i]!.matchAll(FULL_NAME_RE)) {
            handSpelled.push(`${rel}:${i + 1}  ${match[0]}`);
          }
        }
      }
    }

    // Rule 3 reads TypeScript code that names keys, which need not spell a
    // full name at all — a second, narrower pass over the importers.
    const keyUsers = await listCandidateSources({
      root,
      grepArg: `@${ENV_NAMES_CORE}`,
      fixed: true,
      pathspecs: [":(glob)plugins/**/*.ts", ":(glob)plugins/**/*.tsx"],
    });
    const code = keyUsers
      .filter(({ rel }) => rel !== DECLARATION_FILE)
      .map(({ rel, src }) => stripComments(rel, src))
      .join("\n");
    const stale: string[] = [];
    for (const key of [...DECLARED_ENV_KEYS, ...DECLARED_ENV_PREFIXES]) {
      await slice();
      const mirrored = [...usedByMirror].some(
        (name) =>
          envKeyOf(name) === key ||
          (key.endsWith("_") && envKeyOf(name)?.startsWith(key)),
      );
      if (!mirrored && !namesKey(code, key)) stale.push(key);
    }

    if (
      handSpelled.length === 0 &&
      undeclared.size === 0 &&
      stale.length === 0
    ) {
      return { ok: true };
    }
    const problems: string[] = [];
    if (handSpelled.length > 0) {
      problems.push(
        `${handSpelled.length} full variable name(s) spelled in TypeScript code:\n    ${handSpelled.join("\n    ")}`,
      );
    }
    if (undeclared.size > 0) {
      const entries = [...undeclared.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, sites]) => `${name}\n        ${sites.join("\n        ")}`);
      problems.push(
        `${undeclared.size} variable name(s) that are not declared keys:\n    ${entries.join("\n    ")}`,
      );
    }
    if (stale.length > 0) {
      problems.push(
        `${stale.length} declared key(s) that no code reads or sets any more:\n    ${stale.sort().join("\n    ")}`,
      );
    }
    return {
      ok: false,
      message: problems.join("\n"),
      hint:
        `In TypeScript, name the KEY through @${ENV_NAMES_CORE}: \`readEnv("LANE")\`, \`{ ...process.env, ...envEntries({ LANE: x }) }\`, \`setEnv\` / \`setEnvDefault\` / \`unsetEnv\`, \`envName("LANE")\` in a message. ` +
        `A new variable is a new key in ${DECLARATION_FILE}, answering one question: should a backend inherit this from whoever starts the gateway? Yes → RUNTIME_FORWARDED_ENV (an installation setting every backend must see); no → RUNTIME_WITHHELD_ENV (somebody's own state, delivered some other way), with the one-line reason. ` +
        "A mirror (Go, shell, Rust, JSON) spells declared names only (gateway/env.go readEnv in Go). " +
        "A stale key was declared for code that is gone: delete its entry.",
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
// run in `./equin check`, so the guard lives here.
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

// Where a per-process variable could be read or set: TypeScript under
// plugins/, the gateway's Go, the git hooks and the desktop shell's Rust.
const NAME_PATHSPECS = [
  ":(glob)plugins/**/*.ts",
  ":(glob)plugins/**/*.tsx",
  ":(glob)gateway/*.go",
  ":(glob).githooks/*",
  ":(glob)tauri/**/*.rs",
];

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
  envNamesCheck,
  gatewayEnvExplicitCheck,
  gatewayPureGoCheck,
  perProcessEnvOnArgvCheck,
];
