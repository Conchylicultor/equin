import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { RoutedSource } from "@plugins/infra/plugins/query-resource/server";
import type { BackgroundKindSpec } from "../../shared/providers";
import {
  makeBackgroundKind,
  type BackgroundKind as Kind,
} from "../../shared/kind";
import { backgroundCatalogServed, backgroundRecentRunsServed } from "./live";
import { addProviderTables } from "./provider-tables";

/** A registered provider: mount it in `register: [...]`, and call `changed`
 * when what it reports may have moved. */
export type BackgroundKind = Kind & Registration;

/** A worktree provider: the shared contract plus the Postgres it reads. */
export interface ServerBackgroundKindSpec extends BackgroundKindSpec {
  /**
   * Every table `list` and `recentRuns` read through the worktree `db` pool
   * (`[]` for a provider whose truth is process memory). The catalog values
   * declare the union over every registered provider as their reads, so a
   * write to one of them recomputes the catalog.
   */
  tables: readonly RoutedSource[];
}

/**
 * Declare a background provider: a mechanism that runs things on its own
 * (jobs, warm-ups, timers) reports them here, and the catalog lists them.
 *
 * ```ts
 * export const jobsBackgroundKind = defineBackgroundKind({
 *   kind: "job", label: "Jobs", tables: [_jobRunStats, _jobRuns],
 *   list: listJobEntries, recentRuns: jobRecentRuns, runNow: runJobNow,
 * });
 * // register: [jobsBackgroundKind]
 * ```
 */
export function defineBackgroundKind(
  spec: ServerBackgroundKindSpec,
): BackgroundKind {
  const kind = makeBackgroundKind(spec, {
    catalog: () => backgroundCatalogServed.notify(),
    recentRuns: (params) => backgroundRecentRunsServed.notify(params),
  });
  return {
    ...kind,
    register() {
      kind.register();
      addProviderTables(spec.kind, spec.tables);
    },
  };
}
