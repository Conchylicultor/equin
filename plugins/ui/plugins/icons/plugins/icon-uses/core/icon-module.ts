/**
 * The modules `symbol` / `brand` / `seti` can be imported from, by repo path
 * (no extension): the core barrel, and the file defining them — which the
 * icons plugin's own files reach by a relative path (`./icon-ref`, `../../core`).
 */
const ICON_REF_MODULES = [
  "plugins/ui/plugins/icons/core",
  "plugins/ui/plugins/icons/core/icon-ref",
] as const;

const PLUGINS_ALIAS = "@plugins/";

/** `a/b/../c/./d` → `a/c/d` (posix, no filesystem). */
function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `${path.startsWith("/") ? "/" : ""}${out.join("/")}`;
}

/**
 * Does the import `specifier`, written in `fromFile` (repo-relative or
 * absolute), resolve to the module that exports the icon constructors?
 *
 * The one answer to "is this the icons `symbol`" for every reader that scans
 * source for icon names — the manifest scan and the icons lint rules — so a
 * file reaching the constructors by any spelling (the barrel alias, or a
 * relative path from inside the plugin) is never invisible to one of them.
 */
export function isIconRefModule(fromFile: string, specifier: string): boolean {
  let target: string;
  if (specifier.startsWith(PLUGINS_ALIAS)) {
    target = `plugins/${specifier.slice(PLUGINS_ALIAS.length)}`;
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const dir = fromFile.slice(0, Math.max(0, fromFile.lastIndexOf("/")));
    target = `${dir}/${specifier}`;
  } else {
    return false;
  }
  const module = normalize(target)
    .replace(/\.(ts|tsx|js)$/, "")
    .replace(/\/index$/, "");
  return ICON_REF_MODULES.some((m) => module === m || module.endsWith(`/${m}`));
}
