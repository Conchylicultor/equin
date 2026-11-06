import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { exists } from "@plugins/packages/plugins/timed-fs/core";
import type { LoginServiceId } from "../../core";

/**
 * The id a manager binds a service to: the first of its `installedAs` labels
 * whose definition is still installed, else its own label. See
 * `LoginServiceId.installedAs` for why an installed service keeps its name.
 *
 * Asked afresh on every `LoginServiceManager.service(id)`, never cached: a
 * relabel (`./equin data-dir migrate` removing the old definition, `start`
 * writing the new one) moves the binding, and a remembered one would act on a
 * label that is no longer installed. An id without `installedAs` (every
 * declared service) binds to itself without touching the disk.
 */
export async function bindInstalledLabel(
  id: LoginServiceId,
  definitionPathOf: (label: string) => AppPath,
): Promise<LoginServiceId> {
  for (const label of id.installedAs ?? []) {
    // In order: the first installed one wins.
    if (await exists(definitionPathOf(label)))
      return { label, session: id.session };
  }
  return id;
}
