import { useEffect, useMemo, useState } from "react";
import type { HunkData } from "react-diff-view";
import type { BundledLanguage, ThemedToken } from "shiki";
import {
  getHighlighter,
  languageForPath,
  SHIKI_LANGS,
  themeForMode,
} from "@plugins/primitives/plugins/syntax-highlight/web";

export type ShikiTokenNode = {
  type: "shiki";
  value: string;
  color?: string;
  fontStyle?: number;
};

export type DiffTokens = {
  old: ShikiTokenNode[][];
  new: ShikiTokenNode[][];
};

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

export function buildSideTokenMap(
  hunks: HunkData[],
  side: "old" | "new",
  allLines: ShikiTokenNode[][],
): ShikiTokenNode[][] {
  const lineCount = allLines.length;
  const result: ShikiTokenNode[][] = [];

  let maxLine = 0;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      let lineNumber: number | undefined;
      if (change.type === "normal") {
        lineNumber = side === "old" ? change.oldLineNumber : change.newLineNumber;
      } else if (change.type === "delete" && side === "old") {
        lineNumber = change.lineNumber;
      } else if (change.type === "insert" && side === "new") {
        lineNumber = change.lineNumber;
      }
      if (lineNumber !== undefined && lineNumber > maxLine) maxLine = lineNumber;
    }
  }

  const lineMap = new Map<number, ShikiTokenNode[]>();
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      let lineNumber: number | undefined;
      if (change.type === "normal") {
        lineNumber = side === "old" ? change.oldLineNumber : change.newLineNumber;
      } else if (change.type === "delete" && side === "old") {
        lineNumber = change.lineNumber;
      } else if (change.type === "insert" && side === "new") {
        lineNumber = change.lineNumber;
      }
      if (lineNumber !== undefined) {
        const idx = lineNumber - 1;
        lineMap.set(lineNumber, idx < lineCount ? (allLines[idx] ?? []) : []);
      }
    }
  }

  for (let i = 1; i <= maxLine; i++) {
    result.push(lineMap.get(i) ?? []);
  }
  return result;
}

/**
 * The shiki language a diff of `path` is highlighted in, or `null` when shiki
 * has none for it (the diff then renders as plain text and needs no file text
 * for its tokens).
 */
export function diffLang(path: string): BundledLanguage | null {
  const lang = languageForPath(path);
  return SHIKI_LANGS.includes(lang) ? (lang as BundledLanguage) : null;
}

/**
 * Both sides of a diff as whole-file text: the old side (the base ref) and the
 * new side (the head ref, or the working tree). `null` is a side with no text
 * — the file is not there (an added or deleted file) or the server will not
 * read it as text (binary, too large) — so it gets no tokens.
 */
export interface DiffTexts {
  old: string | null;
  new: string | null;
}

interface HighlightInput {
  lang: BundledLanguage;
  theme: ReturnType<typeof themeForMode>;
  old: string | null;
  new: string | null;
}

/**
 * Syntax tokens for a diff's hunks, derived from both sides' text: each side is
 * tokenized whole (so a multi-line construct highlights right), once per text,
 * and the hunks pick their lines out of it — an expansion re-picks without
 * re-tokenizing. `null` while there is nothing to highlight yet: no hunks, no
 * language, `texts` not known yet (`null`), or the async highlighter not done
 * for these texts — tokens of other texts would paint their own words, so
 * none are reused.
 */
export function useDiffTokens(
  hunks: HunkData[] | null,
  lang: BundledLanguage | null,
  dark: boolean,
  texts: DiffTexts | null,
): DiffTokens | null {
  const theme = themeForMode(dark);
  const oldText = texts === null ? undefined : texts.old;
  const newText = texts === null ? undefined : texts.new;
  const input = useMemo<HighlightInput | null>(
    () =>
      lang === null || oldText === undefined || newText === undefined
        ? null
        : { lang, theme, old: oldText, new: newText },
    [lang, theme, oldText, newText],
  );

  const [highlighted, setHighlighted] = useState<{
    input: HighlightInput;
    old: ShikiTokenNode[][];
    new: ShikiTokenNode[][];
  } | null>(null);

  useEffect(() => {
    if (input === null) return;
    let cancelled = false;
    // A highlighter that fails to load rejects unhandled: reported, not hidden.
    void getHighlighter(input.lang).then((hl) => {
      if (cancelled) return;
      const tokenize = (content: string | null) =>
        content
          ? themedToTokens(
              hl.codeToTokensBase(content, {
                lang: input.lang,
                theme: input.theme,
              }),
            )
          : [];
      setHighlighted({
        input,
        old: tokenize(input.old),
        new: tokenize(input.new),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [input]);

  return useMemo(() => {
    if (!hunks || hunks.length === 0) return null;
    if (highlighted === null || highlighted.input !== input) return null;
    return {
      old: buildSideTokenMap(hunks, "old", highlighted.old),
      new: buildSideTokenMap(hunks, "new", highlighted.new),
    };
  }, [hunks, highlighted, input]);
}
