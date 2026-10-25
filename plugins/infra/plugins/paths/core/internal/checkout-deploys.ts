import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MAIN_COMPOSITION_ID,
  MAIN_WORKTREE_NAME,
  asNamespace,
  isNamespace,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
// Relative siblings: this file lives INSIDE the `paths` plugin, so the
// `@plugins/infra/plugins/paths/core` alias would cycle back through the barrel
// that re-exports it. Same reasoning as `data-dirs-manifest.ts`.
import { SERVER_CORE_RELATIVE, worktreeArtifacts, worktreesDir } from "./paths";
import { listWorktreeDirs } from "./worktree-dirs";

// Which deploys a CHECKOUT published — read back out of the registry that
// checkout wrote, never guessed from a directory basename.
//
// Three questions on this machine look alike and are not:
//
//   which namespace is THIS RUNTIME the server for?  `runtimeNamespace()`
//     — the `--namespace` the gateway spawned it with, declared at its entry
//       point. Only a runtime has one; in a CLI process asking throws, which is
//       what stops the answer from being a guess.
//   which namespace does THIS CHECKOUT own?           `checkoutNamespace(root)`
//     — minted from git, and true whether or not anything is deployed.
//   which deploy did this checkout PUBLISH?           this file.
//
// The third is the one a script that wants to DRIVE the app is asking, and it
// cannot be derived from either of the other two: a checkout that has never been
// built serves nothing, and a `--composition` build publishes a namespace whose
// name shares no label with the checkout's own. It was recorded at mint time
// instead — every deploy writes `spec.json` with the absolute path of the
// checkout whose backend answers it (`writeWorktreeSpec`, from
// `deployNamespace`) — so the answer is a read, not a guess. `namespaceFor`'s
// own docblock states the rule this rests on: provenance on disk cannot be
// ambiguous, a name can.
//
// Sync, git-free and env-free (beyond the data root every path here shares), so
// an e2e script can resolve its target before it has launched anything.

/** One namespace this checkout's backend is registered to serve. */
export interface CheckoutDeploy {
  readonly namespace: Namespace;
  /** Absent `spec.composition` means the main app (the legacy shape). */
  readonly composition: string;
  readonly isMainComposition: boolean;
}

/**
 * Either the deploy that was asked for, or what this checkout DOES serve.
 *
 * The `none` arm carries `others` because "nothing at all" and "everything
 * except the one you asked for" need different fixes, and only the caller
 * rendering the refusal can say so: an empty list means `./equin build`
 * has never run here, while a populated one means this checkout published
 * somebody else's composition and never its own app.
 *
 * It carries `scanned` for the same reason one level up. With `others` empty,
 * "nothing matched" is still two situations — a machine with no registry at all
 * (a fresh install, a wiped data dir) and a machine whose registry is full and
 * contains nothing of ours — and the fix differs. The count is the only thing
 * that separates them, and the caller cannot recover it afterwards without
 * re-reading the directory the scan already read.
 */
export type CheckoutDeployResolution =
  | { kind: "resolved"; deploy: CheckoutDeploy }
  | { kind: "none"; others: readonly CheckoutDeploy[]; scanned: number };

/**
 * What one registered namespace's `spec.json` says, or why it says nothing.
 *
 * Three arms rather than a nullable spec, because the difference between the
 * first two is the whole correctness of the scan. A namespace dir with NO spec
 * is an ordinary, common state — six of the seventy-odd dirs on this machine are
 * in it (a reaped worktree, a namespace registered by something that never
 * finished) — and skipping it is not tolerance for a fault. A spec that EXISTS
 * and cannot be understood is a fault, because it may be the very one naming
 * this checkout; folding the two together would let a corrupt spec silently
 * become "you never built".
 */
type SpecRead =
  | { kind: "absent" }
  | { kind: "malformed"; reason: string }
  | { kind: "deploy"; server: string; composition: string };

function readDeploySpec(path: string): SpecRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOTDIR alongside ENOENT for the reason `statManifest` folds them
    // together: both answer "is there a spec here" with no, and a namespace dir
    // that is really a file must not take the whole scan down with it.
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    // EACCES, EISDIR, an I/O error: the spec is there and we cannot read it,
    // which is not the same as there being none.
    return { kind: "malformed", reason: `unreadable (${String(code ?? err)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      kind: "malformed",
      reason: `not JSON (${(err as Error).message})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed", reason: "not a JSON object" };
  }

  const spec = parsed as { server?: unknown; composition?: unknown };
  if (typeof spec.server !== "string" || spec.server === "") {
    return { kind: "malformed", reason: '"server" is not a path' };
  }
  if (spec.composition !== undefined && typeof spec.composition !== "string") {
    return {
      kind: "malformed",
      reason: `"composition" must be a string, got ${typeof spec.composition}`,
    };
  }
  return {
    kind: "deploy",
    server: spec.server,
    // Absent — and empty, which `writeWorktreeSpec` never writes and
    // `selectRegistry` already reads as the main app — is the pre-composition
    // shape every legacy spec has.
    composition: spec.composition ? spec.composition : MAIN_COMPOSITION_ID,
  };
}

/**
 * The comparable form of a path: symlinks resolved where the path exists,
 * lexically resolved where it does not.
 *
 * BOTH sides of the match go through this, and that is the point. The writer
 * resolves the `server` field against `getWorktreeRoot()` (git's toplevel) and a
 * reader resolves its own against `REPO_ROOT` (derived from `import.meta.dir`).
 * The two agree on a plain checkout and diverge the moment either is reached
 * through a symlink — silently, because a divergence produces no error: nothing
 * matches, so every script in that checkout is told it published nothing, which
 * reads as "you never built" and sends the reader after the wrong fix. It would
 * do that to every run in the checkout, not to one.
 *
 * ENOENT is not a failure here. A spec outlives the checkout it names, and a
 * path that does not exist has no symlinks to resolve — so its lexical form is
 * the best identity available, and it is the form both sides fall back to, so
 * they still agree. Anything else (EACCES, a symlink loop, an I/O error) is a
 * real fault and throws — which is right for the caller's OWN root, and wrong
 * for a path that came out of somebody else's spec: see `comparableSpecPath`.
 */
function comparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    throw err;
  }
}

/**
 * The same resolution for a path READ OUT OF A SPEC, where a fault belongs to
 * that spec and must not escape the scan.
 *
 * `comparablePath`'s throw is correct about our own root — if we cannot resolve
 * the checkout we are standing in, nothing below can mean anything. It is
 * exactly wrong about a `server` field: an EACCES on some path component, a
 * symlink loop, an EIO from a dead network mount are properties of one of the
 * ~70 specs on a shared, host-global registry, and letting one of them out of
 * here breaks every e2e script, every `withBrowser` and every `agentFetch` in
 * EVERY checkout on the machine, with an error naming a namespace the reader
 * has nothing to do with.
 *
 * So it joins the `malformed` list, and gets the protection that list already
 * provides: warned about when something else matched, raised only when nothing
 * did. This is a second read of the same spec's contents, so it belongs under
 * the same rule as the first.
 */
function comparableSpecPath(
  path: string,
): { kind: "path"; path: string } | { kind: "fault"; reason: string } {
  try {
    return { kind: "path", path: comparablePath(path) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      kind: "fault",
      reason: `server path unresolvable (${String(code ?? err)})`,
    };
  }
}

/**
 * The whole outcome of one scan: what matched, and how much was looked at.
 *
 * `scanned` rides along because a caller cannot recover it afterwards — an
 * empty result says nothing about whether the registry was empty or merely
 * held nobody's deploy but ours — and re-deriving it from a second
 * `listWorktreeDirs()` would count entries this scan skipped.
 */
interface CheckoutScan {
  readonly deploys: CheckoutDeploy[];
  /** Namespace-named directories examined under `worktreesDir()`. */
  readonly scanned: number;
}

/**
 * Every namespace registered to `root`'s backend, the main composition first.
 *
 * One small synchronous read per registered namespace (~70 on a working box),
 * so it is cheap enough to sit in front of anything.
 *
 * Directory names are filtered with `isNamespace`, never `asNamespace`: the
 * worktrees dir is a shared, host-global directory that anything may leave a
 * folder in, and one stray name that fails the grammar would throw here and
 * break every caller on the machine over a directory that is not even a
 * candidate.
 *
 * @throws when specs could not be read AND nothing matched — see the decision
 *   below, which is deliberately made after the whole scan.
 */
function scanCheckout(root: string): CheckoutScan {
  const ours = comparablePath(join(root, SERVER_CORE_RELATIVE));
  const deploys: CheckoutDeploy[] = [];
  const malformed: string[] = [];
  let scanned = 0;

  for (const name of listWorktreeDirs()) {
    if (!isNamespace(name)) continue;
    scanned += 1;
    const path = worktreeArtifacts.spec(asNamespace(name));
    const read = readDeploySpec(path);
    if (read.kind === "absent") continue;
    if (read.kind === "malformed") {
      malformed.push(`${path}: ${read.reason}`);
      continue;
    }
    const server = comparableSpecPath(read.server);
    if (server.kind === "fault") {
      malformed.push(`${path}: ${server.reason}`);
      continue;
    }
    if (server.path !== ours) continue;
    deploys.push({
      namespace: asNamespace(name),
      composition: read.composition,
      isMainComposition: read.composition === MAIN_COMPOSITION_ID,
    });
  }

  // The checkout's own app first; the rest by name, so a refusal listing them
  // reads the same twice in a row. `readdir` order is not an order.
  deploys.sort((a, b) => {
    if (a.isMainComposition !== b.isMainComposition)
      return a.isMainComposition ? -1 : 1;
    return a.namespace.localeCompare(b.namespace);
  });

  // DECIDED AFTER THE WHOLE SCAN, never during it. A corrupt spec matters only
  // when nothing else answered: it may be the one naming this checkout, and
  // there is then no way to tell "you never built" from "your spec is broken".
  // With a match in hand it is somebody else's namespace and cannot change this
  // answer — so it is reported, not raised. Deciding mid-scan would make the
  // outcome depend on `readdir` order for identical on-disk state.
  if (malformed.length > 0) {
    const list = `\n  ${malformed.join("\n  ")}`;
    if (deploys.length === 0) {
      throw new Error(
        `Cannot say which deploy this checkout published: no readable spec under ` +
          `${worktreesDir()} names it, and ${malformed.length} could not be used — ` +
          `one of them may be the one:${list}\n` +
          `Repair or remove them (a build of that namespace rewrites its spec), then re-run.`,
      );
    }
    console.warn(
      `Ignoring ${malformed.length} unusable spec(s) while resolving this ` +
        `checkout's deploys:${list}`,
    );
  }

  return { deploys, scanned };
}

/**
 * Every namespace registered to `root`'s backend, the main composition first —
 * the scan without its denominator, which is all any caller outside this file
 * has ever wanted.
 *
 * @throws when specs could not be used AND nothing matched — see `scanCheckout`.
 */
export function deploysForCheckout(root: string): CheckoutDeploy[] {
  return scanCheckout(root).deploys;
}

/**
 * The one deploy a caller means: this checkout's own app, or the named
 * composition's namespace.
 *
 * `composition` is the only way to name a composition-only deploy
 * (`sonata.att-x`), whose namespace shares no label with the checkout it was
 * built from — the case a basename gets silently wrong.
 */
export function resolveCheckoutDeploy(
  root: string,
  composition?: string,
): CheckoutDeployResolution {
  const { deploys, scanned } = scanCheckout(root);
  const matches = deploys.filter((d) =>
    composition === undefined
      ? d.isMainComposition
      : d.composition === composition,
  );
  const [deploy, ...alsoMatched] = matches;
  if (deploy === undefined) return { kind: "none", others: deploys, scanned };

  // Two namespaces answering for the same composition of the same checkout is a
  // silently-chosen deploy — the shape this whole module exists to abolish —
  // and it is reachable: `serve-app --name other` beside an ordinary build, or a
  // spec left behind when a namespace was renamed. It gets a warning rather than
  // an `ambiguous` arm because every caller would then have to branch on a state
  // whose repair is deleting one directory; the pick is deterministic
  // (alphabetical, main composition first), so what it needs is to be VISIBLE.
  if (alsoMatched.length > 0) {
    const wanted =
      composition === undefined
        ? `this checkout's own app (composition "${MAIN_COMPOSITION_ID}")`
        : `composition "${composition}"`;
    console.warn(
      `This checkout is registered to ${matches.length} namespaces for ${wanted}: ` +
        `using ${deploy.namespace}, ignoring ${alsoMatched.map((d) => d.namespace).join(", ")}. ` +
        `Only one of them can be the deploy it published — remove the stale spec(s) ` +
        `under ${worktreesDir()} (a build of a namespace rewrites its own).`,
    );
  }
  return { kind: "resolved", deploy };
}

/**
 * Which checkout this data root's main app (the main namespace) is served from —
 * read from the `spec.json` that checkout's build wrote, like every other
 * "who published this?" answer in this file.
 *
 * `unclaimed` when no checkout on disk holds it: no spec yet (a fresh machine),
 * or a spec naming a checkout that no longer exists (the repo was moved). Both
 * mean the next main checkout to ask may take the name.
 *
 * Throws on a spec that exists and cannot be read: this answer decides which
 * checkout is allowed to act as main, and "unreadable" must not become
 * "unclaimed" — that would let any clone on the machine take main's namespace.
 */
export type MainNamespaceOwner =
  { kind: "unclaimed" } | { kind: "claimed"; checkoutRoot: string };

export function mainNamespaceOwner(): MainNamespaceOwner {
  const path = worktreeArtifacts.spec(MAIN_WORKTREE_NAME);
  const read = readDeploySpec(path);
  if (read.kind === "absent") return { kind: "unclaimed" };
  if (read.kind === "malformed") {
    throw new Error(
      `Cannot tell which checkout serves "${MAIN_WORKTREE_NAME}": ${path} is ${read.reason}. ` +
        `A build from the main checkout rewrites it.`,
    );
  }
  const suffix = `/${SERVER_CORE_RELATIVE}`;
  const server = resolve(read.server);
  if (!server.endsWith(suffix)) {
    throw new Error(
      `Cannot tell which checkout serves "${MAIN_WORKTREE_NAME}": ${path} names ` +
        `server ${read.server}, which is not a checkout's ${SERVER_CORE_RELATIVE}.`,
    );
  }
  const checkoutRoot = server.slice(0, -suffix.length);
  if (!existsSync(checkoutRoot)) return { kind: "unclaimed" };
  return { kind: "claimed", checkoutRoot: comparablePath(checkoutRoot) };
}

/** `root`'s comparable identity, for matching against {@link mainNamespaceOwner}. */
export function comparableCheckoutPath(root: string): string {
  return comparablePath(root);
}
