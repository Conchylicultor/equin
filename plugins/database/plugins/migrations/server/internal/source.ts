import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { Migration } from "./runner";

/**
 * Where this host's migration SQL comes from. The runner is portable; the
 * texts are not: the desktop reads the committed `data/*.sql` off disk
 * (`migrations#machine`, honouring a release's vendored directory), and a host
 * without a filesystem bundles them as text.
 */
export interface MigrationSourceImpl {
  /**
   * Every migration, in timestamp order (`migrationsFrom`). A host that reads
   * them off disk answers asynchronously (a backend's thread never waits on
   * the disk); one that bundles them as text answers at once.
   */
  list(): Migration[] | Promise<Migration[]>;
}

export const MigrationSource = defineHostService<MigrationSourceImpl>(
  "database.migration-source",
);
