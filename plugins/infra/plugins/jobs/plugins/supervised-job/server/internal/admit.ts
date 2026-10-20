import {
  inheritedGrant,
  withHostGrant,
} from "@plugins/infra/plugins/host/plugins/host-admission/server";

/**
 * The host admission every `ExecContext` carries: one background unit, so
 * whatever runs under it (a dependency install, a dataset download) yields
 * host CPU to builds and interactive work.
 *
 * A process that INHERITED a grant (`SINGULARITY_HOST_GRANT`, set by a holder
 * for the subprocess it spawns — `./singularity deps install` run by a check
 * inside a build) spends one of those units instead: the grant contract is that
 * nothing a holder spawns re-acquires host-wide. Acquiring anyway waited on the
 * parent's own slots — on a host whose whole fleet is one unit (an 8 GB box:
 * `B = 1`), for ever, since the parent was waiting on this child.
 *
 * One definition for both mints: the supervised run body (`run-body.ts`) and
 * `cliExecContext` (`cli/internal/cli-exec-context.ts`, which reaches this file
 * through a deferred import so the `cli` declaration stays light).
 */
export function admitBackground<T>(fn: () => Promise<T>): Promise<T> {
  const inherited = inheritedGrant();
  if (inherited) return inherited.run(fn);
  return withHostGrant({ lane: "background", priority: "normal", max: 1 }, () =>
    fn(),
  );
}
