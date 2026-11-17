import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { isMainSlotCheckout } from "@plugins/infra/plugins/paths/core";
import type { SlotHolderKind } from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";
import { acquireSharedLease } from "./lease";
import { servedMainRoot } from "./slots";

/**
 * Run `fn` over the checkout main's code is served from (`servedMainRoot`),
 * holding it shared while `fn` runs when it is a slot — so a reader of that
 * code (main's gateway build, compiled from the commit main serves) cannot
 * have it checked out from under it. The lease is taken, then the link read
 * again: a link that moved in between is followed to the new slot.
 */
export async function withServedMainRoot<T>(
  kind: SlotHolderKind,
  label: string,
  fn: (root: AppPath) => Promise<T>,
): Promise<T> {
  for (;;) {
    const root = await servedMainRoot();
    if (!(await isMainSlotCheckout(root))) return fn(root);
    const lease = await acquireSharedLease(root, kind, label);
    try {
      if ((await servedMainRoot()) !== root) continue;
      return await fn(root);
    } finally {
      await lease.release();
    }
  }
}
