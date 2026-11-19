import { transformSync } from "@babel/core";
import reactCompiler from "babel-plugin-react-compiler";
import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";

// The per-file half of `react-compiler:no-silent-skips`, as a fold kept along
// the directory tree: each module compiled on its own bytes with the build's
// own compiler options (the fold context), so a pass after an edit compiles
// only the edited files. Its records are keyed by this module's closure, the
// compiler package included, so a compiler upgrade re-folds every file.

/** The build's compiler options, read off react-compiler's `vite/index.ts`. */
// A type alias, not an interface: the fold context must be plain JSON data.
export type SkipsContext = {
  readonly options: { readonly [key: string]: string };
};

/** One component or hook the compiler leaves uncompiled. */
export interface CompilerSkip {
  /** Repo-relative path. */
  path: string;
  /** Line of the function the compiler skipped. */
  line: number;
  /** Its name, as the source spells it on that line (`?` when none). */
  fn: string;
  /** The compiler's category (`Todo`, `Hooks`, `Refs`, …). */
  category: string;
  /** The compiler's own reason, first line. */
  reason: string;
}

// The build's prefilter (react-compiler's `vite/index.ts`, `appliesTo`): a
// `.ts` module naming no hook and not opting in holds nothing `infer` compiles.
const HOOK_TOKEN_RE = /\buse[A-Z0-9]/;
const USE_MEMO_RE = /["']use memo["']/;

const NAME_RE =
  /(?:function\s*\*?\s*([A-Za-z_$][\w$]*))|(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*))|(?:^\s*([A-Za-z_$][\w$]*)\s*[(:=])/;

function fnNameAt(lines: readonly string[], line: number): string {
  const m = NAME_RE.exec(lines[line - 1] ?? "");
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? "?";
}

interface LoggedError {
  kind: string;
  fnLoc?: { start?: { line?: number } } | null;
  data?: string;
  detail?: {
    category?: string;
    reason?: string;
    options?: { category?: string; reason?: string };
  };
}

export const compilerSkipsFold: FileFold<SkipsContext, CompilerSkip[]> = {
  url: import.meta.url,
  scan(src, rel, context) {
    const tsx = rel.endsWith(".tsx");
    if (!tsx && !HOOK_TOKEN_RE.test(src) && !USE_MEMO_RE.test(src)) return [];
    const errors: LoggedError[] = [];
    transformSync(src, {
      babelrc: false,
      configFile: false,
      filename: rel,
      code: false,
      ast: false,
      parserOpts: {
        sourceType: "module",
        allowAwaitOutsideFunction: true,
        plugins: tsx ? ["jsx", "typescript"] : ["typescript"],
      },
      plugins: [
        [
          reactCompiler,
          {
            ...context.options,
            // Never throw: the build's own threshold leaves a failing function
            // uncompiled; here every one is logged instead, the whole file kept.
            panicThreshold: "none",
            logger: {
              logEvent: (_file: string | null, e: LoggedError) => {
                if (e.kind === "CompileError" || e.kind === "PipelineError")
                  errors.push(e);
              },
            },
          },
        ],
      ],
    });
    const lines = src.split("\n");
    const byFn = new Map<number, CompilerSkip>();
    for (const e of errors) {
      const line = e.fnLoc?.start?.line ?? 0;
      if (byFn.has(line)) continue;
      const d = e.detail?.options ?? e.detail;
      byFn.set(line, {
        path: rel,
        line,
        fn: fnNameAt(lines, line),
        category: d?.category ?? e.kind,
        reason: (d?.reason ?? e.data ?? "").split("\n")[0]!.slice(0, 200),
      });
    }
    return [...byFn.values()].sort((a, b) => a.line - b.line);
  },
  combine: (parts) => parts.flat(),
};
