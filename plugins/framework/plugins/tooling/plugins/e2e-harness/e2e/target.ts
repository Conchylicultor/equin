/**
 * Where an e2e script points its browser.
 *
 * # One URL, two components
 *
 * A run has exactly ONE target URL, and it has two halves that go to two
 * different consumers:
 *
 *     --url http://wt.localhost:9000/deploy/server/3/dep/91
 *           └────── origin ────────┘└────── path ────────┘
 *           which deploy?            which screen?
 *                   ↓                       ↓
 *           pathUrl("/api/…")          page.goto(…)
 *           builds every API call      opens the screen under test
 *
 * The origin is not a second input — it is the target URL with the path cut
 * off. There is never a run where "the origin" and "the page's origin" differ,
 * which is why there is ONE flag rather than one per half.
 *
 * This file used to hand the whole string to the half that only wanted the
 * origin. `screenshot.ts` read the same unsplit value as the page — and its own
 * usage block, and the repo's CLAUDE.md, documented `--url` WITH a path. So
 * `pathUrl("/api/config-v2/…")` resolved to
 * `<origin>/deploy/server/3/dep/91/api/config-v2/…`, which the SPA catch-all
 * answers with index.html and HTTP 200: `res.ok` passes and `res.json()` throws
 * "Failed to parse JSON". Harmless until the agent-config-write revert ledger
 * made `withBrowser` itself call the app's API on every run — after which the
 * documented `screenshot.ts` invocation could not run at all.
 *
 * The split now happens once, here, and the unsplit value never leaves this
 * module. Scripts get `pathUrl(path)` (a path the SCRIPT chose), plus
 * `pageUrl(fallback)` / `requirePage(usage)` (the path the USER chose) — so
 * there is no origin string for a script to hold, navigate to, or concatenate
 * onto.
 *
 * # The default is READ from the registry, never guessed from a name
 *
 * This exists to kill a whole class of rot by construction. Before the
 * per-plugin move, four scripts carried a *literal* ephemeral worktree host as
 * their default (`att-1781283277-ilxk.localhost:9000`, …). Those worktrees are
 * long gone, so the scripts could not run as written and nobody noticed,
 * because a default that is a dead string fails at the browser, not at the type
 * checker.
 *
 * The first fix replaced the literal with a *derivation* — the checkout's
 * directory name, preferring the retired worktree variable — and that failed the same
 * way, one level up. A name is a guess about what somebody else registered:
 * the retired worktree variable answered "which namespace is this BACKEND the server
 * for" (the gateway set it on the backends it spawned), an agent pane inherited
 * it through the tmux server, and so from inside any worktree it said
 * the main namespace. Runs drove MAIN's app and printed ALL CHECKS PASSED — worse,
 * `withBrowser` opens by POSTing the config repair to the resolved origin, so
 * every run reverted the user's live documents before doing anything.
 *
 * So the target is no longer computed at all. Every deploy RECORDS itself: the
 * build writes `~/.singularity/worktrees/<ns>/spec.json` naming the absolute
 * path of the checkout whose backend answers that namespace, and
 * `resolveCheckoutDeploy(REPO_ROOT)` reads that registry back. A checkout that
 * has published nothing resolves to nothing and the run REFUSES — which is the
 * true answer, and the one a name can never give, since a directory basename
 * always names *some* plausible host. `--composition` reaches the deploys whose
 * namespace shares no label with the checkout at all (`sonata.att-x`) — the
 * ones a basename could not name even in principle.
 *
 * No environment variable has any spelling in this runtime — not
 * the retired worktree variable, and not the the retired e2e-base variable that used to
 * outrank the derivation here (nothing in the repo ever set it, and an
 * inherited channel that silently wins is the shape of the bug above). There is
 * nothing left to prefer or contradict; `--url` covers every operator case and
 * is per-invocation. `e2e-harness:target-not-env-derived` keeps it that way.
 *
 * Naming the deploy is only half of it: `deploy-identity.ts` then PROVES that
 * the app answering it is the build this checkout published.
 */
import { resolveBuildReceipt } from "@plugins/framework/plugins/cli/plugins/op-runtime/core";
import type { ResolvedReceipt } from "@plugins/framework/plugins/cli/plugins/op-runtime/core";
import {
  REPO_ROOT,
  resolveCheckoutDeploy,
  worktreesDir,
} from "@plugins/infra/plugins/paths/core";
import type {
  CheckoutDeploy,
  CheckoutDeployResolution,
} from "@plugins/infra/plugins/paths/core";
import {
  MAIN_COMPOSITION_ID,
  namespaceFromHost,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { arg, flag, usage } from "./args";

/**
 * The resolved target, carrying HOW it was resolved.
 *
 * The two arms are not decoration. Only a target this checkout published has a
 * build to be checked against — a `--url` may legitimately name a staged
 * release bundle on its own port, somebody else's worktree, or a remote host.
 * Putting the deploy on the derived arm alone makes "assert the identity of a
 * caller-supplied URL" unwritable rather than merely discouraged, which is what
 * `deploy-identity.ts` leans on.
 */
type Target =
  | { kind: "derived"; origin: string; deploy: CheckoutDeploy; page?: string }
  | { kind: "stated"; origin: string; flag: string; page?: string };

/** `Target` without the URL halves — what the identity assert is allowed to see. */
export type TargetDeploy =
  | { kind: "derived"; origin: string; deploy: CheckoutDeploy }
  | { kind: "stated" };

/**
 * The flags that STATE a target, in precedence order.
 *
 * `--base` and `--origin` are ALIASES, not separate flags with their own
 * meaning: every pre-existing invocation keeps working, and there is still only
 * one way for a caller to say "the target".
 */
const STATED_FLAGS = ["url", "base", "origin"] as const;

function statedTarget(): { raw: string; flag: string } | undefined {
  for (const name of STATED_FLAGS) {
    const value = arg(name);
    if (value !== undefined) return { raw: value, flag: `--${name}` };
  }
  return undefined;
}

/** The target as the caller spelled it, before it is parsed as a URL. */
type RawTarget =
  | { kind: "derived"; raw: string; flag: string; deploy: CheckoutDeploy }
  | { kind: "stated"; raw: string; flag: string };

/**
 * The target URL, from the caller or from the deploy registry.
 *
 * `--composition` alongside a stated target is a usage error, not a silent
 * drop: both flags answer "which deploy", so honouring one and discarding the
 * other would run against a deploy the caller explicitly did not name. Same
 * discipline this file already applies to a page named twice.
 */
function rawTarget(): RawTarget {
  const stated = statedTarget();
  const composition = arg("composition");

  // `arg` answers undefined both for an absent flag and for a `--composition`
  // with nothing after it, and those are opposite intentions: one means "this
  // checkout's own app", the other is a deploy selector the run would drop on
  // the floor and then go green against a different deploy.
  if (
    flag("composition") &&
    (composition === undefined || composition === "")
  ) {
    usage(
      `--composition needs a composition id, e.g. --composition sonata.\n` +
        `  Drop the flag entirely to target this checkout's own app.`,
    );
  }

  if (stated !== undefined) {
    if (composition !== undefined) {
      usage(
        `${stated.flag} names a deploy (${stated.raw}) and so does --composition (${composition}).\n` +
          `  Pass the deploy once: a URL for any deploy, or --composition for one this\n` +
          `  checkout published.`,
      );
    }
    return { kind: "stated", raw: stated.raw, flag: stated.flag };
  }

  const resolution = resolveCheckoutDeploy(REPO_ROOT, composition);
  if (resolution.kind === "none") noDeploy(composition, resolution);
  const { deploy } = resolution;
  return {
    kind: "derived",
    raw: namespaceUrl(deploy.namespace),
    flag: "<this checkout's deploy>",
    deploy,
  };
}

/**
 * Refuse, saying which of the two very different situations this is.
 *
 * "Nothing is registered to this checkout" and "this checkout published a
 * composition but not its own app" both arrive here as *no deploy*, and they
 * have opposite fixes — build, versus name the composition that already exists.
 * The old code could not tell them apart because it never asked the registry:
 * it built a URL out of a directory name, which is always *a* plausible host,
 * so both situations silently became a run against somebody else's app.
 */
function noDeploy(
  composition: string | undefined,
  resolution: Extract<CheckoutDeployResolution, { kind: "none" }>,
): never {
  const { others, scanned } = resolution;
  const checkout = `  checkout   : ${REPO_ROOT}`;
  // Destructured rather than length-tested: the first deploy is both the
  // emptiness question and the one this message suggests targeting, so there is
  // no index read left to have to justify a fallback for.
  const [first] = others;
  if (first === undefined) {
    // The count is the difference between "this machine has no registry" and
    // "the registry is full and none of it is ours" — a bare `(none)` reads as
    // the first even when it is the second, and they are not repaired the same
    // way.
    const none =
      scanned === 0
        ? `(none — nothing at all is registered on this machine)`
        : `(none of the ${scanned} registered namespace${scanned === 1 ? "" : "s"} is served from this checkout)`;
    usage(
      `No deploy for this checkout — there is nothing to run against.\n\n` +
        `${checkout}\n` +
        `  registered : ${none}\n\n` +
        `Nothing under ${worktreesDir()} is registered to this\n` +
        `checkout's backend, so \`./equin build\` has never published a deploy from\n` +
        `here. Run it, then re-run this script.\n` +
        `To drive a deploy this checkout did not build, name it:\n` +
        `  --url http://<namespace>.localhost:9000`,
    );
  }

  const registered = others
    .map((d) => `${d.namespace} (composition "${d.composition}")`)
    .join(`\n${" ".repeat("  registered : ".length)}`);
  const suggest = first.composition;
  const head =
    composition === undefined
      ? "No deploy for this checkout's own app (the main composition)."
      : `No deploy for composition "${composition}" from this checkout.`;
  const tail =
    composition === undefined
      ? `A \`--composition\` build publishes only that composition's namespace, never the\n` +
        `checkout's own app. Run \`./equin build\` here to deploy it, or target one\n` +
        `of the deploys above with --composition ${suggest}.`
      : `This checkout has published the compositions above, but not "${composition}". Run\n` +
        `\`./equin build --composition ${composition}\` here to deploy it, or target one\n` +
        `of the deploys above with --composition ${suggest}.`;
  usage(`${head}\n\n${checkout}\n  registered : ${registered}\n\n${tail}`);
}

/**
 * Parse the target, or explain why it is not one.
 *
 * Deliberately NOT a bare `try { new URL(raw) }`. `new URL` only throws on
 * input it cannot parse AT ALL, and a bare host:port parses fine — it just
 * parses as something else entirely: `att-wt.localhost:9000` is read as the
 * scheme `att-wt.localhost:` with the opaque path `9000`, whose `.origin` is
 * the STRING "null". So the missing-scheme case, the one a human actually
 * types, sails through the throw-check and degrades to `null/9000` at the first
 * fetch — the same class of late, unattributable failure this module exists to
 * end. The real requirement is a scheme the browser and `fetch` can dial and a
 * host to dial it at, so that is what gets asserted.
 */
function httpUrl(raw: string, flag: string): URL {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch (err) {
    // `new URL` signals unparseable with a TypeError and nothing else; anything
    // else is unexpected and keeps propagating. The message comes from the
    // shared check below, so both failures read the same.
    if (!(err instanceof TypeError)) throw err;
  }

  if (
    url !== undefined &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.host !== ""
  ) {
    return url;
  }

  // Name the fix, which differs by what they actually typed: a leading `/` is a
  // page and belongs on `--path`; no `//` at all is a bare host missing its
  // scheme; anything else named a scheme we cannot dial, where prefixing
  // `http://` would only produce a second wrong URL.
  const hint = raw.startsWith("/")
    ? `  That is a page path, not a URL — pass it as --path ${raw}`
    : raw.includes("//")
      ? "  The scheme must be http or https."
      : `  It is missing a scheme — try http://${raw}`;
  usage(`${flag} is not an http(s) URL: ${raw}\n${hint}`);
}

/** How long ago, in the coarsest unit that still says something. */
function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * When, relative to now — or the raw stamp when it is not a date.
 *
 * The receipt is a file we wrote ourselves, so an unparseable timestamp is a
 * real fault; but this is a banner line, and refusing the run over a cosmetic
 * string would be the wrong rung entirely. Showing the value instead of an
 * invented age says exactly as much as we know.
 */
function describeAge(stamp: string): string {
  const ms = Date.now() - Date.parse(stamp);
  return Number.isFinite(ms) ? `${humanDuration(ms)} ago` : `at ${stamp}`;
}

/**
 * What the receipt's own verdict is called in one word. A `Record` keyed on the
 * resolved kind rather than a `switch`, so a new receipt state is a type error
 * here instead of a banner that quietly stops describing it.
 */
const BUILD_STATE: Record<Exclude<ResolvedReceipt["kind"], "none">, string> = {
  ok: "built",
  running: "started",
  interrupted: "interrupted",
  failed: "failed",
  superseded: "superseded",
};

/**
 * The build the receipt describes — which is NOT a claim about what is being
 * served. `deploy-identity.ts` proves that separately, and warns or refuses
 * when the two disagree; this line's job is to put the record on screen.
 *
 * It does the READ as well, inside a try, because this read must not be able to
 * end the run. `readBuildReceipt` throws on a receipt that is not valid JSON —
 * correctly, at the authoritative read in `deploy-identity.ts`, where a receipt
 * we cannot read is a build we cannot vouch for. Here it would abort every e2e
 * script in the checkout over a banner line, and for the scripts that bind
 * `pathUrl` at module top level it would do so at module load, before anything
 * had a chance to say why. That is the wrong rung, for the reason `describeAge`
 * above gives about the same file: refusing a run over a cosmetic string is not
 * a trade this line is entitled to make. So it degrades the way `describeAge`
 * does — saying exactly what it knows — and the real message still arrives,
 * with the path and the fix, from the authoritative read moments later.
 */
function describeBuild(namespace: Namespace): string {
  let resolved: ResolvedReceipt;
  try {
    resolved = resolveBuildReceipt(namespace);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `build record unreadable: ${why}`;
  }
  if (resolved.kind === "none") return "no build recorded";
  const { buildId, startedAt, finishedAt } = resolved.receipt;
  // `finishedAt` is null exactly while a build is still running, in which case
  // the start is the only time it has.
  const at = finishedAt ?? startedAt;
  return `${buildId}, ${BUILD_STATE[resolved.kind]} ${describeAge(at)}`;
}

function describeTarget(t: Target): string {
  if (t.kind === "stated") return `target: ${t.origin}  (named by ${t.flag})`;
  const build = describeBuild(t.deploy.namespace);
  // The main composition's id is a kept internal name: say "deploy", as the
  // address already names the app.
  const which =
    t.deploy.composition === MAIN_COMPOSITION_ID
      ? "deploy"
      : `${t.deploy.composition} deploy`;
  return `target: ${t.origin}  (this checkout's ${which}, ${build})`;
}

/**
 * Is this URL on the target deploy? A predicate rather than the origin
 * itself, on purpose: it answers the one question the browser lifecycle needs
 * (does this request go to the app, or to a third party) without handing
 * anyone an origin string to navigate to or concatenate onto.
 */
export function isTargetOrigin(url: string): boolean {
  return new URL(url).origin === target().origin;
}

let parsed: Target | undefined;

/**
 * Split the target once. Memoized so a malformed URL reports once, so the
 * `--path` conflict cannot be reported twice by two different callers, and so
 * the banner below is printed exactly once per run.
 */
function target(): Target {
  if (parsed) return parsed;

  const raw = rawTarget();
  const url = httpUrl(raw.raw, raw.flag);

  // `/` is what a bare origin parses to, so it is the ABSENCE of a page path,
  // not a request for the root. A script that wants the root asks for it
  // explicitly with `pathUrl("/")`.
  const suffix = `${url.pathname}${url.search}${url.hash}`;
  const fromUrl = suffix === "/" ? undefined : suffix;
  const fromFlag = arg("path");

  if (fromUrl !== undefined && fromFlag !== undefined) {
    usage(
      `${raw.flag} names a page (${fromUrl}) and so does --path (${fromFlag}).\n` +
        `  Pass the page once: either in the URL, or as --path against the deploy.`,
    );
  }

  const page = fromUrl ?? fromFlag;
  const resolved: Target =
    raw.kind === "derived"
      ? { kind: "derived", origin: url.origin, deploy: raw.deploy, page }
      : { kind: "stated", origin: url.origin, flag: raw.flag, page };

  // Named HERE, in the one resolution every path goes through, rather than at a
  // call site: 134 of the 165 scripts never bind `pathUrl` at module top level,
  // and printed nothing identifying the deploy they drove. That silence is why
  // a fleet of green runs against MAIN's app left no trace in any transcript.
  //
  // stderr, because `target()` resolves lazily — at module load for the scripts
  // that bind `pathUrl` up top, mid-run for the rest — so on stdout this line
  // would land inside `perf.ts`'s summary table or `screenshot.ts`'s block for
  // some callers and not others.
  //
  // Described BEFORE the memo is filled, so that describing the target can never
  // cost the run its banner: a throw from here with `parsed` already assigned
  // would leave the next `target()` returning a resolved target silently, having
  // announced nothing — the memo turning a loud failure into the exact silence
  // this line exists to end.
  const banner = describeTarget(resolved);
  parsed = resolved;
  console.error(banner);
  return parsed;
}

/**
 * Which deploy this run resolved, and whether it is one we may make claims
 * about — for `deploy-identity.ts`, the only caller.
 *
 * Deliberately NOT the whole `Target`: re-wrapping drops the page and, on the
 * stated arm, the origin, so the identity check has nothing to compare and no
 * URL to compare it at. The rule "a caller-supplied `--url` is never asserted
 * against this checkout's build" is therefore a shape, not a convention.
 *
 * Calling this also FORCES resolution, which is what makes it safe as
 * `withBrowser`'s first statement — see `assertDeployIdentity`.
 */
export function targetDeploy(): TargetDeploy {
  const t = target();
  return t.kind === "derived"
    ? { kind: "derived", origin: t.origin, deploy: t.deploy }
    : { kind: "stated" };
}

/**
 * The namespace of the deploy under test, for a script that must read or assert
 * on a per-namespace file on disk (a config document, a log, an artifact).
 *
 * This is an IDENTITY, not an origin: rebuilding a URL from it with
 * `namespaceUrl` would ignore `--url` and point the script back at the gateway.
 * Use `pathUrl` for anything the app answers.
 */
export function targetNamespace(): Namespace {
  const t = target();
  if (t.kind === "derived") return t.deploy.namespace;

  const name = namespaceFromHost(new URL(t.origin).host);
  if (name === null) {
    usage(
      `${t.flag} names ${t.origin}, whose host is not a gateway namespace, so there is\n` +
        `  no per-namespace directory under ${worktreesDir()} for this script to read.\n` +
        `  Point it at a deploy (http://<namespace>.localhost:9000), or drop the flag to\n` +
        `  use the deploy this checkout published.`,
    );
  }
  return name;
}

/**
 * `pageUrl()` was called, so a page path in the target was actually honoured.
 *
 * Tracked because the alternative is silence: a per-plugin script drives its
 * own screen, so `tabs-verify.ts --url http://wt:9000/pages` would run against
 * `/agents` and pass, having tested a screen the caller did not ask for. See
 * `unconsumedPage()`.
 */
let pageConsumed = false;

/**
 * The page path the caller named and no script ever read, if any.
 *
 * `withBrowser` turns this into a failed run at teardown. Teardown rather than
 * startup because a script may legitimately call `pageUrl()` inside the
 * `withBrowser` callback, which has not run yet when the browser launches.
 */
export function unconsumedPage(): string | undefined {
  if (pageConsumed) return undefined;
  return target().page;
}

/** The target's origin joined to an app path, with exactly one slash between. */
export function pathUrl(path: string): string {
  return `${target().origin}/${path.replace(/^\/+/, "")}`;
}

/**
 * The page to open: the path the CALLER named (`--url`'s path, or `--path`),
 * falling back to the one this script drives by default.
 *
 * Only for tools whose job is "open the page I name" — `screenshot.ts`,
 * `perf.ts`, and the profilers. A script that verifies one specific screen
 * names it with `pathUrl` instead, and a caller who passes a page to such a
 * script is told so rather than quietly getting the wrong screen.
 */
export function pageUrl(fallbackPath = "/"): string {
  pageConsumed = true;
  return pathUrl(target().page ?? fallbackPath);
}

/**
 * `pageUrl` for a harness that cannot pick a default page on the caller's
 * behalf — the page twin of `args.ts`'s `requireArg`.
 *
 * A generic probe ("point me at a surface where X happens") has no route of its
 * own to fall back to: a hardcoded one is exactly what rots when the app it
 * named is deleted. So an absent page is a caller error, not a default.
 */
export function requirePage(usageLine: string): string {
  pageConsumed = true;
  const page = target().page;
  if (page === undefined) usage(usageLine);
  return pathUrl(page);
}
