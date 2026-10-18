import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { Migration } from "./runner";

/**
 * Where this host's migration SQL comes from. The runner is portable; the
 * texts are not: the desktop reads the committed `data/*.sql` off disk
 * (`migrations#machine`, honouring a release's vendored directory), and a host
 * without a filesystem bundles them as text.
 */
export interface MigrationSourceImpl {
  /** Every migration, in timestamp order (`migrationsFrom`). */
  list(): Migration[];
}

export const MigrationSource = defineHostService<MigrationSourceImpl>(
  "database.migration-source",
);
