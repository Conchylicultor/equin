import { defineFoldCheck } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { maskSyncFold } from "./mask-sync.scan";

const SOURCE_RE = /\.(?:[cm]?ts|tsx)$/;

// A fold check (`defineFoldCheck`): each .ts / .tsx file is masked, parsed and
// compared in ./mask-sync.scan.ts, kept along the directory tree, so a pass
// after an edit reads only the edited files; a cold store reads each once.
const check = defineFoldCheck({
  id: "parse-utils:mask-sync",
  // INPUT-KEYED: the verdict is a function of every .ts / .tsx file's bytes
  // (each folded file's blob is recorded through the recording file set, the
  // masker's own modules among them) and of the file listing — both replayed
  // on the next run. The fold's records are keyed by the scan module's
  // closure, so an edit to maskSource re-folds every file.
  inputKeyed: true,
  description:
    "maskSource stays in sync with TypeScript's parse on every .ts / .tsx file: every identifier outside a template is left as code, and every string, template, JSX text and regex literal is blanked. A file the masker misreads gives every masked scanner (grepCode checks, findImports, marker scans, lint rules) a wrong answer for the rest of the file, silently — this check is what notices.",
  exemptable: {
    "parse-utils:mask-sync":
      "is a file maskSource cannot read in sync with TypeScript's parse",
  },
  context: () => null,
  files: (repo) =>
    repo.all().filter((p) => SOURCE_RE.test(p) && !p.endsWith(".d.ts")),
  facts: () => null,
  fold: maskSyncFold,
  async verdict(folded, _inputs, ctx) {
    const exempt = await ctx.exempt("parse-utils:mask-sync");
    const failures = folded
      .filter((d) => !exempt.skips(d.rel))
      .map(
        (d) =>
          `  ${d.rel}:${d.line}:${d.column}  ${d.kind === "code-masked" ? "code read as a literal" : "literal read as code"}: ${JSON.stringify(d.text)}`,
      );
    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      message: `maskSource loses sync with TypeScript's parse in ${failures.length} file(s) — from the position shown, every masked scanner reads the file wrong:\n${failures.join("\n")}`,
      hint: "The divergence is usually where the masker misread a construct, or shortly after it. Teach maskSource the construct (plugins/plugin-meta/plugins/parse-utils/core/mask-source.ts) with a test in mask-source.test.ts. Rewriting the source around it hides the class, not the bug; exempt a file (parse-utils:mask-sync, in its plugin's exempt/index.ts) only when no lexer heuristic can tell the construct apart.",
    };
  },
});

export default check;
