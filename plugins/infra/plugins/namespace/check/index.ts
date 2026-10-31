import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  grepCode,
  listCandidateSources,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
// Own-plugin, so relative — the `@plugins/infra/plugins/namespace/core` alias
// would name this plugin from inside itself. Same shape as `paths/check`
// importing `../core/internal/paths`.
import {
  CONTENT_HOST_LABEL,
  CONTENT_ITEM_RE,
  NAMESPACE_HOST_ALIASES,
  NAMESPACE_HOST_LABELS,
  NAMESPACE_HOST_SUFFIX,
  NAMESPACE_LABEL_RE,
  NAMESPACE_MAX_BYTES,
  MAIN_WORKTREE_NAME,
} from "../core/namespace";

/**
 * The two shapes that ARE namespace identity, as opposed to the many benign
 * mentions of `.localhost` in the tree.
 *
 * A bare `.localhost` grep is useless here: it also matches sample URLs in test
 * fixtures, `--help` text, check hints and the SSRF guard — 26 hits, 23 of them
 * fine. What actually went wrong is narrower, and is greppable exactly:
 *
 *  - BUILDING a host out of a value. Every one of the ~25 swept sites was an
 *    interpolation followed by the suffix — which is also how the port came to
 *    be written out 25 times.
 *  - PARSING the suffix back off a host. Four call sites did this four different
 *    ways; one took `host.split(".")[0]`, which silently yields `sonata` for
 *    `sonata.att-x.localhost`.
 *
 * A hardcoded literal like `http://equin.localhost:9000` in a test fixture
 * is deliberately NOT matched. It is sample data rather than a derivation, and
 * it cannot drift from the rule because it names nothing live.
 */
const PATTERNS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  {
    pattern: /\$\{[^}]*\}\.localhost/,
    what: "builds a namespace host from a value",
  },
  {
    pattern: /["'`]\.localhost/,
    what: "parses the namespace host suffix by hand",
  },
];

const RULE = "namespace:no-hand-built-url";

const noHandBuiltNamespaceUrlCheck: Check = {
  // INPUT-KEYED (Stage 1). Pure `grepCode` — see no-raw-websocket for rationale.
  inputKeyed: true,
  id: "namespace:no-hand-built-url",
  description:
    "A namespace URL or host must be built with namespaceUrl()/namespaceHost() and read back with namespaceFromHost(), never by spelling the host suffix inline",
  exemptable: {
    [RULE]:
      "spells the namespace host suffix inline (builds or parses a `.localhost` host) for a purpose that is not namespace identity",
  },
  outOfScope: ["research"],
  async run(ctx) {
    const root = await getWorktreeRoot();
    const exempt = await ctx.exempt(RULE);
    const offenders: string[] = [];

    for (const { pattern, what } of PATTERNS) {
      const matches = await grepCode({
        root,
        pattern,
        // Fast candidate pre-filter only; `pattern` is what actually decides.
        grepArg: ".localhost",
        fixed: true,
        // `grepCode` always masks COMMENTS, which is what keeps docstrings and
        // check hints out of this. String interiors must SURVIVE — the suffix
        // being looked for lives inside a literal.
        maskStrings: false,
      });
      for (const m of matches) {
        if (exempt.skips(m.path)) continue;
        offenders.push(
          `${m.path}:${m.line} — ${what}\n        ${m.text.trim()}`,
        );
      }
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `hand-built namespace host in ${offenders.length} place(s):\n    ${offenders.join("\n    ")}`,
      hint:
        "Build one with `namespaceUrl(ns, path?)` / `namespaceHost(ns)` and read one back with `namespaceFromHost(location.host)`, from `@plugins/infra/plugins/namespace/core`. " +
        "A namespace is `<composition>.<checkout>` with both sentinels elided, so only the owner knows how many labels that is — which is why the four hand-rolled parsers disagreed with each other and with the gateway. " +
        "If your line is genuinely not namespace identity (an SSRF guard, a navigation heuristic), declare it in your own plugin's `exempt/index.ts` (rule `namespace:no-hand-built-url`) with the reason.",
    };
  },
};

/**
 * The namespace vocabulary exists in two languages, and only one of them can
 * import the other's copy.
 *
 * `namespace/core/namespace.ts` is the source of truth, and every TypeScript
 * caller imports it — including `server-core/bin/select-registry.ts`, which runs
 * before anything else a backend does. It used to carry inline copies, justified
 * by a `config_v2` closure that predates the namespace plugin being extracted;
 * the owner is a zero-import module today and `paths/core` (already in the boot
 * closure) imports it, so the copies were deleted rather than pinned. That is
 * rung 1 — there is nothing to keep in sync — where this check is rung 3.
 *
 * What remains is the gateway, in Go, which cannot import TypeScript. Its copy
 * cannot be deleted, so the agreement is asserted instead.
 *
 * The Go copy is matched against a DIFFERENT expected pattern than the owner's
 * own `NAMESPACE_RE`, on purpose: the gateway composes the label into an
 * UNCAPPED multi-label name, because it validates path-safety, not meaning. Its
 * 63-byte cap is a separate constant rather than a regex clause, because Go's
 * RE2 has no lookahead.
 *
 * What must not drift is the label rule itself — the charset and the length —
 * plus the byte cap, which is the difference between two namespaces having two
 * databases and silently sharing one — and the host aliases, since an alias the
 * browser reads back that the gateway does not route is a page that never loads.
 */
const grammarInSyncCheck: Check = {
  id: "namespace:grammar-in-sync",
  description:
    "The gateway's Go copy of the namespace grammar, byte cap and host aliases, and the menu-bar helper's main host label, must match the namespace plugin's",
  async run() {
    const root = await getWorktreeRoot();
    // The label rule as it appears inside a regex literal, anchors stripped —
    // the part both spellings share.
    const label = NAMESPACE_LABEL_RE.source
      .replace(/^\^/, "")
      .replace(/\$$/, "");

    const sites = [
      {
        path: "gateway/registry.go",
        // `^<label>(\.<label>)*$` — the label, composed into a multi-label name.
        expect: "`^" + label + "(\\." + label + ")*$`",
        what: "nameRegex",
      },
      {
        path: "gateway/registry.go",
        expect: `maxNamespaceBytes = ${NAMESPACE_MAX_BYTES}`,
        what: "the namespace byte cap",
      },
      {
        path: "gateway/content.go",
        expect: `contentHostLabel = "${CONTENT_HOST_LABEL}"`,
        what: "the content host label",
      },
      {
        path: "gateway/content.go",
        expect: "`" + CONTENT_ITEM_RE.source + "`",
        what: "the content item grammar",
      },
      ...Object.entries(NAMESPACE_HOST_ALIASES).map(([alias, target]) => ({
        path: "gateway/proxy.go",
        expect: `"${alias}": "${target}",`,
        what: `the host alias ${alias} → ${target} (hostAliases)`,
      })),
      {
        // The menu-bar helper loads main's panel (and points its app shims) at
        // the host main is handed out under, not its internal name.
        path: "plugins/menu-bar/rust/src/cli.rs",
        expect: `MAIN_HOST_LABEL: &str = "${NAMESPACE_HOST_LABELS[MAIN_WORKTREE_NAME]}";`,
        what: "main's host label (MAIN_HOST_LABEL)",
      },
    ];

    const offenders: string[] = [];
    for (const site of sites) {
      const text = await readFile(join(root, site.path), "utf8");
      if (!text.includes(site.expect)) {
        offenders.push(
          `${site.path}: ${site.what} does not contain the expected literal ${site.expect}`,
        );
      }
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `namespace grammar out of sync in ${offenders.length} place(s):\n    ${offenders.join("\n    ")}`,
      hint:
        "plugins/infra/plugins/namespace/core/namespace.ts is the source of truth for both of these. " +
        "The gateway's copy exists only because Go cannot import it — every TypeScript caller imports the owner instead. " +
        "Update gateway/registry.go (grammar, cap) or gateway/proxy.go (hostAliases) to match: a namespace the gateway rejects is a 404 that cannot be debugged from the TypeScript side, " +
        "and a byte cap the two sides disagree on is two apps silently sharing one Postgres database.",
    };
  },
};

const LEGACY_HOST_RULE = "namespace:legacy-host";

/**
 * The hosts a namespace answers on but is no longer handed out under: its own
 * name, wherever `NAMESPACE_HOST_LABELS` gives it a public label instead.
 */
const LEGACY_HOSTS = Object.entries(NAMESPACE_HOST_LABELS).map(
  ([ns, label]) => ({
    host: `${ns}${NAMESPACE_HOST_SUFFIX}`,
    current: `${label}${NAMESPACE_HOST_SUFFIX}`,
  }),
);

/**
 * People and agents copy the address they read — in a doc, a hint, an e2e
 * header, a fixture — so every one of them says the public one. The old host
 * keeps working as an alias, which is exactly why a stale mention would never
 * fail on its own: this check is the only thing that notices one. Code cannot
 * spell it at all, since it derives addresses through `namespaceUrl`.
 *
 * Every tracked text file is in scope, prose included.
 */
const legacyHostCheck: Check = {
  id: LEGACY_HOST_RULE,
  // INPUT-KEYED: a pure function of the `git grep -l` selection, its
  // candidates' content and the exemption manifests — all recorded.
  inputKeyed: true,
  description:
    "no tracked file names a namespace by a host it is no longer handed out under (main's old address) — write the public one",
  exemptable: {
    [LEGACY_HOST_RULE]:
      "names a namespace's legacy host on purpose — e.g. a test that the old address still resolves",
  },
  async run(ctx) {
    const exempt = await ctx.exempt(LEGACY_HOST_RULE);
    const offenders: string[] = [];
    for (const { host, current } of LEGACY_HOSTS) {
      const pattern = new RegExp(
        String.raw`(?<![\w.-])${host.replace(/\./g, String.raw`\.`)}`,
      );
      const candidates = await listCandidateSources({
        grepArg: host,
        fixed: true,
        pathspecs: ["."],
      });
      for (const { rel, src } of candidates) {
        if (exempt.skips(rel)) continue;
        src.split("\n").forEach((text, i) => {
          if (pattern.test(text)) {
            offenders.push(
              `${rel}:${i + 1} — write ${current}\n        ${text.trim()}`,
            );
          }
        });
      }
    }

    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${offenders.length} mention(s) of a legacy namespace host:\n    ${offenders.join("\n    ")}`,
      hint:
        "Write the public host (`NAMESPACE_HOST_LABELS` in `plugins/infra/plugins/namespace/core`) — in docs, comments, fixtures and e2e headers alike. " +
        "Code builds an address with `namespaceUrl(ns)` / `namespaceHost(ns)`, never a literal. " +
        `A file that must spell the old host (a test that it still resolves) declares a \`${LEGACY_HOST_RULE}\` exemption in its plugin's \`exempt/index.ts\`.`,
    };
  },
};

export default [
  noHandBuiltNamespaceUrlCheck,
  grammarInSyncCheck,
  legacyHostCheck,
];
