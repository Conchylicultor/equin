// Which files of a package a dependency patch (`patches/*.patch`, the git-style
// diff `bun patch` writes) touches — so a cache that reads only some kinds of
// file in `node_modules` (the type check reads declarations, never `.js`)
// can tell a patch it cannot see from one it can.

/**
 * The package-relative paths a git-style diff touches (both sides of a
 * rename), sorted — read off its `diff --git a/<x> b/<y>` headers, which no
 * hunk line can imitate (each of those starts with ` `, `+` or `-`). Undefined
 * when it has no such header, which a caller must treat as "could touch
 * anything": a patch this cannot read is never assumed inert.
 */
export function patchTouchedFiles(text: string): string[] | undefined {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m === null) continue;
    out.add(m[1]!);
    out.add(m[2]!);
  }
  return out.size === 0 ? undefined : [...out].sort();
}
