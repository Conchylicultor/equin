import { useEffect, useMemo, useState } from "react";
import { structuredPatch } from "diff";
import type { FileData, HunkData } from "react-diff-view";
import type { BundledLanguage, ThemedToken } from "shiki";
import {
  getHighlighter,
  languageForPath,
  SHIKI_LANGS,
  themeForMode,
  useDarkMode,
} from "@plugins/primitives/plugins/syntax-highlight/web";
import { DiffRenderer } from "./diff-view";
import { buildSideTokenMap } from "../use-diff-tokens";
import type { DiffTokens, ShikiTokenNode } from "../use-diff-tokens";

// --- types matching react-diff-view internals ---
type NormalChange = { type: "normal"; isNormal: true; oldLineNumber: number; newLineNumber: number; content: string };
type InsertChange = { type: "insert"; isInsert: true; lineNumber: number; content: string };
type DeleteChange = { type: "delete"; isDelete: true; lineNumber: number; content: string };
type Change = NormalChange | InsertChange | DeleteChange;

function buildHunks(oldText: string, newText: string): { files: FileData[]; hunks: HunkData[] | null } {
  if (oldText === newText) return { files: [], hunks: null };

  const sp = structuredPatch("old", "new", oldText, newText, "", "", { context: 3 });

  const hunks: HunkData[] = sp.hunks.map((h) => {
    const changes: Change[] = [];
    let oldLine = h.oldStart;
    let newLine = h.newStart;

    for (const line of h.lines) {
      if (line.startsWith("\\ ")) continue; // "No newline at end of file" marker
      const prefix = line[0];
      if (prefix === " ") {
        changes.push({ type: "normal", isNormal: true, oldLineNumber: oldLine++, newLineNumber: newLine++, content: line });
      } else if (prefix === "-") {
        changes.push({ type: "delete", isDelete: true, lineNumber: oldLine++, content: line });
      } else if (prefix === "+") {
        changes.push({ type: "insert", isInsert: true, lineNumber: newLine++, content: line });
      }
    }

    return {
      content: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      changes,
    };
  }) as HunkData[];

  if (hunks.length === 0) return { files: [], hunks: null };

  const fileType = oldText === "" ? "add" : newText === "" ? "delete" : "modify";
  const files: FileData[] = [{
    type: fileType,
    hunks,
    oldRevision: "old",
    newRevision: "new",
    oldPath: "old",
    newPath: "new",
    isBinary: false,
  } as unknown as FileData];

  return { files, hunks };
}

function themedToTokens(lines: ThemedToken[][]): ShikiTokenNode[][] {
  return lines.map((line) =>
    line.map((tok) => ({
      type: "shiki" as const,
      value: tok.content,
      color: tok.color,
      fontStyle: tok.fontStyle,
    })),
  );
}

function useTextDiffData(oldText: string, newText: string, path: string) {
  const dark = useDarkMode();

  const { files, hunks } = useMemo(
    () => buildHunks(oldText, newText),
    [oldText, newText],
  );

  const [tokens, setTokens] = useState<DiffTokens | null>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- async Shiki tokenization with cancel guard: tokenizing two in-memory strings requires loading getHighlighter() (async) so the result cannot be derived synchronously in render; no server read is involved so a live read (useLive) does not apply; the cancel flag drops stale results, matching useDiffTokens */
    if (!hunks || hunks.length === 0) {
      setTokens(null);
      return;
    }
    const rawLang = languageForPath(path);
    if (!SHIKI_LANGS.includes(rawLang)) {
      setTokens(null);
      return;
    }
    const lang = rawLang as BundledLanguage;
    const theme = themeForMode(dark);
    let cancelled = false;

    getHighlighter(lang).then((hl) => {
      if (cancelled) return;
      const highlight = (text: string) =>
        themedToTokens(hl.codeToTokensBase(text, { lang, theme }));
      setTokens({
        old: buildSideTokenMap(hunks, "old", highlight(oldText)),
        new: buildSideTokenMap(hunks, "new", highlight(newText)),
      });
    }).catch(() => {
      if (!cancelled) setTokens(null);
    });

    return () => { cancelled = true; };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [hunks, oldText, newText, path, dark]);

  return { files, hunks, tokens };
}

/**
 * Side-by-side diff of two in-memory strings (no git / worktree dependency).
 * `path` drives syntax highlighting via the shiki language map. Returns null
 * when the two strings are identical.
 */
export function TextDiff({
  oldText,
  newText,
  path,
}: {
  oldText: string;
  newText: string;
  path: string;
}) {
  const { files, hunks, tokens } = useTextDiffData(oldText, newText, path);

  if (!hunks || files.length === 0) return null;

  return <DiffRenderer files={files} hunks={hunks} tokens={tokens} />;
}
