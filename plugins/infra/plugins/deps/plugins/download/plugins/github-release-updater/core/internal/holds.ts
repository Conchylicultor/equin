import type { Hold } from "@plugins/infra/plugins/deps/plugins/hold/core";

/** Where {@link GITHUB_RELEASE_HOLDS} is declared, named in a hold's messages. */
export const GITHUB_RELEASE_HOLDS_FILE =
  "plugins/infra/plugins/deps/plugins/download/plugins/github-release-updater/core/internal/holds.ts";

/**
 * Releases not to move to, as the shared bounded `Hold` of infra/deps/updates.
 * `names` are dependency ids (`defineDep`'s `id`), `version` / `below` release
 * tags, ordered by their dotted numbers (`compareReleaseTags`). Added by the
 * agent running a `github-release` upgrade when a new release breaks
 * something that is not ours to fix, with the reason, the upstream issue and a
 * `reviewBy` at most 90 days out (`deps-github-release:holds`).
 */
export const GITHUB_RELEASE_HOLDS: readonly Hold[] = [];
