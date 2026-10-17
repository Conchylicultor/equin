import type { Hold } from "@plugins/infra/plugins/deps/plugins/updates/core";

/** Where {@link UV_HOLDS} is declared, named in a hold's messages. */
export const UV_HOLDS_FILE =
  "plugins/infra/plugins/deps/plugins/python/plugins/uv-updater/core/internal/holds.ts";

/**
 * Releases not to move to, as the shared bounded `Hold` of infra/deps/updates.
 * `names` are package names, or `cpython` for the interpreter a project's
 * `.python-version` pins. Added by the agent running a `uv` upgrade when a new
 * release regresses something that is not ours to fix, with the reason, the
 * upstream issue and an `until` at most 90 days out (`deps-uv:holds`). While
 * active the updater never plans a move onto a held release and detection lists
 * it as HELD; the day after `until` it is inert. Delete it once it no longer
 * matters; renew it (a new `until` and reason) only when it still does.
 */
export const UV_HOLDS: readonly Hold[] = [
  {
    names: ["cpython"],
    version: "3.15.0",
    reason:
      "torch 2.14 ships no cp315 wheels, so `uv sync` of audio-analysis fails on CPython 3.15; cp315 wheels arrive with torch 2.15 (GA 2026-10-28)",
    issue:
      "https://dev-discuss.pytorch.org/t/notice-python-3-10-support-is-being-removed-from-pytorch-2-15-2-14-is-the-last-release-with-3-10-wheels/3440",
    until: "2026-11-15",
  },
];
