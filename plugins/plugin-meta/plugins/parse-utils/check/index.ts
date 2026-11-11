import type TS from "typescript";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  maskedSource,
  parsedTsSource,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { maskDivergence } from "./mask-sync";

// `typescript`'s module object is invariant for the process's lifetime, so a
// per-process memo is safe. Loaded lazily, so the check runner's "load every
// check" burst does not pay its eval cost.
let tsPromise: Promise<typeof TS> | undefined;
function loadTypescript(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

const SOURCE_RE = /\.(?:[cm]?ts|tsx)$/;

const check: Check = {
  id: "parse-utils:mask-sync",
  // Keyed on the whole tree, never input-keyed: the verdict is a function of
  // the masker's own code as much as of the files it reads, and a read-set
  // records only the latter — a PASS would survive an edit to maskSource.
  description:
    "maskSource stays in sync with TypeScript's parse on every .ts / .tsx file: every identifier outside a template is left as code, and every string, template, JSX text and regex literal is blanked. A file the masker misreads gives every masked scanner (grepCode checks, findImports, marker scans, lint rules) a wrong answer for the rest of the file, silently — this check is what notices.",
  exemptable: {
    "parse-utils:mask-sync":
      "is a file maskSource cannot read in sync with TypeScript's parse",
  },
  async run(ctx) {
    const ts = await loadTypescript();
    const repo = await ctx.repo();
    const paths = repo
      .all()
      .filter((p) => SOURCE_RE.test(p) && !p.endsWith(".d.ts"));

    const failures: string[] = [];
    for (const rel of paths) {
      const src = await repo.read(rel);
      if (src === null) continue; // vanished since the listing
      const source = { rel, src };
      const masked = await maskedSource(source);
      const sf = await parsedTsSource(ts, source);
      const d = maskDivergence(ts, sf, src, masked);
      if (d && !(await ctx.exempt("parse-utils:mask-sync")).skips(rel)) {
        failures.push(
          `  ${rel}:${d.line}:${d.column}  ${d.kind === "code-masked" ? "code read as a literal" : "literal read as code"}: ${JSON.stringify(d.text)}`,
        );
      }
    }

    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      message: `maskSource loses sync with TypeScript's parse in ${failures.length} file(s) — from the position shown, every masked scanner reads the file wrong:\n${failures.join("\n")}`,
      hint: "The divergence is usually where the masker misread a construct, or shortly after it. Teach maskSource the construct (plugins/plugin-meta/plugins/parse-utils/core/mask-source.ts) with a test in mask-source.test.ts. Rewriting the source around it hides the class, not the bug; exempt a file (parse-utils:mask-sync, in its plugin's exempt/index.ts) only when no lexer heuristic can tell the construct apart.",
    };
  },
};

export default check;
