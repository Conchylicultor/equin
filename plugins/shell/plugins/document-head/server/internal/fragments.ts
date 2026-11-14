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

/**
 * Who may frame an app's pages: the shell the gateway serves under `path` (an
 * app's base path, matched like a head fragment's key) carries
 * `Content-Security-Policy: frame-ancestors <ancestors>`. Paths no policy names
 * are served without one, as before.
 *
 * Static by design — who may embed a page is a fact of the code, not of the
 * user's data. Two policies naming the same path are refused at publish: which
 * of two framing rules wins is not something to settle silently.
 */
export interface FrameAncestorsPolicy {
  /** Names the policy in errors. */
  id: string;
  /** The app's base path (`/home/browser-extension`). */
  path: string;
  /**
   * CSP source expressions (`chrome-extension://<id>`, `'self'`); none of them
   * may hold whitespace, `;` or `,`, which would end the directive.
   */
  ancestors: readonly string[];
}

/** document-head.json's `frameAncestors`: each policy's ancestors by its path. */
export type FrameAncestorsByPath = Record<string, readonly string[]>;

export const DocumentHead = {
  Fragment: defineServerContribution<HeadFragmentSource>(
    "DocumentHead.Fragment",
    { docLabel: (c) => c.id },
  ),
  FrameAncestors: defineServerContribution<FrameAncestorsPolicy>(
    "DocumentHead.FrameAncestors",
    { docLabel: (c) => `${c.id} (${c.path})` },
  ),
};

const CSP_SOURCE = /^[^\s;,]+$/;
const APP_PATH = /^\/[^\s?#]*[^/\s?#]$/;

/**
 * Every policy, keyed by its path — after checking each: an app path (leading
 * `/`, no trailing one), at least one ancestor, each a single source
 * expression, and no path named twice. Throws naming the policy otherwise.
 */
export function frameAncestorsByPath(
  policies: readonly FrameAncestorsPolicy[],
): FrameAncestorsByPath {
  const out: Record<string, readonly string[]> = {};
  const owner = new Map<string, string>();
  for (const p of policies) {
    if (!APP_PATH.test(p.path)) {
      throw new Error(
        `frame-ancestors policy ${p.id}: ${JSON.stringify(p.path)} is not an app path`,
      );
    }
    if (p.ancestors.length === 0) {
      throw new Error(
        `frame-ancestors policy ${p.id}: no ancestors (to forbid framing, say 'none')`,
      );
    }
    for (const a of p.ancestors) {
      if (!CSP_SOURCE.test(a)) {
        throw new Error(
          `frame-ancestors policy ${p.id}: ${JSON.stringify(a)} is not one CSP source expression`,
        );
      }
    }
    const prior = owner.get(p.path);
    if (prior !== undefined) {
      throw new Error(
        `frame-ancestors policies ${prior} and ${p.id} both name ${p.path}`,
      );
    }
    owner.set(p.path, p.id);
    out[p.path] = p.ancestors;
  }
  return out;
}

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
