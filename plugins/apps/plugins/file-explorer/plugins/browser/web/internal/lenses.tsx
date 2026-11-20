import { useMemo, type ReactNode } from "react";
import type { FileViewerGit } from "@plugins/primitives/plugins/file-viewer/core";
import type { BrowsableFileSystem } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import type { ExplorerFolder, ExplorerLens, LensHideRule } from "../../core";
import { FileBrowserSlots, type ExplorerLensItem } from "../slots";
import { ExplorerDirContext } from "./explorer-dir";

/** Every contributed lens on one folder, composed. Paths are absolute. */
export interface ComposedLens {
  /** Every lens's hide rule, in contribution order. */
  hides: readonly LensHideRule[];
  /** The first lens's answer for the file at `path`. */
  fileGit(path: string): FileViewerGit | undefined;
}

/**
 * Resolve every `FileBrowserSlots.Lens` on `dir` (absolute in `fs`) and hand
 * the composition to `children`, inside which `useExplorerDir()` answers it.
 * One component per lens, chained, so each lens's hook has its own component
 * and the call order never changes; each step
 * memoizes the answers so far, so the composition keeps its identity while
 * every lens's answer does.
 */
export function WithLenses({
  fs,
  dir,
  listed = NO_LISTED,
  children,
}: {
  fs: BrowsableFileSystem;
  dir: string;
  /** The folders the browser lists (absolute); none for a file preview. */
  listed?: readonly string[];
  children: (lens: ComposedLens) => ReactNode;
}): ReactNode {
  const items = FileBrowserSlots.Lens.useContributions();
  const folder = useMemo<ExplorerFolder>(() => ({ fs, dir }), [fs, dir]);
  return (
    <ExplorerDirContext.Provider value={folder}>
      <LensStep
        items={items}
        index={0}
        dir={folder}
        listed={listed}
        answers={NO_ANSWERS}
      >
        {children}
      </LensStep>
    </ExplorerDirContext.Provider>
  );
}

const NO_ANSWERS: readonly ExplorerLens[] = [];
const NO_LISTED: readonly string[] = [];

function LensStep({
  items,
  index,
  dir,
  listed,
  answers,
  children,
}: {
  items: readonly ExplorerLensItem[];
  index: number;
  dir: ExplorerFolder;
  listed: readonly string[];
  answers: readonly ExplorerLens[];
  children: (lens: ComposedLens) => ReactNode;
}): ReactNode {
  const item = items[index];
  if (item === undefined) {
    return <Compose answers={answers}>{children}</Compose>;
  }
  return (
    <ResolveLens
      key={item.id}
      item={item}
      dir={dir}
      listed={listed}
      answers={answers}
    >
      {(next) => (
        <LensStep
          items={items}
          index={index + 1}
          dir={dir}
          listed={listed}
          answers={next}
        >
          {children}
        </LensStep>
      )}
    </ResolveLens>
  );
}

function ResolveLens({
  item,
  dir,
  listed,
  answers,
  children,
}: {
  item: ExplorerLensItem;
  dir: ExplorerFolder;
  listed: readonly string[];
  answers: readonly ExplorerLens[];
  children: (answers: readonly ExplorerLens[]) => ReactNode;
}): ReactNode {
  const { useLens } = item;
  const answer = useLens(dir, listed);
  const next = useMemo(() => [...answers, answer], [answers, answer]);
  return children(next);
}

function Compose({
  answers,
  children,
}: {
  answers: readonly ExplorerLens[];
  children: (lens: ComposedLens) => ReactNode;
}): ReactNode {
  const lens = useMemo<ComposedLens>(
    () => ({
      hides: answers.flatMap((a) => (a.hide === undefined ? [] : [a.hide])),
      fileGit: (path) => {
        for (const a of answers) {
          const git = a.fileGit?.(path);
          if (git !== undefined) return git;
        }
        return undefined;
      },
    }),
    [answers],
  );
  return children(lens);
}
