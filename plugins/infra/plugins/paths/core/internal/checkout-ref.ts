import { resolve } from "node:path";
import {
  MAIN_COMPOSITION_ID,
  MAIN_WORKTREE_NAME,
  namespaceFor,
  type CheckoutRef,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
// Relative siblings rather than the `@plugins/infra/plugins/paths/core` alias:
// this file lives INSIDE the `paths` plugin, so the alias would cycle back
// through the barrel that re-exports it. Same reasoning as `data-dir.ts`
// importing `./paths`.
import { comparableCheckoutPath, mainNamespaceOwner } from "./checkout-deploys";
import { stampCheckoutOwner } from "./checkout-owner";
import { checkoutWorktreeName } from "./paths";

/**
 * A second clone's main checkout whose directory is named like the main
 * namespace, so it can take neither name without colliding with the checkout
 * this machine's main app is served from.
 */
export class MainNamespaceCollisionError extends Error {
  constructor(root: string, owner: string) {
    super(
      `${root} is the main checkout of a repository other than the one this ` +
        `machine's main app ("${MAIN_WORKTREE_NAME}") is served from (${owner}), ` +
        `and its directory name would collide with that namespace. Rename the ` +
        `directory, or work from a linked worktree (git worktree add).`,
    );
    this.name = "MainNamespaceCollisionError";
  }
}

/**
 * Which checkout a root directory IS, in the form `namespaceFor` accepts.
 *
 * THE one place the "is this the main checkout?" comparison is made. Two
 * questions, both answered from provenance rather than from a name:
 *
 * 1. Is `root` its repository's main checkout? A git question
 *    (`getMainRepoRoot`): comparing a basename against the literal
 *    main-namespace name is only correct while the repo happens to be cloned into a
 *    directory of that name.
 * 2. Is that repository the one this data root's main app is served from? The
 *    data root serves ONE instance (research/2026-07-02-global-adr-single-
 *    instance-per-user.md), recorded by the `spec.json` its main build wrote
 *    (`mainNamespaceOwner`). Without this, the main checkout of ANY clone on
 *    the machine — a second copy, an e2e's temp repo — minted the main namespace and
 *    ran its ops, logs and deploys as main's. Such a checkout is named like any
 *    other non-main one, by its basename, and one whose basename IS the main
 *    namespace is refused ({@link MainNamespaceCollisionError}).
 *
 * Async because the answer comes from git. `getMainRepoRoot` is memoized per
 * cwd, so repeated calls cost one spawn per process.
 */
export async function checkoutRef(root: string): Promise<CheckoutRef> {
  const mainRoot = await getMainRepoRoot(root);
  const name = checkoutWorktreeName(root);
  if (resolve(root) !== resolve(mainRoot)) return { kind: "worktree", name };
  const owner = mainNamespaceOwner();
  if (
    owner.kind === "unclaimed" ||
    owner.checkoutRoot === comparableCheckoutPath(root)
  )
    return { kind: "main" };
  if (name === MAIN_WORKTREE_NAME)
    throw new MainNamespaceCollisionError(root, owner.checkoutRoot);
  return { kind: "worktree", name };
}

/**
 * The namespace a checkout's OWN app answers to — the second of the three
 * questions that look alike and are not (see `deploysForCheckout` for the
 * third, and `currentWorktreeName` for the first).
 *
 * This pair — the main composition, plus the checkout git says this root is —
 * was hand-spelled at five call sites: `build`, its hermetic posture, `check`,
 * `push` and the prototype URL formatter. Five copies of one derivation is how
 * one of them ends up reading the environment instead, which answers
 * the main namespace from every worktree; naming the mint is what leaves nothing to
 * spell differently.
 *
 * It says which namespace this checkout WOULD serve, not that anything is
 * serving it: a checkout that has never been built still has one. Ask
 * `resolveCheckoutDeploy(root)` when the question is what is actually deployed.
 */
export async function checkoutNamespace(root: string): Promise<Namespace> {
  return namespaceFor(MAIN_COMPOSITION_ID, await checkoutRef(root));
}

/**
 * {@link checkoutNamespace}, for a caller about to ACT as that namespace — an op
 * (`build`, `push`, a direct op) that will write into its data dir. Also records
 * the checkout on the namespace (`stampCheckoutOwner`), so the reaper can
 * reclaim a dir whose checkout is gone even when no attempt row or composition
 * marker names it. One function, so an op cannot mint without stamping.
 */
export async function actAsCheckoutNamespace(root: string): Promise<Namespace> {
  const ns = await checkoutNamespace(root);
  stampCheckoutOwner(ns, root);
  return ns;
}
