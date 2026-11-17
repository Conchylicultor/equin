import { realpath } from "@plugins/packages/plugins/timed-fs/core";
import { resolve } from "node:path";
import { GATEWAY_SERVICE } from "@plugins/infra/plugins/launcher/core";
import { loginService } from "@plugins/infra/plugins/launcher/plugins/login-services/cli";
import {
  defineNotice,
  InstallerNoticeError,
  type InstallerNotice,
} from "@plugins/infra/plugins/launcher/plugins/installer-notice/core";
import { mainNamespaceOwner } from "@plugins/infra/plugins/paths/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";

/**
 * One equin per account (research/2026-07-02-global-adr-single-instance-per-user.md):
 * one data root, one database cluster, one main namespace, one background
 * service, one Keychain entry, one set of app bundles. A second checkout of the
 * repo cannot have its own — it would share all of them — so whichever
 * checkout holds the account's equin is the only one that may start it or
 * deploy its main app.
 *
 * Two records say which checkout that is, each written by a different step,
 * and either is enough:
 *
 * - `deploy`: the repository of the checkout main's last deploy names (its
 *   `spec.json`, `mainNamespaceOwner`) — what the app is served from now.
 *   The repository, not the checkout: main is built and served from
 *   per-commit slots (`infra/git/main-slots`, linked worktrees of the repo),
 *   so the spec names a slot while the repo's main checkout holds the account;
 * - `service`: the checkout the background service is registered to follow
 *   (`-main-checkout` in its installed job) — written by `./equin start`
 *   before the first build, so a first install that stopped before its build
 *   still holds the account.
 *
 * A record naming a folder that no longer exists claims nothing: the code was
 * moved or deleted, and the next checkout to start or build takes over, as
 * before.
 */
export type InstanceClaim = {
  source: "deploy" | "service";
  /** The claiming checkout, symlinks resolved. */
  checkout: string;
};

export type InstanceVerdict =
  | { kind: "unclaimed" }
  | { kind: "this" }
  | { kind: "other"; checkout: string; claims: readonly InstanceClaim[] };

/**
 * Who holds the account, from its claims, for the checkout `here` (resolved
 * like the claims). Pure. Any claim naming another checkout wins over one
 * naming `here`: two records disagreeing is a takeover already half done, and
 * the half that is not ours must stop it.
 */
export function judgeInstance(
  here: string,
  claims: readonly InstanceClaim[],
): InstanceVerdict {
  const other = claims.find((c) => c.checkout !== here);
  if (other !== undefined)
    return { kind: "other", checkout: other.checkout, claims };
  return claims.length === 0 ? { kind: "unclaimed" } : { kind: "this" };
}

/** `path` with symlinks resolved, or null when it does not exist. */
async function existingPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The installed background service's `-main-checkout`, or undefined. */
function mainCheckoutFlag(argv: readonly string[]): string | undefined {
  const at = argv.indexOf("-main-checkout");
  return at === -1 ? undefined : argv[at + 1];
}

/** Every record on this account naming a checkout that still exists. */
export async function instanceClaims(): Promise<InstanceClaim[]> {
  const claims: InstanceClaim[] = [];
  const deployed = await mainNamespaceOwner();
  if (deployed.kind === "claimed") {
    claims.push({ source: "deploy", checkout: deployed.repoRoot });
  }
  const service = await loginService(GATEWAY_SERVICE);
  const job = service === null ? null : await service.installedJob();
  const followed = job === null ? undefined : mainCheckoutFlag(job.argv);
  if (followed !== undefined) {
    const checkout = await existingPath(followed);
    if (checkout !== null) claims.push({ source: "service", checkout });
  }
  return claims;
}

/** What the refused command was doing, in the person's words. */
export type InstanceAction = "start" | "build";

const DOING: Record<InstanceAction, string> = {
  start:
    "equin was setting this copy of its code up to run in the background on this account.",
  build:
    "equin was building this copy of its code to serve as the equin of this account.",
};

const SOURCE: Record<InstanceClaim["source"], string> = {
  deploy: "the equin app is served from",
  service: "the background service follows",
};

/** The refusal: another checkout already holds this account's equin. */
export function otherInstanceNotice(opts: {
  action: InstanceAction;
  here: string;
  verdict: Extract<InstanceVerdict, { kind: "other" }>;
}): InstallerNotice {
  const { action, here, verdict } = opts;
  return defineNotice({
    title: "equin is already installed on this account, from another folder",
    doing: DOING[action],
    blocked:
      "This account already has an equin, and a second one would share its database, its address and its background service: going on would replace the equin you use, possibly with an older version than your data. equin runs one copy per account.",
    now: [
      `To update the equin you already have, run the installer from its folder: \`cd ${shellWord(verdict.checkout)} && ./install.sh\`.`,
      "To try a second equin, use another account on this computer, or a virtual machine.",
      `If that other folder is a leftover copy you no longer use, stop it with \`cd ${shellWord(verdict.checkout)} && ./equin stop --disable\`, move it away, then run this again.`,
    ],
    ifSkipped: {
      optional: false,
      because:
        "an account holds one equin. Nothing was changed: the equin you have keeps running as it is.",
    },
    evidence: [
      `this checkout: ${here}`,
      ...verdict.claims.map((c) => `${SOURCE[c.source]}: ${c.checkout}`),
    ],
  });
}

/** A path as one shell word, quoted only when it needs it. */
function shellWord(path: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * Refuse to `action` from `checkout` when another checkout holds this
 * account's equin: throws an {@link InstallerNoticeError} the command prints
 * as itself. Called by `./equin start` (with the main checkout it starts
 * from) and by every `./equin build` of main (with the checkout it builds),
 * before either touches anything shared.
 */
export async function assertThisInstance(
  checkout: string,
  action: InstanceAction,
): Promise<void> {
  // A main slot acts for its repository: compare the repo's main checkout
  // (the slot's own path for a checkout that is no linked worktree).
  const repo =
    (await existingPath(checkout)) === null
      ? checkout
      : await getMainRepoRoot(checkout);
  const here = (await existingPath(repo)) ?? resolve(repo);
  const verdict = judgeInstance(here, await instanceClaims());
  if (verdict.kind !== "other") return;
  throw new InstallerNoticeError(
    otherInstanceNotice({ action, here, verdict }),
  );
}
