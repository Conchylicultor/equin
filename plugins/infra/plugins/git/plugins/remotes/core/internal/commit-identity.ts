import { userInfo } from "node:os";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { gitConfigGet, gitConfigSet, gitConfigUnset } from "./git-config";
import type { PublishTarget } from "./types";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

// Who signs the commits `push` and `upstream merge` make.
//
// Decided HERE, when a commit is about to be made — not at install. Whether the
// identity matters depends on whether the commit can leave the machine, and the
// only thing that knows that is the publish-target measurement beside this
// file. A clone that cannot publish needs no real identity at all, so asking
// for one at install would be a manual step with nothing to show for it.

/** Local config key recording the email THIS module wrote (see `ours`). */
export const AUTO_IDENTITY_KEY = `${LEGACY_IDS.gitConfigSection}.autoIdentityEmail`;

/**
 * Domain of the placeholder email. `.invalid` is reserved (RFC 2606): it can
 * never route anywhere or be mistaken for a real address, and it keeps the
 * hostname out of history — which is what git would otherwise put there.
 */
const AUTO_EMAIL_DOMAIN = LEGACY_IDS.autoIdentityDomain;

const GIT_TIMEOUT_MS = 60_000;

/**
 * What git would sign with right now, as three different facts:
 *
 * - `explicit` — someone set it (any config scope, or the environment).
 * - `ours` — the placeholder this module wrote into `--local` config, and the
 *   local email still equals it (a user who later set their own local email has
 *   made it explicit, and we no longer own it).
 * - `missing` — nobody did; git would fall back to login@hostname, or fail.
 */
export type IdentityState = "explicit" | "ours" | "missing";

/** What to do about it, as a pure function of the state and the target. */
export type IdentityAction =
  "use" | "write-auto" | "remove-auto-then-recheck" | "refuse";

export function decideIdentity(
  state: IdentityState,
  target: PublishTarget["kind"],
): IdentityAction {
  if (state === "explicit") return "use";
  if (target === "local") return state === "ours" ? "use" : "write-auto";
  // Publishing: commits become public, so a placeholder must not sign them.
  return state === "ours" ? "remove-auto-then-recheck" : "refuse";
}

export type CommitIdentity =
  | { kind: "explicit" }
  | { kind: "auto"; name: string; email: string; written: boolean }
  | { kind: "refuse"; message: string };

/**
 * Make sure the next commit in `root` is signed by someone appropriate for
 * where it may go, writing the local placeholder when that is the answer.
 * Returns `refuse` (with the message to print) rather than exiting, so each
 * command decides how it stops.
 */
export async function ensureCommitIdentity(
  root: string,
  target: PublishTarget,
): Promise<CommitIdentity> {
  const state = await readIdentityState(root);
  switch (decideIdentity(state, target.kind)) {
    case "use":
      return state === "ours"
        ? { kind: "auto", ...(await ownIdentity(root)), written: false }
        : { kind: "explicit" };
    case "write-auto": {
      const name = await derivedName(root);
      const email = `${localPart()}@${AUTO_EMAIL_DOMAIN}`;
      await gitConfigSet("user.name", name, root);
      await gitConfigSet("user.email", email, root);
      await gitConfigSet(AUTO_IDENTITY_KEY, email, root);
      return { kind: "auto", name, email, written: true };
    }
    case "remove-auto-then-recheck": {
      await gitConfigUnset("user.name", root);
      await gitConfigUnset("user.email", root);
      await gitConfigUnset(AUTO_IDENTITY_KEY, root);
      return (await readIdentityState(root)) === "explicit"
        ? { kind: "explicit" }
        : refusal(target, true);
    }
    case "refuse":
      return refusal(target, false);
  }
}

/** The one line a command prints when it just wrote the placeholder. */
export function describeAutoIdentity(identity: {
  name: string;
  email: string;
}): string {
  return (
    `Commits in this clone are signed "${identity.name} <${identity.email}>" — they stay on this machine. ` +
    `Set your own any time with \`git config --global user.email "you@example.com"\`.`
  );
}

async function readIdentityState(root: string): Promise<IdentityState> {
  const marker = await gitConfigGet(AUTO_IDENTITY_KEY, root);
  if (marker !== null && (await gitConfigGet("user.email", root)) === marker)
    return "ours";
  if (envSetsEmail()) return "explicit";
  return (await anyScopeEmail(root)) === null ? "missing" : "explicit";
}

/**
 * Does the environment already sign both halves? `EMAIL` covers author and
 * committer alike; the `GIT_*` pair only counts together, since a commit needs
 * both and `push`'s rebase rewrites the committer on every replayed commit.
 */
function envSetsEmail(): boolean {
  const env = process.env;
  if (env.EMAIL) return true;
  return Boolean(env.GIT_AUTHOR_EMAIL && env.GIT_COMMITTER_EMAIL);
}

/**
 * `user.email` across every config scope git reads — unlike `gitConfigGet`,
 * which is `--local` only. `null` is the reading "unset" (exit 1), not an
 * absorbed failure: any other exit throws.
 */
async function anyScopeEmail(root: string): Promise<string | null> {
  const result = await spawnCaptured(["git", "config", "--get", "user.email"], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1) return null;
  throw new Error(
    `git config --get user.email failed (exit ${result.exitCode})` +
      (result.stderr.trim() ? `\n${result.stderr.trim()}` : ""),
  );
}

async function ownIdentity(
  root: string,
): Promise<{ name: string; email: string }> {
  const name = await gitConfigGet("user.name", root);
  const email = await gitConfigGet("user.email", root);
  if (name === null || email === null)
    throw new Error(
      `The placeholder commit identity in ${root} is half-written (user.name=${name}, user.email=${email}).`,
    );
  return { name, email };
}

/**
 * The name git already derives from the account (the passwd full name), so
 * there is no per-platform lookup here. The email is pinned for this read only
 * because git refuses to print an ident whose email it cannot derive — which
 * is the exact case we are in. An account with no full name makes `git var`
 * refuse too ("empty ident name"); that is a reading, and the login is the
 * name then.
 */
async function derivedName(root: string): Promise<string> {
  const result = await spawnCaptured(["git", "var", "GIT_AUTHOR_IDENT"], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: `probe@${AUTO_EMAIL_DOMAIN}`,
    },
  });
  const name =
    result.exitCode === 0
      ? result.stdout.slice(0, result.stdout.indexOf(" <")).trim()
      : "";
  return name !== "" ? name : localPart();
}

function localPart(): string {
  const cleaned = userInfo().username.replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned !== "" ? cleaned : "user";
}

function refusal(
  target: PublishTarget,
  removedPlaceholder: boolean,
): CommitIdentity {
  const where =
    target.kind === "publish" ? `${target.url} (${target.remote})` : "a remote";
  return {
    kind: "refuse",
    message: [
      `This checkout publishes to ${where}, so its commits will be public — and git has no`,
      `name or email of yours to sign them with. Set them once:`,
      ``,
      `  git config --global user.name  "Your Name"`,
      `  git config --global user.email "you@example.com"`,
      ``,
      `then re-run the command.`,
      ...(removedPlaceholder
        ? [
            ``,
            `(The placeholder identity this clone used while it could not publish has been removed.`,
            `Commits made before now keep it.)`,
          ]
        : []),
      ``,
      `Agent: ask the user for these — never invent an identity.`,
    ].join("\n"),
  };
}
