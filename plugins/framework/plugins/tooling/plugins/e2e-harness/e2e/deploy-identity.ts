/**
 * Proving that the app answering the target is the build this checkout made.
 *
 * `target.ts` reads WHICH namespace this checkout published; this file checks
 * that the thing on the other end of that URL is actually it. The two are
 * independent records, deliberately: `build-status.json` is written at the
 * namespace directory's root by the build that took the lock, and `.build-id`
 * is written INSIDE the dist that build published and is then served by the
 * gateway. One is what we believe, the other is what is running. A comparison
 * against the local dist would be a tautology — `spec.web` IS
 * `worktreeArtifacts.webDist(ns)`, so an fs read there and this HTTP GET
 * resolve to the same file.
 *
 * Without this, the failure it exists to catch is silent in both directions: a
 * script that drives a deploy nobody rebuilt asserts against code the checkout
 * did not produce and reports ALL CHECKS PASSED, and — because `withBrowser`
 * opens by POSTing the config repair to the resolved origin — it writes there
 * too. Green runs against the wrong app are worse than no runs, because they
 * get cited as evidence.
 *
 * # Only `ok` may refuse
 *
 * The receipt says what the last build here became, and the verdict follows it:
 *
 *   ok          this checkout published `buildId` → a mismatch THROWS
 *   running     a build is mid-flight; the dist swaps only at the very end
 *   interrupted a build died without writing a verdict
 *   failed      the build did not deploy; an earlier one is still up
 *   superseded  a later build of this same checkout took over
 *   none        a registered namespace with no receipt to compare against
 *
 * Every one of them probes, `failed` and `superseded` included: each warning
 * below names which build is actually answering, and there is no way to name it
 * without asking. (The design doc's table said "no probe" for those two — it
 * also specified the message that makes the probe necessary.)
 *
 * Everything below `ok` warns and proceeds. Refusing on `running` would open a
 * ~10-minute hard-refusal window on main every time it auto-builds on a
 * `refs/heads/main` advance — and for most of that window the dist being served
 * is still the previous, complete, correct one. Refusing on `interrupted` would
 * be worse: the root CLAUDE.md documents an interrupted build as routine (a
 * caller timeout leaves `status: running` with a dead pid), and nothing
 * rewrites the receipt until the NEXT build, so one timed-out build would block
 * every script in that checkout indefinitely. In all of those cases the
 * namespace resolution has already excluded the wrong-app class this check
 * exists for; what is left is a staleness question, and staleness is worth a
 * line on stderr, not a refusal. Warning also keeps
 * `repairAgentWrites("start")` reachable — the half no teardown can
 * provide.
 *
 * # What this does NOT prove
 *
 * The served dist, not the backend. `./equin build --no-restart` writes
 * an `ok` receipt with a new dist and leaves the previous backend running, so a
 * run can still be green against a new frontend talking to old server code.
 * Nothing here can see that; the receipt records one build id for both halves.
 */
import {
  interruptedPredecessorWarning,
  resolveBuildReceipt,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/core";
import type {
  BuildReceipt,
  ResolvedReceipt,
} from "@plugins/framework/plugins/cli/plugins/op-runtime/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { pathUrl, targetDeploy } from "./target";

/** The dist's own copy of its build id, written by `buildAndPublishWebDist`. */
const PROBE_PATH = "/.build-id";

/**
 * A build id is 27 bytes. The cap is what keeps the SPA fall-through below from
 * buffering a quarter-megabyte of index.html to be told it is not one.
 */
const PROBE_MAX_BYTES = 128;

/**
 * One deadline for the whole probe — the request AND the body read.
 *
 * Not a budget: this is a GET of a 27-byte static file from a gateway on this
 * machine, so it answers in single-digit milliseconds or something is wrong.
 * Ten seconds is the point past which waiting longer cannot produce a different
 * verdict.
 *
 * It has to exist at all because a backend that accepts the connection and then
 * never answers is exactly the wedged state this probe exists to catch, and an
 * un-deadlined `fetch` waits for it forever. This function is `withBrowser`'s
 * first statement and gates every `agentFetch`, so that wait is the whole run
 * hanging with only the `target:` banner on screen: no teardown, no chromium,
 * nothing reported, nothing to read afterwards.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * What the origin answered — never a bare string, because "a different build"
 * and "no build id at all" need different sentences and only one of them is a
 * comparison.
 */
type Probe =
  | { kind: "id"; buildId: string }
  | { kind: "no-id" }
  | { kind: "unreachable"; detail: string };

/**
 * The first bytes of a response, and no more.
 *
 * A `null` body is not a case the gateway produces for a 200 — it either serves
 * the file or falls through to the SPA — so it lands in `no-id` with everything
 * else that is not a build id, rather than getting an arm of its own.
 *
 * There is no deadline here because there is one on the request: the caller's
 * `AbortSignal` covers this stream too, so a body that stops arriving rejects
 * `read()` and is caught where every other transport failure is.
 */
async function firstBytes(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < max) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  // Abandons the rest of the stream; a no-op once it is already done.
  await reader.cancel();
  return text.slice(0, max);
}

/**
 * Ask the origin which build it is serving.
 *
 * `res.ok` is NOT evidence, and that is the trap this function exists to
 * survive: the gateway answers an unknown path with the SPA, so a missing
 * `.build-id` comes back `200 text/html` with a whole document in it, and a
 * status check alone would read that as a hit. A hit is a single whitespace-free
 * token — which is what a build id is, and what the first 128 bytes of an HTML
 * document never are.
 *
 * A plain `fetch(pathUrl(…))`, not `agentFetch`, for two reasons — and it is
 * written in exactly the shape `no-unmarked-app-fetch` flags, with a standing
 * exemption in that rule's `ignores`, so the reasons are recorded where the rule
 * is rather than evaded by an intermediate variable. This is a GET of a
 * gateway-served static file that writes nothing, so there is no write for the
 * agent-origin mark to make revertible; and it GATES `agentFetch`, so routing it
 * through there would deadlock on the memo below.
 */
async function probe(): Promise<Probe> {
  // ONE signal over the request and the body read, and both reads inside ONE
  // try. A wedged backend can stall at either point — headers, or the bytes
  // after them — and the deadline firing mid-body rejects the reader rather
  // than the fetch. Left outside, that rejection escapes as an unhandled throw
  // from a function whose entire job is to answer with a `Probe`.
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  let value: string;
  try {
    const res = await fetch(pathUrl(PROBE_PATH), { signal });
    if (!res.ok) return { kind: "unreachable", detail: `HTTP ${res.status}` };
    value = (await firstBytes(res, PROBE_MAX_BYTES)).trim();
  } catch (err) {
    return { kind: "unreachable", detail: transportDetail(err) };
  }

  return value !== "" && !/\s/.test(value)
    ? { kind: "id", buildId: value }
    : { kind: "no-id" };
}

/**
 * What went wrong on the wire, as a phrase for the `result:` line.
 *
 * The timeout gets a sentence of its own because the runtime's own message for
 * it ("The operation timed out") omits the only fact that distinguishes it from
 * a refused connection: that the origin ACCEPTED us and then said nothing for
 * ten seconds. Matched on `name` rather than `instanceof DOMException` so it
 * holds whichever of the two spec'd abort names the runtime uses.
 */
function transportDetail(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `no response within ${PROBE_TIMEOUT_MS / 1000}s`;
    }
    return err.message;
  }
  return String(err);
}

/** The probe as a phrase, for the `serving:` line of a message. */
function servingPhrase(p: Probe): string {
  switch (p.kind) {
    case "id":
      return p.buildId;
    case "no-id":
      return "<no .build-id at this origin — the request fell through to index.html>";
    case "unreachable":
      return `<nothing — ${p.detail}>`;
  }
}

function wrongDeploy(
  origin: string,
  namespace: Namespace,
  receipt: BuildReceipt,
  p: Probe,
): Error {
  const commit =
    receipt.commit === null
      ? "(no commit recorded)"
      : `(commit ${receipt.commit})`;
  return new Error(
    `The deploy answering this target is not the build this checkout published.\n\n` +
      `  target  : ${origin}\n` +
      `  built   : ${receipt.buildId}  ${commit}\n` +
      `            recorded in ${worktreeArtifacts.buildStatus(namespace)}\n` +
      `  serving : ${servingPhrase(p)}\n\n` +
      `Every assertion below would be made against code this checkout did not\n` +
      `produce, and every write would land on it.\n` +
      `Run \`./equin build\` here, then re-run this script.`,
  );
}

function notAnswering(
  namespace: Namespace,
  probeUrl: string,
  receipt: BuildReceipt,
  detail: string,
): Error {
  return new Error(
    `The deploy this checkout published is not answering.\n\n` +
      `  namespace : ${namespace}\n` +
      `  probe     : ${probeUrl}\n` +
      `  result    : ${detail}\n\n` +
      `The receipt says ${receipt.buildId} landed here, so the build succeeded and\n` +
      `something after it did not: the gateway is not routing this namespace, or the\n` +
      `backend behind it is down or wedged (a wedged one accepts the connection and\n` +
      `then answers nothing, which is what a timeout above means). Re-run\n` +
      `\`./equin build\` here and check its output before reading anything into a\n` +
      `failure below.`,
  );
}

/**
 * The stderr line for a receipt that cannot refuse, naming both the build the
 * receipt describes and the build actually answering.
 *
 * `ok` is excluded from the parameter type, not merely unhandled: it is the one
 * receipt this function must never be asked about, because it is the one that
 * throws instead. There is no arm here to describe it with.
 *
 * The `interrupted` wording comes from `interruptedPredecessorWarning`, the
 * same sentence `build`, `check` and `push` print for the same state — an
 * interrupted build is silent by construction (SIGKILL prints no verdict), so
 * every op that notices says the same thing about it rather than inventing its
 * own phrasing for the same fact.
 */
function staleWarning(
  origin: string,
  namespace: Namespace,
  resolved: Exclude<ResolvedReceipt, { kind: "ok" }>,
  p: Probe,
): string {
  const serving = `   ${origin} is serving ${servingPhrase(p)}.\n`;
  switch (resolved.kind) {
    case "interrupted": {
      const shared = interruptedPredecessorWarning(resolved);
      // Non-null for exactly this arm, by that function's own definition.
      // Asserted rather than defaulted so the two stay in lockstep: if its
      // contract ever narrows, this says so instead of silently going quiet.
      if (shared === null) {
        throw new Error(
          "interruptedPredecessorWarning said nothing about an interrupted receipt",
        );
      }
      return shared + serving;
    }
    case "none":
      return (
        `\n⚠  No build receipt for ${namespace}, so there is nothing to check this deploy against.\n` +
        serving
      );
    case "running":
      return (
        `\n⚠  A build (${resolved.receipt.buildId}) is running here now — the dist swaps only at the very end.\n` +
        serving
      );
    case "failed":
      return (
        `\n⚠  The last build here (${resolved.receipt.buildId}) failed — it did NOT deploy.\n` +
        serving
      );
    case "superseded":
      return (
        `\n⚠  The last build here (${resolved.receipt.buildId}) was superseded by a later one.\n` +
        serving
      );
  }
}

async function check(): Promise<void> {
  // FORCED FIRST, and this is the whole reason the function is shaped this way.
  // As `withBrowser`'s opening statement it would otherwise read a target
  // nobody has resolved yet — 134 of the 165 scripts never bind `pathUrl` at
  // module top level — and silently pass, checking nothing, for exactly the
  // fleet this exists to protect.
  const t = targetDeploy();

  // A `--url` is the caller naming a deploy this checkout did not build: a
  // staged release bundle on its own port, another worktree, a remote host.
  // There is no build id of ours it could be expected to match, which is why
  // the stated arm carries no deploy to compare against at all.
  if (t.kind === "stated") return;

  const { origin, deploy } = t;
  const resolved = resolveBuildReceipt(deploy.namespace);
  const answered = await probe();

  if (resolved.kind !== "ok") {
    console.warn(staleWarning(origin, deploy.namespace, resolved, answered));
    return;
  }

  const { receipt } = resolved;
  if (answered.kind === "unreachable") {
    throw notAnswering(
      deploy.namespace,
      pathUrl(PROBE_PATH),
      receipt,
      answered.detail,
    );
  }
  // EXACT string compare, and the id is treated as opaque on purpose: it is
  // minted in more than one shape already (`build-<ms>-<rand>` from one path,
  // `<shortsha>-<ms>` from another), so anything that parsed it would be
  // deciding which shapes exist. Equality needs to know none of that, and
  // anything short of it — a prefix, a truncation, a different build of the
  // same commit — is a different dist.
  if (answered.kind === "id" && answered.buildId === receipt.buildId) return;
  throw wrongDeploy(origin, deploy.namespace, receipt, answered);
}

let checked: Promise<void> | undefined;

/**
 * Prove the deploy once per run, before anything reads from it or writes to it.
 *
 * Memoized on the PROMISE rather than on a boolean, so the ~dozen `agentFetch`
 * calls a run makes queue behind one probe instead of racing a dozen, and so a
 * refusal is raised identically at every entry point rather than only at the
 * first. Both entry points await it: `withBrowser` before it launches or
 * repairs anything, `agentFetch` before every request — which covers the
 * scripts that never open a browser.
 */
export function assertDeployIdentity(): Promise<void> {
  return (checked ??= check());
}
