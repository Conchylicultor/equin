// Bare file paths are literal text.
//
// CommonMark reads `_`/`~` runs inside a bare path as emphasis or strikethrough:
// `/srv/__A__/dev/x.md` renders "A" bold and splits the path into three
// nodes, and `plugins/foo/__init__.py` bolds "init". The words still read, but
// the path is no longer one string, so nothing downstream (the file-link chip)
// can recognise it.
//
// This micromark text construct claims a path run at the tokenizer — starting
// at a `/` (absolute, or a relative path's separator: the segment before it is
// already plain data) or a `~/` — as plain `data`, so the `_` / `~` inside it
// never become delimiters. A trailing `_` run is left out, so `_/a/b_` (an
// italic path) still closes its emphasis. `*` is not a path character, so
// `**/a/b**` is unaffected.
// Its types declare the processor data the micromark extensions ride on.
import type {} from "remark-parse";
import type { RemarkPlugins } from "./enhancement-context";

type RemarkProcessor = ThisParameterType<
  Extract<RemarkPlugins[number], (...args: never[]) => unknown>
>;
// `data()` is overloaded; read the no-argument form through a function.
function micromarkExtensionsOf(processor: RemarkProcessor) {
  return processor.data().micromarkExtensions;
}
type MicromarkExtension = NonNullable<
  ReturnType<typeof micromarkExtensionsOf>
>[number];
type Construct = Exclude<
  NonNullable<MicromarkExtension["text"]>[string],
  undefined | readonly unknown[]
>;
type Tokenizer = Construct["tokenize"];
type Effects = Parameters<Tokenizer>[0];
type State = ReturnType<Tokenizer>;
type Code = Parameters<State>[0];

const SLASH = 47; // /
const TILDE = 126; // ~
const UNDERSCORE = 95; // _
const PATH_PUNCTUATION = new Set([
  45, // -
  46, // .
  SLASH,
  TILDE,
  UNDERSCORE,
  64, // @
  43, // +
  37, // %
]);

function isPathChar(code: Code): boolean {
  if (code === null || code < 0) return false; // EOF, line endings, tabs
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code > 127 || // non-ASCII letters
    PATH_PUNCTUATION.has(code)
  );
}

// Lookahead: a `_` run that the path goes on after (any path char but `_`).
const underscoresInsidePath: Construct = {
  partial: true,
  tokenize(effects: Effects, ok: State, nok: State) {
    return function underscores(code: Code): State | undefined {
      if (code === UNDERSCORE) {
        effects.consume(code);
        return underscores;
      }
      return isPathChar(code) ? ok(code) : nok(code);
    };
  },
};

const literalPath: Construct = {
  name: "literalPath",
  tokenize(effects: Effects, ok: State, nok: State) {
    let size = 0;
    return start;

    function start(code: Code): State | undefined {
      effects.enter("data");
      effects.consume(code);
      return code === TILDE ? tildeSlash : inside;
    }

    function tildeSlash(code: Code): State | undefined {
      if (code !== SLASH) return nok(code);
      effects.consume(code);
      return inside;
    }

    function inside(code: Code): State | undefined {
      if (code === UNDERSCORE) {
        return effects.check(underscoresInsidePath, underscores, done)(code);
      }
      if (!isPathChar(code)) return done(code);
      size++;
      effects.consume(code);
      return inside;
    }

    function underscores(code: Code): State | undefined {
      if (code !== UNDERSCORE) return inside(code);
      size++;
      effects.consume(code);
      return underscores;
    }

    function done(code: Code): State | undefined {
      // A lone `/` or `~/` is not a path: leave it to the other constructs.
      if (size === 0) return nok(code);
      effects.exit("data");
      return ok(code);
    }
  },
};

export function remarkLiteralPaths(this: RemarkProcessor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({
    text: { [SLASH]: literalPath, [TILDE]: literalPath },
  });
}
