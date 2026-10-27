import { serveValue } from "@plugins/network/plugins/live/machine";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { hostFsCompletions, type HostFsCompletions } from "../../core";
import { completeHostDir, splitPrefix } from "../../server/internal/complete";
import { refusalFor } from "./refuse";
import { watchHostDir } from "./watch-dir";

/**
 * The folder a prefix searches and the fragment it matches, or — when the
 * prefix names no folder (empty, relative, a NUL) — the reason
 * {@link splitPrefix} gave, which the loader refuses as `invalid-path`.
 */
function splitOrInvalid(
  prefix: string,
): { dir: string; fragment: string } | { invalid: string } {
  try {
    return splitPrefix(prefix);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) {
      return { invalid: err.message };
    }
    throw err;
  }
}

/** A typed path's folder completions, or the refusal saying why there are none. */
export async function completions(prefix: string): Promise<HostFsCompletions> {
  const split = splitOrInvalid(prefix);
  if ("invalid" in split) {
    throw hostFsCompletions.refuse("invalid-path", split.invalid);
  }
  const done = await completeHostDir(split.dir, split.fragment);
  if (done.kind !== "ok") throw refusalFor(hostFsCompletions.refuse, done);
  return { dir: done.dir, matches: done.matches, truncated: done.truncated };
}

/**
 * Folder completions of a typed path, pushed from a watch of the folder
 * searched while read (a folder created, renamed or removed there changes
 * them; so does the folder itself appearing). Throttled like a listing: a
 * folder being written re-reads at most once a second.
 */
export const hostFsCompletionsServed = serveValue(hostFsCompletions, {
  source: "external",
  changes: "notified",
  throttleMs: 1_000,
  loader: ({ prefix }) => completions(prefix),
  whileSubscribed: async ({ prefix }, notify) => {
    const split = splitOrInvalid(prefix);
    // The loader refuses the spelling; there is nothing to watch.
    if ("invalid" in split) return () => {};
    return watchHostDir(split.dir, () => notify());
  },
});
