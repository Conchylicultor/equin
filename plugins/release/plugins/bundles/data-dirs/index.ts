import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The on-disk release-bundle registry: one
 * `<namespace>/<composition>-<target>/<run-id>/` dir per release run, plus the
 * `latest-<platform>` pointers beside them. Written by the release CLI, read by
 * `resolveBundle` and by `./equin deploy ship`.
 */
export const releasesDir = defineDataDir({
  kind: "state",
  name: "releases",
  owner: "release/bundles",
  description:
    "Staged and packed release bundles, one dir per run (<namespace>/<composition>-<target>/<run-id>/) plus the latest-<platform> pointers",
  // `pruneReleaseRunDirs` already keeps the newest 3 run dirs per composition
  // plus every run a pointer names — the reclaim policy states that same rule,
  // rather than inventing a second one.
  reclaim: { kind: "keep", keep: 3 },
});

export default [releasesDir];
