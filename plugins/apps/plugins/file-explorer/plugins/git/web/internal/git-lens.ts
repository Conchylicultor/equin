import { useMemo } from "react";
import type {
  ExplorerFolder,
  ExplorerLens,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { relativeTo } from "../../shared/status-index";
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
 */
export function useGitLens(folder: ExplorerFolder): ExplorerLens {
  const view = useGitView(folder.fs === "computer" ? folder.dir : null);
  return useMemo<ExplorerLens>(() => {
    if (view.kind !== "ready") return NO_LENS;
    const { checkout, index } = view;
    const rel = (path: string) => relativeTo(checkout.rootAsGiven, path);
    return {
      hide: {
        id: "git-ignored",
        label: "ignored files",
        icon: ignoredIcon,
        isHidden: (path) => {
          const r = rel(path);
          return r !== null && r !== "" && index.isIgnored(r);
        },
      },
      fileGit: (path) => {
        const r = rel(path);
        if (r === null) return undefined;
        const entry = index.entry(r);
        const status = entry?.vsMain ?? entry?.vsHead;
        if (status === undefined || status === null) return undefined;
        return { checkout: checkout.root, path: r, status };
      },
    };
  }, [view]);
}
