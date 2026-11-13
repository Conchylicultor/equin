import { defineFoldCheck } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { themeBridgeFold } from "./theme-bridge-reads.scan";

/**
 * Enforces that a Tailwind `@theme inline` BRIDGE copy (`--color-input:
 * var(--input)`) is never read as a value outside `@theme` — read the runtime
 * var it copies (`var(--input)`) instead.
 *
 * Why: a bridge exists so Tailwind can generate the `bg-input` / `border-input`
 * utilities, which it INLINES as `var(--input)` — read on the element itself,
 * inside whatever theme scope it sits in. But the bridge custom property is
 * also emitted, on `:root`, where its `var(--input)` is substituted ONCE: the
 * value every element inherits is the desktop theme's. A utility or class that
 * reads the `--color-input` copy therefore ignores the scoped app theme around it
 * (`[data-theme-scope]`) and paints the desktop colour — silently, since the
 * value is a valid colour. The menu rows had exactly this bug; the input
 * focus border too.
 *
 * Scans plugin `.css` (comment-stripped, `@theme` interiors masked) and
 * `.ts` / `.tsx` (class strings: an arbitrary value or a custom-property class).
 * Only bridges that copy a runtime var are flagged — Tailwind's own static
 * palette (`--color-red-500`) is a literal, the same at every scope.
 */

// A fold check: each file's bridges and `var(--color-*)` reads are its record
// (./theme-bridge-reads.scan.ts), kept along the directory tree, so a pass
// after an edit reads only the edited files; the verdict matches reads to
// bridges across files.
const check = defineFoldCheck({
  id: "theme-bridge-reads",
  // INPUT-KEYED: the verdict is a function of the listed files' bytes (each
  // folded file's blob is recorded through the recording file set) and of
  // the listing under plugins/ — both replayed on the next run.
  inputKeyed: true,
  description:
    "No `var(--color-*)` read of an `@theme inline` bridge outside `@theme` — the bridge resolves at :root and ignores scoped app themes; read the runtime var it copies",
  context: () => null,
  files: (repo) =>
    repo
      .under("plugins")
      .filter(
        (p) => p.endsWith(".css") || p.endsWith(".ts") || p.endsWith(".tsx"),
      ),
  facts: () => null,
  fold: themeBridgeFold,
  verdict({ bridges, cssReads, codeReads }) {
    // Every bridge, `--color-<name>` → the runtime var it copies (a later
    // file's declaration wins, in path order).
    const runtimeOf = new Map(bridges);
    const offenders = [...cssReads, ...codeReads].flatMap((r) => {
      const runtime = runtimeOf.get(r.name);
      return runtime === undefined
        ? []
        : [`  ${r.rel}:${r.line} — var(${r.name}) → read var(${runtime})`];
    });
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `Read of a Tailwind @theme bridge copy outside @theme:\n${offenders.join("\n")}`,
      hint:
        "Read the runtime var the bridge copies (shown after →). A bridge custom " +
        "property is computed once at :root, so a `var(--color-*)` read paints the " +
        "desktop theme's value inside a scoped app theme ([data-theme-scope]).",
    };
  },
});

export default check;
