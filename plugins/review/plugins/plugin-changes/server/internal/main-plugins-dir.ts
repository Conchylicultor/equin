import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";

export function getMainRoot(): Promise<AppPath> {
  return getMainRepoRoot();
}

export async function getMainPluginsDir(): Promise<AppPath> {
  return joinAppPath(await getMainRoot(), "plugins");
}
