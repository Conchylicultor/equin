// The rung-4 assert behind the "an artifact's address covers exactly what its
// bytes inline" invariant: per built artifact, everything rollup ACTUALLY
// inlined must be a file the artifact's address hashed — one of the exact
// files planning read off the repo snapshot (`hashedFiles`). Bare root
// containment would not do: test code (`web/testing/`, `__tests__/`) lives
// inside a root but is never hashed, and neither is a file the snapshot does
// not hold (gitignored, or written after it was taken) — a shipping file that
// reached either would bake unaddressed content into the bundle.
//
// Deliberately independent of BOTH halves it guards. It does not read
// `inlinedRootsFor` to decide what should have been inlined, and it does not
// consult the externals predicate or the own-folder-barrel rewrite — it reads
// the module ids rollup emitted (`generateBundle` → `chunk.modules`,
// post-tree-shaking) and compares them against the roots the address hashed.
// So a future vite plugin, alias, resolver, or new folder kind that quietly
// pulls unhashed source into a bundle fails the build instead of fossilising in
// the content-addressed store.
//
// Reused (unbuilt) artifacts are not re-audited, and do not need to be: this
// file is part of the builder source digest that feeds the builder identity, so
// touching it invalidates the whole fleet once and every artifact is rebuilt —
// and audited — under the new identity.

import type { Plugin as VitePlugin } from "vite";

export interface InlineAudit {
  /** Collects the emitted module ids. Add to the build's `plugins`. */
  plugin: VitePlugin;
  /** Throws if any inlined first-party module lies outside the hashed roots. */
  verify(): void;
}

/** How many offending paths the error message lists before summarizing. */
const MAX_LISTED = 20;

export function createInlineAudit(opts: {
  dirName: string;
  /** For the message: where the hashed files live. */
  hashedRoots: string[];
  /** Absolute paths of every file the address hashed. */
  hashedFiles: readonly string[];
  /**
   * Module ids the build synthesizes from hashed files alone (a web barrel's
   * plugin definition, `plugin-definition.ts`): no file of their own, so
   * nothing outside the address can reach the bundle through them.
   */
  derivedIds?: readonly string[];
  kind: string;
}): InlineAudit {
  const hashed = new Set([...opts.hashedFiles, ...(opts.derivedIds ?? [])]);
  const emitted = new Set<string>();
  const plugin: VitePlugin = {
    name: "web-artifacts:inline-audit",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules)) emitted.add(id);
      }
    },
  };

  return {
    plugin,
    verify() {
      const offenders = new Set<string>();
      for (const raw of emitted) {
        // Vite appends query suffixes to a module id (`?used`, `?worker`, …);
        // the file it names is what matters for containment.
        const q = raw.indexOf("?");
        const id = q === -1 ? raw : raw.slice(0, q);
        if (id.startsWith("\0")) continue; // virtual module, no source file
        if (!id.startsWith("/")) continue; // non-path virtual id
        if (id.includes("/node_modules/")) continue; // npm code, covered by the identity hash
        // The exact hashed set, not bare root containment: test code
        // (`web/testing/`, `__tests__/`) and gitignored files sit inside a
        // root yet are never hashed.
        if (hashed.has(id)) continue;
        offenders.add(id);
      }
      if (offenders.size === 0) return;

      const sorted = [...offenders].sort();
      const listed = sorted.slice(0, MAX_LISTED);
      const tail =
        sorted.length > listed.length
          ? `\n  …and ${sorted.length - listed.length} more`
          : "";
      throw new Error(
        `web-artifact ${opts.dirName} (kind "${opts.kind}") inlined ${sorted.length} source ` +
          `file(s) its address does not hash — outside its hashed roots, test code ` +
          `(\`testing/\`, \`__tests__/\`, \`*.test.ts\`) that shipping code must never import, ` +
          `or a file the build's repo snapshot does not hold (gitignored, or written after ` +
          `the snapshot was taken):\n` +
          listed.map((p) => `  ${p}`).join("\n") +
          tail +
          `\n  hashed roots: ${opts.hashedRoots.join(", ")}\n` +
          `  Those files' content reaches the bundle but not the store address, so editing ` +
          `them leaves the store answering "unchanged" and serving this artifact forever ` +
          `against sibling code it was never built with. Fix: route the folder through its ` +
          `own barrel (external), or add it to inlinedRootsFor() in core/own-roots.ts.`,
      );
    },
  };
}
