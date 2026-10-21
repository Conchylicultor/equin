import type {
  ClipboardEvent,
  CSSProperties,
  JSX,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  Decoration,
  Diff,
  Hunk,
  expandFromRawCode,
  getCollapsedLinesCountBetween,
  parseDiff,
} from "react-diff-view";
import type { FileData, HunkData, TokenNode } from "react-diff-view";
import "react-diff-view/style/index.css";
import { useDarkMode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { selectionRange } from "@plugins/primitives/plugins/dom/plugins/dom-selection/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  codeFile,
  codeFileDiff,
} from "@plugins/code-explorer/plugins/code-api/core";
import { diffLang, useDiffTokens } from "../use-diff-tokens";
import type { DiffTokens } from "../use-diff-tokens";
import "./diff-view.css";

type DiffSide = "old" | "new";

// 1-based :nth-child index of the code cell in 4-col split rows.
// Monotonous (pure-add / pure-delete) rows always put the code cell at :nth-child(2).
const CODE_NTH_SPLIT: Record<DiffSide, number> = { old: 2, new: 4 };
const CODE_NTH_MONO = 2;

// react-diff-view renders split rows with 4 cells (old-gutter, old-code,
// new-gutter, new-code) or, for pure-add/pure-delete hunks, monotonous 2-cell
// rows. In 4-col mode the side is unambiguous from the column index; 2-col
// rows are ambiguous from the DOM — the caller passes fixedSide for those.
function getSide(el: Element | null): DiffSide | null {
  while (el) {
    if (el.tagName === "TD") {
      const tr = el.parentElement;
      if (!tr?.classList.contains("diff-line")) return null;
      let idx = 0;
      let prev = el.previousElementSibling;
      while (prev) {
        idx++;
        prev = prev.previousElementSibling;
      }
      const count = tr.children.length;
      if (count === 4) return idx <= 1 ? "old" : "new";
      return null;
    }
    el = el.parentElement;
  }
  return null;
}

function getSideFromNode(node: Node | null): DiffSide | null {
  return getSide(
    node instanceof Element ? node : (node?.parentElement ?? null),
  );
}

export const DiffRenderer = memo(function DiffRenderer({
  files,
  hunks,
  tokens,
  totalLines,
  onExpandLines,
}: {
  files: FileData[];
  hunks: HunkData[] | null;
  tokens: DiffTokens | null;
  totalLines?: number | null;
  onExpandLines?: (start: number, end: number) => void;
}) {
  const fixedSide: DiffSide | null =
    files[0]?.type === "add"
      ? "new"
      : files[0]?.type === "delete"
        ? "old"
        : null;

  const containerRef = useRef<HTMLElement>(null);
  const lastClickedSide = useRef<DiffSide | null>(null);

  function handleMouseDown(e: MouseEvent<HTMLElement>) {
    if (fixedSide) {
      lastClickedSide.current = fixedSide;
      return;
    }

    const side = getSide(e.target as Element);
    lastClickedSide.current = side;
    if (!side || !containerRef.current) return;

    const container = containerRef.current;
    const activeSide = side;
    container.setAttribute("data-active-side", activeSide);

    function onSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const focusSide = getSideFromNode(sel.focusNode);
      if (!focusSide || focusSide === activeSide) return;

      const anchorNode = sel.anchorNode;
      const anchorOffset = sel.anchorOffset;
      const nth = CODE_NTH_SPLIT[activeSide];
      const cells = Array.from(
        container.querySelectorAll<Element>(
          `.diff-line > td:nth-child(${nth})`,
        ),
      );
      const firstCell = cells[0];
      const lastCell = cells[cells.length - 1];
      if (!firstCell || !lastCell) return;

      const range = document.createRange();
      if (activeSide === "old") {
        if (anchorNode) range.setStart(anchorNode, anchorOffset);
        else range.setStartBefore(firstCell);
        range.setEndAfter(lastCell);
      } else {
        range.setStartBefore(firstCell);
        if (anchorNode) range.setEnd(anchorNode, anchorOffset);
        else range.setEndAfter(lastCell);
      }
      sel.removeAllRanges();
      sel.addRange(range);
    }

    document.addEventListener("selectionchange", onSelectionChange);

    const cleanup = () => {
      document.removeEventListener("mouseup", cleanup);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
    document.addEventListener("mouseup", cleanup);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "a" && containerRef.current) {
      const sel = window.getSelection();
      if (!sel) return;

      const side =
        fixedSide ?? lastClickedSide.current ?? getSideFromNode(sel.anchorNode);
      if (!side) return;

      e.preventDefault();
      sel.removeAllRanges();
      if (!fixedSide)
        containerRef.current.setAttribute("data-active-side", side);
      const nth = fixedSide ? CODE_NTH_MONO : CODE_NTH_SPLIT[side];
      const cells = containerRef.current.querySelectorAll(
        `.diff-line > td:nth-child(${nth})`,
      );
      const first = cells[0];
      const last = cells[cells.length - 1];
      if (first && last) {
        const range = document.createRange();
        range.setStartBefore(first);
        range.setEndAfter(last);
        sel.addRange(range);
      }
    }
  }

  function handleCopy(e: ClipboardEvent<HTMLElement>) {
    const side = lastClickedSide.current;
    if (!side || !containerRef.current) return;

    const range = selectionRange();
    if (!range) return;

    const nth = fixedSide ? CODE_NTH_MONO : CODE_NTH_SPLIT[side];
    const lines: string[] = [];

    for (const row of containerRef.current.querySelectorAll<HTMLElement>(
      ".diff-line",
    )) {
      const cell = row.children[nth - 1] as Element | undefined;
      if (!cell || !range.intersectsNode(cell)) continue;
      const cellRange = document.createRange();
      cellRange.selectNodeContents(cell);
      if (range.compareBoundaryPoints(Range.START_TO_START, cellRange) > 0) {
        cellRange.setStart(range.startContainer, range.startOffset);
      }
      if (range.compareBoundaryPoints(Range.END_TO_END, cellRange) < 0) {
        cellRange.setEnd(range.endContainer, range.endOffset);
      }
      lines.push(cellRange.toString());
    }

    if (lines.length > 0) {
      e.clipboardData.setData("text/plain", lines.join("\n"));
      e.preventDefault();
    }
  }

  // Memoize the heavy react-diff-view element tree on its actual inputs. The
  // transcript re-renders at several Hz from idle live-state pushes; without
  // this, every propagation re-render hands <Diff> a fresh `children` render
  // prop, defeating its internal memo() and re-reconciling every hunk/line/cell
  // (the diff is the heaviest subtree on the page). Reusing the same element
  // refs lets React bail out of the subtree entirely on an unchanged re-render.
  const diffElements = useMemo(() => {
    const effectiveHunks = hunks ?? files[0]?.hunks ?? [];
    return files.map((file, i) => (
      <Diff
        key={`${file.oldRevision}-${file.newRevision}`}
        viewType="split"
        diffType={file.type}
        hunks={i === 0 ? effectiveHunks : file.hunks}
        tokens={i === 0 ? tokens : null}
        renderToken={renderShikiToken}
      >
        {(fileHunks) =>
          fileHunks.flatMap((hunk, idx) => {
            const prevHunk = idx > 0 ? fileHunks[idx - 1] : null;
            const linesAbove = prevHunk
              ? getCollapsedLinesCountBetween(prevHunk, hunk)
              : hunk.oldStart - 1;
            const gapStart = prevHunk
              ? prevHunk.oldStart + prevHunk.oldLines
              : 1;
            const gapEnd = hunk.oldStart;
            const elements: JSX.Element[] = [];
            if (linesAbove > 0 && i === 0 && onExpandLines) {
              elements.push(
                <Decoration key={`skip-${idx}-${hunk.newStart}`}>
                  <SkipSeparator
                    count={linesAbove}
                    onExpandTop={(n) =>
                      onExpandLines(gapStart, Math.min(gapStart + n, gapEnd))
                    }
                    onExpandBottom={(n) =>
                      onExpandLines(Math.max(gapEnd - n, gapStart), gapEnd)
                    }
                    onExpandAll={() => onExpandLines(gapStart, gapEnd)}
                  />
                </Decoration>,
              );
            }
            elements.push(<Hunk key={hunk.content} hunk={hunk} />);
            if (
              idx === fileHunks.length - 1 &&
              i === 0 &&
              totalLines != null &&
              onExpandLines
            ) {
              const lastOldLine = hunk.oldStart + hunk.oldLines - 1;
              const linesBelow = totalLines - lastOldLine;
              if (linesBelow > 0) {
                elements.push(
                  <Decoration key={`skip-end-${hunk.newStart}`}>
                    <SkipSeparator
                      count={linesBelow}
                      onExpandTop={(n) =>
                        onExpandLines(
                          lastOldLine + 1,
                          Math.min(lastOldLine + 1 + n, totalLines + 1),
                        )
                      }
                      onExpandBottom={(n) =>
                        onExpandLines(
                          Math.max(totalLines + 1 - n, lastOldLine + 1),
                          totalLines + 1,
                        )
                      }
                      onExpandAll={() =>
                        onExpandLines(lastOldLine + 1, totalLines + 1)
                      }
                    />
                  </Decoration>,
                );
              }
            }
            return elements;
          })
        }
      </Diff>
    ));
  }, [files, hunks, tokens, totalLines, onExpandLines]);

  return (
    <Scroll
      axis="both"
      ref={containerRef}
      // eslint-disable-next-line text/no-adhoc-typography -- leading-5 fixes mono diff line-height for gutter alignment, distinct from caption's tighter line-height
      className="diff-view font-mono text-caption leading-5"
      data-monotonous={fixedSide ? "" : undefined}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onCopy={handleCopy}
      tabIndex={-1}
    >
      {diffElements}
    </Scroll>
  );
});

export function DiffView({
  worktree,
  path,
  base,
  head,
  from,
}: {
  worktree: string;
  path: string;
  base?: string;
  head?: string;
  from?: string;
}) {
  const read = useLive(codeFileDiff, { worktree, path, base, head, from });

  switch (read.status) {
    case "unavailable":
      return <Placeholder>{read.message}</Placeholder>;
    case "loading":
      return <Loading />;
    case "error": {
      const { error } = read;
      if (error.kind === "refused" && error.code === "missing") {
        return <Placeholder tone="error">File not found.</Placeholder>;
      }
      if (error.kind === "refused" && error.code === "too-large") {
        return (
          <Placeholder tone="error">Diff is too large to preview.</Placeholder>
        );
      }
      return (
        <ResourceErrorInline
          variant="block"
          error={error}
          refetch={read.refetch}
          subject="the diff"
        />
      );
    }
    case "ready":
      break;
  }

  // Self-keyed inner body: remounting on file identity re-initializes the
  // expansion state. The remount stays owned by the primitive so no consumer
  // can forget the key.
  const instanceKey = [worktree, path, base ?? "", head ?? "", from ?? ""].join(
    ":",
  );
  return (
    <DiffBody
      key={instanceKey}
      worktree={worktree}
      path={path}
      base={base}
      head={head}
      from={from}
      diff={read.data.diff}
    />
  );
}

/**
 * One side's whole-file text as the diff body uses it: not known yet, known
 * (`null` — the server refused to read it as text: not there, binary, too
 * large — is a side with no text, an answer about the file), or a failed read.
 */
type SideText =
  | { state: "loading" }
  | { state: "text"; content: string | null }
  | { state: "failed"; error: Error; refetch: () => Promise<void> };

function sideText(
  read: ResourceResult<{ content: string }> | undefined,
): SideText {
  // No read: the side is not needed (no highlighting for this language).
  if (read === undefined) return { state: "text", content: null };
  switch (read.status) {
    case "loading":
      return { state: "loading" };
    case "ready":
      return { state: "text", content: read.data.content };
    case "error":
      return read.error.kind === "refused"
        ? { state: "text", content: null }
        : { state: "failed", error: read.error, refetch: read.refetch };
  }
}

function DiffBody({
  worktree,
  path,
  base,
  head,
  from,
  diff,
}: {
  worktree: string;
  path: string;
  base?: string;
  head?: string;
  from?: string;
  diff: string;
}) {
  const dark = useDarkMode();
  const basePath = from ?? path;
  const lang = diffLang(path);

  const files = useMemo<FileData[]>(() => {
    if (diff.length === 0) return [];
    try {
      return parseDiff(diff);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      return [];
    }
  }, [diff]);

  // Both sides' whole text, read live beside the diff: the old side (the base
  // ref) gives the expandable context lines and both give the syntax tokens.
  // The new side is read only when there is a language to highlight it in.
  const reads = useLive(
    codeFile,
    files.length === 0
      ? []
      : [
          { worktree, path: basePath, ref: base ?? "HEAD" },
          lang === null ? null : { worktree, path, ref: head },
        ],
  );
  // Unavailable cannot be reached in practice — the diff itself needs the same
  // computer — and reads no text: no tokens, no expansion.
  const sides = "status" in reads ? null : reads;
  const oldSide = sideText(sides?.[0]);
  const newSide = sideText(sides?.[1]);
  const oldText = oldSide.state === "text" ? oldSide.content : null;

  const baseHunks = files[0]?.hunks ?? null;
  // An expansion belongs to the hunks and the text it was made from: a live
  // change to either drops it rather than showing lines of another revision.
  const [expansion, setExpansion] = useState<{
    from: HunkData[] | null;
    text: string;
    hunks: HunkData[];
  } | null>(null);
  const effectiveHunks =
    expansion !== null &&
    expansion.from === baseHunks &&
    expansion.text === oldText
      ? expansion.hunks
      : baseHunks;

  const tokens = useDiffTokens(
    effectiveHunks,
    lang,
    dark,
    oldSide.state === "text" && newSide.state === "text"
      ? { old: oldSide.content, new: newSide.content }
      : null,
  );

  const expandLines = useCallback(
    (start: number, end: number) => {
      if (oldText === null) return;
      setExpansion((prev) => {
        const current =
          prev !== null && prev.from === baseHunks && prev.text === oldText
            ? prev.hunks
            : (baseHunks ?? []);
        return {
          from: baseHunks,
          text: oldText,
          hunks: expandFromRawCode(current, oldText, start, end),
        };
      });
    },
    [oldText, baseHunks],
  );

  if (diff.length === 0 || files.length === 0) {
    return <Placeholder>No changes vs {base ?? "HEAD"}.</Placeholder>;
  }

  const renderer = (
    <DiffRenderer
      files={files}
      hunks={effectiveHunks}
      tokens={tokens}
      totalLines={oldText === null ? null : oldText.split("\n").length}
      // Context lines expand from the old side's text, so only once it is known.
      onExpandLines={oldText === null ? undefined : expandLines}
    />
  );
  const failed =
    oldSide.state === "failed"
      ? oldSide
      : newSide.state === "failed"
        ? newSide
        : null;
  if (failed === null) return renderer;
  // The diff still shows, plain; the failed text read says so above it.
  return (
    <Column
      fill
      header={
        <ResourceErrorInline
          variant="inline"
          error={failed.error}
          refetch={failed.refetch}
          subject="the file's text"
        />
      }
      body={renderer}
    />
  );
}

function SkipSeparator({
  count,
  onExpandTop,
  onExpandBottom,
  onExpandAll,
}: {
  count: number;
  onExpandTop: (n: number) => void;
  onExpandBottom: (n: number) => void;
  onExpandAll: () => void;
}) {
  const steps = [5, 10, 50].filter((n) => n < count);
  return (
    <div className="diff-skip-separator">
      <span className="diff-skip-actions">
        {[...steps].reverse().map((n) => (
          <button key={n} type="button" onClick={() => onExpandTop(n)}>
            ↓{n}
          </button>
        ))}
      </span>
      <button type="button" className="diff-skip-label" onClick={onExpandAll}>
        {count} {count === 1 ? "line" : "lines"}
      </button>
      <span className="diff-skip-actions">
        {steps.map((n) => (
          <button key={n} type="button" onClick={() => onExpandBottom(n)}>
            {n}↑
          </button>
        ))}
      </span>
    </div>
  );
}

function renderShikiToken(
  node: TokenNode,
  defaultRender: (node: TokenNode, i: number) => ReactNode,
  i: number,
): ReactNode {
  if (node.type !== "shiki") return defaultRender(node, i);
  const style: CSSProperties = {};
  if (typeof node.color === "string") style.color = node.color;
  const fontStyle = typeof node.fontStyle === "number" ? node.fontStyle : 0;
  if (fontStyle > 0) {
    if (fontStyle & 1) style.fontStyle = "italic";
    if (fontStyle & 2) style.fontWeight = "bold";
    if (fontStyle & 4) style.textDecoration = "underline";
  }
  return (
    <span key={i} style={style}>
      {typeof node.value === "string" ? node.value : null}
    </span>
  );
}
