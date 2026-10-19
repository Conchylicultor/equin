import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/**
 * Head HTML per app path: the key is an app's base path (`/home`), matched
 * like the app router matches one (the path itself, or anything under it), and
 * `""` is every other path. The longest matching key wins.
 */
export type HeadFragments = Record<string, string>;

/**
 * Something that must be in the SPA shell's `<head>` before the first frame —
 * the theme's CSS — and that the server knows: the gateway serves `index.html`
 * as a static file and splices in the fragment matching the requested path.
 *
 * `render` is called at boot and again whenever `subscribe`'s callback fires
 * (calls are coalesced). It throws rather than answer with an empty fragment:
 * an empty one would be served as the truth.
 */
export interface HeadFragmentSource {
  /** Names the source in errors. */
  id: string;
  render(): Promise<HeadFragments>;
  /** Hear that `render` would answer differently now. Returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
}

export const DocumentHead = {
  Fragment: defineServerContribution<HeadFragmentSource>(
    "DocumentHead.Fragment",
    { docLabel: (c) => c.id },
  ),
};

/** The fragment `fragments` serves for `path`: its longest matching key, else `""`'s, else nothing. */
export function matchHeadFragment(
  fragments: HeadFragments,
  path: string,
): string {
  let best: string | undefined;
  for (const key of Object.keys(fragments)) {
    if (key === "") continue;
    if (path !== key && !path.startsWith(`${key}/`)) continue;
    if (best === undefined || key.length > best.length) best = key;
  }
  return fragments[best ?? ""] ?? "";
}

/**
 * One fragment set out of every source's: for each key any source names, every
 * source's own match for that key (its longest matching key, or its `""`), in
 * source order. So a source that only answers `""` is in every entry, and one
 * that answers `/home` wins that path without displacing the others.
 */
export function mergeHeadFragments(
  perSource: readonly HeadFragments[],
): HeadFragments {
  const keys = new Set(perSource.flatMap((f) => Object.keys(f)));
  keys.add("");
  const merged: HeadFragments = {};
  for (const key of [...keys].sort()) {
    merged[key] = perSource.map((f) => matchHeadFragment(f, key)).join("");
  }
  return merged;
}
