import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { existsSync } from "node:fs";
import type { LoginServiceId } from "../../core";

/**
 * The id a manager binds a service to: the first of its `installedAs` labels
 * whose definition is still installed, else its own label. See
 * `LoginServiceId.installedAs` for why an installed service keeps its name.
 */
export function bindInstalledLabel(
  id: LoginServiceId,
  definitionPathOf: (label: string) => AppPath,
): LoginServiceId {
  const installed = id.installedAs?.find((label) =>
    existsSync(definitionPathOf(label)),
  );
  return installed === undefined
    ? id
    : { label: installed, session: id.session };
}
