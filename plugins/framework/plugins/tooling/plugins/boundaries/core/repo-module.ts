/** A specifier naming a non-module asset the bundler loads (`?raw`, `.css`, …). */
const ASSET_SPECIFIER_RE =
  /\?|\.(?:css|svg|png|jpe?g|gif|webp|json|wasm|html|md|txt|woff2?)$/;

/**
 * The repo module `specifier` names from `from`, the way the bundler resolves
 * an in-repo specifier (`@plugins/…` is `plugins/…`; a file, a `.js` spelling
 * of a `.ts` file, or a directory's index). Null for a specifier that is not
 * an in-repo module: an npm package, an asset, a path leaving `plugins/`.
 * Throws for an in-repo module specifier no file answers — tsc fails on it
 * too, and skipping it would pass whatever it loads.
 */
export function resolveRepoModule(
  from: string,
  specifier: string,
  exists: (path: string) => boolean,
): string | null {
  if (ASSET_SPECIFIER_RE.test(specifier)) return null;
  let base: string;
  if (specifier.startsWith("@plugins/")) {
    base = `plugins/${specifier.slice("@plugins/".length)}`;
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parts = from.split("/").slice(0, -1);
    for (const seg of specifier.split("/")) {
      if (seg === ".") continue;
      if (seg === "..") {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(seg);
    }
    base = parts.join("/");
  } else {
    return null;
  }
  if (!base.startsWith("plugins/")) return null;
  const stem = base.replace(/\.(?:js|jsx)$/, "");
  const candidates = /\.tsx?$/.test(base)
    ? [base]
    : [
        `${stem}.ts`,
        `${stem}.tsx`,
        // A plain-JS module beside its `.d.ts` (`sprites`' `icon-sets.js`).
        `${stem}.js`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
      ];
  const found = candidates.find(exists);
  if (found === undefined) {
    throw new Error(
      `${from} imports "${specifier}", which no repo module answers (tried ${candidates.join(", ")}).`,
    );
  }
  return found;
}
