import { useEffect, useState, type ReactNode } from "react";
import type { BundledLanguage, BundledTheme, HighlighterGeneric } from "shiki";
import {
  codeBackground,
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
  /** Box chrome beyond the code surface (a min height, a radius) — never metrics. */
  className?: string;
  /** Take the focus when it mounts. */
  autoFocus?: boolean;
}

/**
 * A file's text, editable, in the colours its listing reads in: an
 * {@link OverlayTextarea} whose underlay is the text tokenized by shiki in the
 * scheme's theme (colour and italics only — never a weight, which would move
 * the caret), on that theme's background. Plain until the highlighter and the
 * language have loaded, and for a language shiki does not know.
 */
export function CodeTextarea({
  value,
  onChange,
  path,
  ariaLabel,
  className,
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
  return (
    <div
      // The code's own surface, as the listing paints it.
      style={{ background: codeBackground(dark) }}
      className={className}
    >
      <OverlayTextarea
        value={value}
        onChange={onChange}
        decorate={decorate}
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
      />
    </div>
  );
}
