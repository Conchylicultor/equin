import type { Hold } from "@plugins/infra/plugins/deps/plugins/updates/core";

/** Where {@link UV_HOLDS} is declared, named in a hold's messages. */
export const UV_HOLDS_FILE =
  "plugins/infra/plugins/deps/plugins/python/plugins/uv-updater/core/internal/holds.ts";

/**
 * Releases not to move to, as the shared bounded `Hold` of infra/deps/updates.
 * `names` are package names, or `cpython` for the interpreter a project's
 * `.python-version` pins — bare, a name is held in every project;
 * `<project>:<name>` holds it in that project only. Added by the agent running
 * a `uv` upgrade when a new release regresses something that is not ours to
 * fix, with the reason, the upstream issue and a `reviewBy` at most 90 days out
 * (`deps-uv:holds`). Until a diff deletes it the updater never plans a move
 * onto a held release and detection lists it as HELD; past `reviewBy` the
 * upgrade refuses to run until it is lifted or renewed. Delete it once it no
 * longer matters; renew it (a new `reviewBy` and a reason saying what was
 * checked) only when it still does.
 */
export const UV_HOLDS: readonly Hold[] = [];
