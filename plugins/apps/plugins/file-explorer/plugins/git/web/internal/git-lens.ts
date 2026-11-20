import { useMemo, useState } from "react";
import type {
  ExplorerFolder,
  ExplorerLens,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { fileExplorerGitIgnored } from "../../shared/resources";
import { ancestors, relativeTo } from "../../shared/status-index";
import { useGitView } from "./use-git";

// A git glyph, not a second eye: beside Show hidden files it must read as a
// different toggle.
const ignoredIcon = symbol("commit");

/** Outside a checkout, or before its status is known, git says nothing. */
const NO_LENS: ExplorerLens = {};

/**
 * The git lens on the absolute folder `dir` — of the computer's disk only
 * (git runs on this computer's checkouts): ignored files behind a "Show
 * ignored files" toggle, and a changed file's git context (its status against
 * the main merge-base, else against HEAD), which gives its preview a Diff tab.
 *
 * What git ignores is read per folder the browser lists (`listed`), one
 * `file-explorer.git-ignored` read each (its entries and its subfolders'
 * entries, so a collapsed folder's item count is covered too) — never the
 * whole tree below `dir`.
 */
export function useGitLens(
  folder: ExplorerFolder,
  listed: readonly string[],
): ExplorerLens {
  const view = useGitView(folder.fs === "computer" ? folder.dir : null);
  const checkout = view.kind === "ready" ? view.checkout : null;
  const tuples = useMemo(
    () =>
      checkout === null
        ? []
        : listed.map((abs) => {
            const dir = relativeTo(checkout.rootAsGiven, abs);
            return dir === null ? null : { root: checkout.root, dir };
          }),
    [checkout, listed],
  );
  const reads = useLive(fileExplorerGitIgnored, tuples);
  // Every ignored path the listed folders' answers name, relative to the
  // checkout — keyed by its content, so the lens keeps its identity across
  // pushes that change nothing. Unavailable (no computer) only where the
  // status is too, and then the lens says nothing anyway.
  const ready = "status" in reads ? [] : reads;
  const ignoredKey = tuples
    .flatMap((t, i) => {
      const read = ready[i];
      if (t === null || read === undefined || read.status !== "ready")
        return [];
      return read.data.paths.map((p) => (t.dir === "" ? p : `${t.dir}/${p}`));
    })
    .join("\0");
  // While a newly listed folder's answer loads (a navigation, an expansion),
  // the last settled answer still stands: it already covers a folder one
  // level below a listed one, and what git ignores rarely moves meanwhile —
  // so ignored entries do not flash into view and out again.
  const settled = tuples.every(
    (t, i) =>
      t === null || (ready[i] !== undefined && ready[i].status !== "loading"),
  );
  const [lastSettled, setLastSettled] = useState(ignoredKey);
  if (settled && lastSettled !== ignoredKey) setLastSettled(ignoredKey);
  const shownKey = settled ? ignoredKey : `${lastSettled}\0${ignoredKey}`;
  const ignored = useMemo(
    () => new Set(shownKey.split("\0").filter((p) => p !== "")),
    [shownKey],
  );
  return useMemo<ExplorerLens>(() => {
    if (view.kind !== "ready") return NO_LENS;
    const { index } = view;
    const rel = (path: string) => relativeTo(view.checkout.rootAsGiven, path);
    return {
      hide: {
        id: "git-ignored",
        label: "ignored files",
        icon: ignoredIcon,
        isHidden: (path) => {
          const r = rel(path);
          if (r === null || r === "") return false;
          // Ignored itself, or below an ignored folder (which holds only
          // ignored paths).
          return ignored.has(r) || ancestors(r).some((a) => ignored.has(a));
        },
      },
      fileGit: (path) => {
        const r = rel(path);
        if (r === null) return undefined;
        const entry = index.entry(r);
        const status = entry?.vsMain ?? entry?.vsHead;
        if (status === undefined || status === null) return undefined;
        return { checkout: view.checkout.root, path: r, status };
      },
    };
  }, [view, ignored]);
}
