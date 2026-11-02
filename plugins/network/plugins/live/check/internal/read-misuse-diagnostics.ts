import * as path from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// ── live:read-misuse-diagnostics ───────────────────────────────────────────
// `useLive`'s collection read is one signature, so a wrong query is reported
// ON ITS PROPERTY (`limit` beside `{ id }`, an unknown `groupBy`), never as
// "No overload matches this call" (TS2769) against some other overload's
// argument 0. `use-live-query-types.test.ts` puts each misuse's
// `@ts-expect-error` directly above the offending property — but
// `@ts-expect-error` is satisfied by ANY diagnostic on its line, a 2769
// included. So each marker names the code(s) it expects, in one spelling:
//
//   // @ts-expect-error TS2322 — <label>
//   // @ts-expect-error TS2322 TS2353 — <label>   (several, space-separated)
//
// This check compiles that file with every `@ts-expect-error`
// blanked (in memory: the file on disk is untouched) under the repo's
// compiler options — in a subprocess
// (`scripts/compile-read-misuse-fixture.ts`), so its tens of seconds of checker
// work never hold the runner's shared thread —
// and asserts the diagnostics themselves:
//
//   - every marker names its code(s);
//   - the codes of the diagnostics on its next line are exactly the listed
//     ones — each listed code appears, no other code does. A TS2769 is only
//     ever a listed code (a recorded exception — two signatures that are
//     genuinely both candidates);
//   - no diagnostic lands on any other line of the file.

/** The type test whose markers this check reads. */
export const READ_MISUSE_FIXTURE =
  "plugins/network/plugins/live/web/__tests__/use-live-query-types.test.ts";

const MARKER = /\/\/ @ts-expect-error(.*)$/;

/** A marker's text after `@ts-expect-error`: ` TS<code>[ TS<code>…] — <label>`. */
const CODED = /^ (TS\d+(?: TS\d+)*) — (.+)$/;

/** A marker: the 0-based line it guards (the one after it), the TS codes it expects (empty: it names none — a violation) and its label. */
export interface MisuseMarker {
  line: number;
  codes: number[];
  label: string;
}

/** The file's markers, and its text with each `@ts-expect-error` blanked (line structure kept). */
export function stripMarkers(text: string): {
  markers: MisuseMarker[];
  stripped: string;
} {
  const lines = text.split("\n");
  const markers: MisuseMarker[] = [];
  const out = lines.map((l, i) => {
    const m = MARKER.exec(l);
    if (m === null) return l;
    const coded = CODED.exec(m[1]!);
    markers.push(
      coded === null
        ? { line: i + 1, codes: [], label: m[1]!.trim() }
        : {
            line: i + 1,
            codes: coded[1]!.split(" ").map((c) => Number(c.slice(2))),
            label: coded[2]!.trim(),
          },
    );
    return l.replace(MARKER, "// (marker)");
  });
  return { markers, stripped: out.join("\n") };
}

/** One diagnostic on the fixture, by 0-based line. */
export interface LineDiagnostic {
  line: number;
  code: number;
  message: string;
}

/** Every way the diagnostics break the markers' contract, as `line — what` (1-based lines). */
export function markerViolations(
  markers: readonly MisuseMarker[],
  diagnostics: readonly LineDiagnostic[],
): string[] {
  const byLine = new Map<number, LineDiagnostic[]>();
  for (const d of diagnostics) {
    byLine.set(d.line, [...(byLine.get(d.line) ?? []), d]);
  }
  const marked = new Set(markers.map((m) => m.line));
  const out: string[] = [];
  for (const { line, codes, label } of markers) {
    // The marker sits on the line above the one it guards.
    if (codes.length === 0) {
      out.push(
        `${line} — the marker names no TS code; spell it \`// @ts-expect-error TS<code> — <label>\` (${label})`,
      );
      continue;
    }
    const ds = byLine.get(line) ?? [];
    if (ds.length === 0) {
      out.push(`${line + 1} — no diagnostic under the marker (${label})`);
      continue;
    }
    for (const code of codes) {
      if (!ds.some((d) => d.code === code)) {
        out.push(
          `${line + 1} — the marker expects TS${code}, but the line reports ${[...new Set(ds.map((d) => `TS${d.code}`))].join(", ")} (${label})`,
        );
      }
    }
    const unlisted = new Map<number, LineDiagnostic>();
    for (const d of ds) {
      if (!codes.includes(d.code) && !unlisted.has(d.code)) {
        unlisted.set(d.code, d);
      }
    }
    for (const d of unlisted.values()) {
      out.push(
        d.code === 2769
          ? `${line + 1} — TS2769 "No overload matches this call", not an error on the property (${label}): ${d.message}`
          : `${line + 1} — TS${d.code}, which the marker does not list (${label}): ${d.message}`,
      );
    }
  }
  for (const [line, ds] of [...byLine].sort((a, b) => a[0] - b[0])) {
    if (marked.has(line)) continue;
    for (const d of ds) {
      out.push(
        `${line + 1} — TS${d.code} with no marker above it: ${d.message}`,
      );
    }
  }
  return out;
}

/** The probe that compiles the fixture, by path (spawned, never imported). */
const PROBE = path.join(
  import.meta.dir,
  "../../scripts/compile-read-misuse-fixture.ts",
);

/** Compile the fixture (markers blanked) under the repo's tsconfig, in a subprocess, and return its own diagnostics. */
async function fixtureDiagnostics(
  root: string,
  stripped: string,
): Promise<
  { ok: true; diagnostics: LineDiagnostic[] } | { ok: false; message: string }
> {
  const run = await spawnCaptured(
    [process.execPath, PROBE, root, path.join(root, READ_MISUSE_FIXTURE)],
    {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      stdin: stripped,
      // ~40 s of checker work on an idle host; ten minutes only bounds a
      // compile that never returns, under a loaded background check pass.
      timeoutMs: 600_000,
    },
  );
  if (run.exitCode !== 0) {
    return {
      ok: false,
      message: `the compile probe exited ${run.exitCode}:\n${run.stderr.slice(-4000)}`,
    };
  }
  return { ok: true, diagnostics: JSON.parse(run.stdout) as LineDiagnostic[] };
}

export const readMisuseDiagnostics: Check = {
  id: "live:read-misuse-diagnostics",
  description:
    "Every misuse in network/live's `use-live-query-types.test.ts` is reported on the line its `@ts-expect-error` marks with exactly the TS code(s) the marker names (`// @ts-expect-error TS2322 — <label>`) — so never as TS2769 (\"No overload matches this call\", which `@ts-expect-error` cannot tell apart) unless the marker lists it — with no unmarked diagnostic. Compiles the file, markers blanked in memory, under the repo's compiler options.",
  async run(ctx) {
    const repo = await ctx.repo();
    const text = await repo.read(READ_MISUSE_FIXTURE);
    if (text === null) {
      return { ok: false, message: `${READ_MISUSE_FIXTURE} is missing` };
    }
    const { markers, stripped } = stripMarkers(text);
    if (markers.length === 0) {
      return {
        ok: false,
        message: `${READ_MISUSE_FIXTURE} has no \`@ts-expect-error\` marker — nothing is pinned`,
      };
    }
    const started = performance.now();
    const compiled = await ctx.grant.run(() =>
      fixtureDiagnostics(repo.root, stripped),
    );
    if (!compiled.ok) return { ok: false, message: compiled.message };
    ctx.log?.(
      `live:read-misuse-diagnostics: ${markers.length} markers, ${compiled.diagnostics.length} diagnostics, compiled in ${Math.round(performance.now() - started)} ms`,
      "stdout",
    );
    const violations = markerViolations(markers, compiled.diagnostics);
    if (violations.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${READ_MISUSE_FIXTURE}: ${violations.length} marker(s) broken:\n    ${violations.join("\n    ")}`,
      hint: "A misuse of `useLive`'s collection read must error on its own property: one collection signature is the only argument-bucket candidate, so tsc elaborates into the query. A TS2769 means another signature became a candidate (a value overload whose rest does not route a collection to the arity bucket, a second collection overload) — fix the signatures in plugins/network/plugins/live/web/internal/use-live.ts, not the marker. A marker may list TS2769 only where two signatures are genuinely both candidates. When a misuse's code legitimately changed, update the code its marker lists.",
    };
  },
};
