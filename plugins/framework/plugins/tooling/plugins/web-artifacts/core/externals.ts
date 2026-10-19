// The externals rule — the plugin-boundary grammar expressed to the bundler.
//
// One artifact per imported barrel specifier: everything that is NOT part of
// this artifact's own inlined source stays verbatim in the emitted JS (the
// import map resolves it at runtime). This is what preserves module identity
// (React contexts, slot registries, live-state singleton, …) and what makes
// rebuilds cascade-free.
//
// Which of the plugin's OWN folders are inlined is not decided here: it is
// `inlinedRootsFor(kind)` in `own-roots.ts`, the same list the artifact's
// address hashes. Read that file first — the two must agree or the store serves
// a bundle built against source its address never saw.

import { isBrowserHostSpecifier } from "./browser-host-specifier";
import { COMPOSITION_SPECIFIERS } from "./composition-modules";
import { isBareSpecifier, isInlinedPackage } from "./constants";
import {
  firstSegmentOf,
  inlinedRootsFor,
  type ArtifactKind,
} from "./own-roots";

/**
 * Build the Rollup `external` predicate for one plugin artifact.
 *
 * - Other plugins' `@plugins/*` specifiers → external (import map).
 * - An OWN-path specifier `@plugins/<own>/<seg>[/deep]` → inlined iff `seg` is
 *   one of `inlinedRootsFor(kind)`; every other own folder is external, routed
 *   to its own barrel artifact. One URL = one module instance: any folder that
 *   ships as its own artifact can hold module state, and inlining a private
 *   copy of it next to the artifact other plugins load would double-instantiate
 *   it. That covers own sub-plugins too (`@plugins/<own>/plugins/…` are
 *   DIFFERENT plugins — `plugins` is never an inlined root).
 * - Bare npm specifiers → external unless the package is inline-allowlisted.
 *
 * `ownPluginPath` is null for the composition-root entry artifact (web-core),
 * which has no `@plugins` self-specifier — its own files are reached relatively.
 */
export function makeArtifactExternal(
  ownPluginPath: string | null,
  kind: ArtifactKind,
): (id: string) => boolean {
  const ownPrefix = ownPluginPath ? `@plugins/${ownPluginPath}/` : null;
  const inlinedRoots = inlinedRootsFor(kind);
  return (id: string): boolean => {
    if (id.startsWith("\0")) return false;
    // A CSS specifier is never a module URL — package CSS (xterm.css, katex,
    // react-diff-view, …) and plugin CSS alike stay in-graph so vite's css
    // pipeline extracts them into the artifact's injected styles (the entry
    // build's strip plugin nulls the global app.css separately).
    if (id.endsWith(".css")) return false;
    if (COMPOSITION_SPECIFIERS.has(id) || isBrowserHostSpecifier(id))
      return true;
    if (id.startsWith("@plugins/")) {
      if (ownPrefix !== null && id.startsWith(ownPrefix)) {
        return !inlinedRoots.includes(
          firstSegmentOf(id.slice(ownPrefix.length)),
        );
      }
      return true;
    }
    if (!isBareSpecifier(id)) return false;
    return !isInlinedPackage(id);
  };
}
