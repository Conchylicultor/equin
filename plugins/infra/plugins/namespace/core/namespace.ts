// Canonical namespace identity.
//
// A NAMESPACE is the one name that a deployed app answers to. It is the
// subdomain in `http://<ns>.localhost:9000`, the spec-dir basename under
// `~/.singularity/worktrees/<ns>/`, the socket stem `<ns>.sock`, the Postgres
// database, the config dir, and the `--namespace` a backend is spawned with. All
// of those are the SAME string, which is exactly why there must be
// only one function that decides what it is.
//
// This file has ZERO imports on purpose, for the same reason
// `plugin-meta/composition/core/namespace.ts` does: the build-time tooling, the
// CLI, the server and the browser all have to ask the same questions, and a
// module with no imports is reachable from every one of those runtimes.
//
// The gateway (Go) deliberately does NOT implement the rule below. It treats a
// namespace as an opaque directory key — it maps a Host header to a spec dir and
// never decomposes it — so the elision rule exists in TypeScript only and has no
// second implementation to drift from. The one thing both sides must agree on is
// the GRAMMAR, and that agreement is a check (`namespace:grammar-in-sync`), not
// a comment.

/**
 * A gateway namespace: subdomain, spec-dir basename, socket stem, DB name.
 *
 * Branded so it cannot be confused with the other identity that looks exactly
 * like it — a CHECKOUT name (`checkoutWorktreeName(root)`, a directory
 * basename). Those two are equal today for every agent worktree, and stop being
 * equal the moment a composition is served from a non-main checkout. The brand
 * is what turns that divergence into a `tsc` error instead of a wrong path.
 */
export type Namespace = string & { readonly __brand: "Namespace" };

/**
 * Which checkout a namespace is served from.
 *
 * A discriminated union rather than a nullable string on purpose. The main
 * checkout's directory basename happens to BE `"singularity"`, so a plain
 * `checkout: string` lets a caller pass that basename and silently mint
 * `sonata.singularity` — a namespace for a checkout that should have elided.
 * With this union that spelling does not exist. Minted by `checkoutRef(root)`
 * (`@plugins/infra/plugins/paths/server`), the one place the "is this the main
 * checkout?" comparison is made.
 */
export type CheckoutRef =
  | { readonly kind: "main" }
  | { readonly kind: "worktree"; readonly name: string };

/**
 * The id of the composition the repo itself builds — the main app.
 *
 * Lives here, rather than beside the rest of the composition vocabulary, because
 * `namespaceFor` needs it and `infra -> plugin-meta` is the wrong direction.
 * `plugin-meta/composition/core/namespace.ts` imports it from here; its
 * zero-import reachability is preserved because this leaf is itself zero-import.
 */
export const MAIN_COMPOSITION_ID = "singularity";

/**
 * The id of the manifest row whose NEGATIVES every composition inherits.
 *
 * A composition says what it includes; this one row says what the repo has
 * decided is not in any app. `flattenManifest` folds it into every manifest
 * unconditionally — not via `extends`, which a new composition could forget —
 * so an exclusion written once holds everywhere. A composition takes a plugin
 * back by naming it explicitly, which the engine's protection rule already makes
 * win over any negative.
 *
 * Lives here beside `MAIN_COMPOSITION_ID` for the same reason: the closure
 * engine, the checks, the CLI and the browser all have to name this row, and a
 * zero-import leaf is reachable from every one of those runtimes.
 *
 * Like main's row it is a legal composition id but never a servable namespace —
 * its bundle is empty by construction, so `base-exclusions.localhost:9000` is a
 * namespace nothing could be served at.
 */
export const BASE_EXCLUSIONS_ID = "base-exclusions";

/** One DNS label: the charset that is also path-safe and Postgres-safe. */
export const NAMESPACE_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The longest a whole namespace may be, in bytes.
 *
 * A namespace IS a Postgres database name, and Postgres truncates `datname` at
 * `NAMEDATALEN - 1` = 63 bytes without complaining. Two namespaces that agree on
 * their first 63 bytes would therefore share ONE database — the worst possible
 * failure, because both apps keep working while writing over each other. The
 * charset is ASCII-only, so bytes and characters are the same count here.
 *
 * Per-label the cap is already implied (a label is at most 63), so it only bites
 * on the two-label form, where `<composition>.<checkout>` can reach 127.
 */
export const NAMESPACE_MAX_BYTES = 63;

/**
 * A whole namespace: one label, or two joined by a dot, at most
 * `NAMESPACE_MAX_BYTES` long.
 *
 * Written as a per-label composition rather than by adding `.` to the charset,
 * because this shape structurally forbids the only ways a dotted name could stop
 * being a single safe path segment: `..`, an empty label, a leading dot, a
 * trailing dot.
 *
 * Capped at TWO labels. The model has exactly two axes — composition and
 * checkout — so a third label is not a thing that can be meant. The gateway's
 * own regex is deliberately looser (it validates path-safety, not meaning); the
 * semantic cap belongs here, where the axes are known.
 *
 * The leading lookahead is the byte cap — see `NAMESPACE_MAX_BYTES`. It lives in
 * the regex as well as in `namespaceFor`'s throw so that every VALIDATING
 * boundary (`asNamespace`, `isNamespace`, `namespaceFromHost`) gets it too: a
 * 90-byte name arriving on a Host header is as much a collided database as one
 * that was minted.
 */
export const NAMESPACE_RE =
  /^(?=.{1,63}$)[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62})?$/;

/**
 * Mint the namespace for a (composition, checkout) pair — THE elision rule.
 *
 * | composition   | checkout    | namespace          |
 * |---------------|-------------|--------------------|
 * | `singularity` | main        | `singularity`      |
 * | `singularity` | `att-X`     | `att-X`            |
 * | `sonata`      | main        | `sonata`           |
 * | `sonata`      | `att-X`     | `sonata.att-X`     |
 *
 * Both sentinels elide, which is what preserves every URL in use today. The
 * cost is that a single label is AMBIGUOUS — `foo` could be composition `foo` on
 * main, or the main composition on checkout `foo`. That ambiguity is inherent,
 * not an artifact of this encoding: any scheme preserving both of today's URL
 * shapes maps two pairs onto one label. It is therefore PREVENTED rather than
 * decoded — see `namespaceCollision`
 * (`@plugins/infra/plugins/worktree/server`), which refuses whichever side tries
 * to claim an already-occupied name.
 *
 * There is deliberately no FULL inverse. Decomposing a single label back into
 * its pair would need the composition set at every call site, so instead the
 * pair is RECORDED where it is minted (`composition.json`'s `composition` +
 * `checkout`). Provenance on disk cannot be ambiguous; a name can. The one part
 * a name does fix — a two-label name names both halves — is read back by
 * `namespaceParts`, which hands a single label back undecided.
 */
export function namespaceFor(
  composition: string,
  checkout: CheckoutRef,
): Namespace {
  if (!NAMESPACE_LABEL_RE.test(composition)) {
    throw new Error(
      `Invalid composition id "${composition}" — must match ${NAMESPACE_LABEL_RE}.`,
    );
  }
  if (checkout.kind === "worktree" && !NAMESPACE_LABEL_RE.test(checkout.name)) {
    throw new Error(
      `Invalid checkout name "${checkout.name}" — must match ${NAMESPACE_LABEL_RE}.`,
    );
  }

  const isMainComposition = composition === MAIN_COMPOSITION_ID;
  if (checkout.kind === "main") {
    // Main checkout: the suffix elides, so the namespace is just the
    // composition — including main's own, whose id IS the main namespace.
    return composition as Namespace;
  }
  if (isMainComposition) {
    // Main composition on a worktree: the prefix elides. This is the shape every
    // agent worktree has today (`att-XXX`).
    return checkout.name as Namespace;
  }
  const ns = `${composition}.${checkout.name}`;
  if (ns.length > NAMESPACE_MAX_BYTES) {
    // Enforced HERE, at the minter, rather than by a check over the manifest:
    // a check only sees the compositions someone wrote down, while the checkout
    // half is a git worktree basename an agent invents at runtime. Only the
    // place that joins the two can see the length that results, and the failure
    // it prevents is silent — see `NAMESPACE_MAX_BYTES`.
    throw new Error(
      `Namespace "${ns}" is ${ns.length} bytes — the limit is ${NAMESPACE_MAX_BYTES}, ` +
        `because a namespace is a Postgres database name and Postgres truncates ` +
        `datname at 63 bytes, so a longer one would silently share a database with ` +
        `another namespace. Shorten the composition id or the checkout name.`,
    );
  }
  return ns as Namespace;
}

/**
 * What a namespace's NAME alone says about its (composition, checkout) pair.
 *
 * | namespace      | parts                                                   |
 * |----------------|---------------------------------------------------------|
 * | `sonata.att-X` | `{ kind: "pair", composition: "sonata", checkout: "att-X" }` |
 * | `att-X`        | `{ kind: "label", label: "att-X" }`                     |
 * | `sonata`       | `{ kind: "label", label: "sonata" }`                    |
 *
 * Only the two-label form decodes: `namespaceFor` joins with a dot exactly when
 * neither half elided, so a dot means both halves are present. A single label
 * stays a `label` — the main composition on checkout `label`, or composition
 * `label` on the main checkout; see `namespaceFor` for why the name cannot say
 * which. A union rather than a nullable checkout so a caller cannot read that
 * ambiguity as "no checkout": it has to decide, with whatever context it has,
 * what a lone label means to it.
 */
export type NamespaceParts =
  | {
      readonly kind: "pair";
      readonly composition: string;
      readonly checkout: string;
    }
  | { readonly kind: "label"; readonly label: string };

/** Split a namespace into what its name fixes. See `NamespaceParts`. */
export function namespaceParts(ns: Namespace): NamespaceParts {
  const dot = ns.indexOf(".");
  if (dot < 0) return { kind: "label", label: ns };
  return {
    kind: "pair",
    composition: ns.slice(0, dot),
    checkout: ns.slice(dot + 1),
  };
}

/**
 * The namespace the main app answers to.
 *
 * DERIVED, not a second literal: it is what the elision rule yields for the main
 * composition on the main checkout. Spelling `"singularity"` as a constant a
 * second time is how that string came to mean two different things in two files.
 *
 * It lives here rather than in `paths` because it is namespace data, not a path:
 * nothing about a filesystem takes part in deriving it.
 */
export const MAIN_WORKTREE_NAME: Namespace = namespaceFor(MAIN_COMPOSITION_ID, {
  kind: "main",
});

/**
 * Extra host labels the gateway serves as an existing namespace: `equin` is
 * `singularity`, so `http://equin.localhost:9000` opens the main app.
 *
 * An alias is a HOST spelling only — it is never minted (`namespaceFor` cannot
 * yield one), never a spec dir, socket or database, and `namespaceFromHost`
 * resolves it to its target, so nothing past the Host header ever sees it.
 * `namespaceCollision` (`@plugins/infra/plugins/worktree/server`) refuses a
 * checkout or composition that would take an alias's name, because the gateway
 * would never route to it.
 *
 * Exists to move the app off the `singularity` name gradually: the old host
 * keeps working while the new one is the one to use.
 *
 * KEEP IN SYNC with `hostAliases` in gateway/proxy.go — enforced by the
 * `namespace:grammar-in-sync` check.
 */
export const NAMESPACE_HOST_ALIASES: Readonly<Record<string, Namespace>> = {
  equin: MAIN_WORKTREE_NAME,
};

/** Whether `name` is a host alias rather than a namespace of its own. */
export function isNamespaceHostAlias(name: string): boolean {
  return Object.hasOwn(NAMESPACE_HOST_ALIASES, name);
}

/**
 * Validating cast at a serialization boundary — an env var, a spec-dir basename,
 * a DB row, a URL host.
 *
 * Unlike `asPluginId`, this VALIDATES rather than just casting. A namespace
 * becomes a filesystem path and a database name, so a malformed one is a hazard
 * rather than a display bug; the boundary is the right place to be loud.
 */
export function asNamespace(raw: string): Namespace {
  if (!NAMESPACE_RE.test(raw)) {
    throw new Error(
      `Invalid namespace "${raw}" — must match ${NAMESPACE_RE} ` +
        `(one or two dot-joined labels of [a-z0-9][a-z0-9-]*).`,
    );
  }
  return raw as Namespace;
}

/** Non-throwing twin of `asNamespace`, for render paths and untrusted input. */
export function isNamespace(raw: string): boolean {
  return NAMESPACE_RE.test(raw);
}

/** The port every browser-facing namespace is served on. */
export const GATEWAY_PORT = 9000;

/** The DNS suffix every namespace is served under. */
export const NAMESPACE_HOST_SUFFIX = ".localhost";

/**
 * The host authority for a namespace: `<ns>.localhost:9000`.
 *
 * Use this (or `namespaceUrl`) rather than interpolating `.localhost` by hand —
 * `no-hand-built-namespace-url` enforces it. Two dozen hand-built copies is how
 * the port and the suffix ended up spelled in two dozen places.
 */
export function namespaceHost(
  ns: Namespace,
  port: number = GATEWAY_PORT,
): string {
  return `${ns}${NAMESPACE_HOST_SUFFIX}:${port}`;
}

/**
 * The origin (plus optional path) a namespace is reachable at.
 *
 * `path` is appended verbatim and must start with `/` when present, so the
 * result is an origin when omitted and never a double slash when given.
 */
export function namespaceUrl(
  ns: Namespace,
  path = "",
  port: number = GATEWAY_PORT,
): string {
  if (path && !path.startsWith("/")) {
    throw new Error(`namespaceUrl path must start with "/" — got "${path}".`);
  }
  return `http://${namespaceHost(ns, port)}${path}`;
}

/**
 * Read a namespace back off a browser `location.host` (or any Host header).
 *
 * The TypeScript mirror of the gateway's `parseWorktree` (`gateway/proxy.go`),
 * and the reason the four hand-rolled copies of this — which disagreed with each
 * other AND with the gateway, one of them taking `host.split(".")[0]` — collapse
 * to one function. Returns `null` for the loopback hosts and anything not served
 * under `.localhost`, which is how "no namespace here" is spelled. A host alias
 * (`NAMESPACE_HOST_ALIASES`) reads back as the namespace it stands for.
 */
export function namespaceFromHost(host: string): Namespace | null {
  let h = host;
  // Bracketed IPv6 (`[::1]:9000`) before the port strip, since it contains ':'.
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end >= 0) h = h.slice(1, end);
  } else {
    const i = h.lastIndexOf(":");
    if (i > 0) h = h.slice(0, i);
  }
  h = h.toLowerCase();
  // A fully-qualified host may carry a trailing root dot.
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return null;
  if (!h.endsWith(NAMESPACE_HOST_SUFFIX)) return null;
  const name = h.slice(0, -NAMESPACE_HOST_SUFFIX.length);
  if (isNamespaceHostAlias(name)) return NAMESPACE_HOST_ALIASES[name]!;
  return isNamespace(name) ? (name as Namespace) : null;
}
