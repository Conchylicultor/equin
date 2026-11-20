import { useEffect, useState, type ReactNode } from "react";
import type { BundledLanguage, BundledTheme, HighlighterGeneric } from "shiki";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import {
  CODE_GUTTER_CELL,
  CODE_TEXT,
  CodePaneSurface,
  getHighlighter,
  languageForPath,
  SHIKI_LANGS,
  themeForMode,
  useDarkMode,
} from "@plugins/primitives/plugins/syntax-highlight/web";
import { OverlayTextarea } from "./overlay-textarea";

type Highlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

/**
 * Past this many characters the text is drawn uncoloured: the underlay is
 * re-tokenized on every keystroke, and a file this long would make typing lag
 * behind the keys. The listing (read-only) still colours it whole.
 */
const HIGHLIGHT_MAX_CHARS = 200_000;

/** The language a file's path names, when shiki has it (else plain text). */
function langOf(path: string): string | null {
  const lang = languageForPath(path);
  return SHIKI_LANGS.includes(lang) ? lang : null;
}

/** The highlighter with `lang` loaded, once it is (`null` until then, or for plain text). */
function useHighlighter(lang: string | null): Highlighter | null {
  const [loaded, setLoaded] = useState<{
    lang: string;
    hl: Highlighter;
  } | null>(null);
  useEffect(() => {
    if (lang === null) return;
    let live = true;
    void getHighlighter(lang).then((hl) => {
      if (live) setLoaded({ lang, hl });
    });
    return () => {
      live = false;
    };
  }, [lang]);
  return loaded !== null && loaded.lang === lang ? loaded.hl : null;
}

export interface CodeTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** The file the text is: its extension picks the language. */
  path: string;
  ariaLabel: string;
  /** Take the focus when it mounts. */
  autoFocus?: boolean;
}

/** The editor's text where the listing draws its code: unwrapped, beside the gutter. */
const EDITOR_METRICS = cn(CODE_TEXT, "whitespace-pre");

/**
 * A file's text, editable, laid out as its pane listing (`CodeListing`
 * variant `pane`) reads: the same surface, inset, gutter of line numbers and
 * text metrics, unwrapped — so switching between reading and editing moves
 * no character. An {@link OverlayTextarea} whose underlay is the text
 * tokenized by shiki in the scheme's theme (colour and italics only — never a
 * weight, which would move the caret). Plain until the highlighter and the
 * language have loaded, and for a language shiki does not know. Fills its
 * host's height, scrolling both ways.
 */
export function CodeTextarea({
  value,
  onChange,
  path,
  ariaLabel,
  autoFocus,
}: CodeTextareaProps): ReactNode {
  const dark = useDarkMode();
  const lang = langOf(path);
  const hl = useHighlighter(lang);
  const theme = themeForMode(dark);
  const decorate = (text: string): ReactNode => {
    if (hl === null || lang === null || text.length > HIGHLIGHT_MAX_CHARS) {
      return text;
    }
    const lines = hl.codeToTokensBase(text, {
      lang: lang as BundledLanguage,
      theme,
    });
    return lines.map((tokens, i) => (
      <span key={i}>
        {tokens.map((t, j) => (
          <span
            key={j}
            style={{
              color: t.color,
              fontStyle:
                t.fontStyle !== undefined && (t.fontStyle & 1) !== 0
                  ? "italic"
                  : undefined,
            }}
          >
            {t.content}
          </span>
        ))}
        {i < lines.length - 1 ? "\n" : null}
      </span>
    ));
  };
  // One number per line, as the textarea counts them (a trailing newline
  // opens a line of its own).
  const lineCount = value.split("\n").length;
  return (
    <CodePaneSurface>
      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- the listing's code box (inset, as wide as its longest line) holding the gutter beside the text, both top-aligned so their lines pair up
        className="flex min-h-full w-max min-w-full items-start p-md"
      >
        <pre aria-hidden className={cn(CODE_TEXT, rigidClass())}>
          {Array.from({ length: lineCount }, (_, i) => (
            <span key={i}>
              {i > 0 ? "\n" : null}
              <span className={CODE_GUTTER_CELL}>{i + 1}</span>
            </span>
          ))}
        </pre>
        <OverlayTextarea
          value={value}
          onChange={onChange}
          decorate={decorate}
          ariaLabel={ariaLabel}
          autoFocus={autoFocus}
          metrics={EDITOR_METRICS}
          className={fillClasses("x")}
        />
      </div>
    </CodePaneSurface>
  );
}
