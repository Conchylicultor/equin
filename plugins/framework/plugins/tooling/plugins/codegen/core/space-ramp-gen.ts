import { readFileSync } from "fs";
import { join } from "path";
import { writeGenerated } from "./write-generated";
import { appCssPath, collectUtilityDecls } from "./app-css-utilities";

/**
 * Generates `ramp.generated.ts` — the spacing ramp's step set and every
 * step-keyed utility family's literal class table — from the `/* @ramp … *\/`
 * declarations in app.css.
 *
 * app.css is the SINGLE SOURCE OF TRUTH for the ramp, because it is where the
 * 112 `@utility` classes actually exist. The ramp used to be re-declared in
 * TypeScript instead: `SpaceStep` in `primitives/css/spacing/web` and `RailStep`
 * in `primitives/css/rail/core` were two independent unions of the same 8 steps
 * (the second existed only because `core` may not import `web`), and fifteen
 * `Record<Step, string>` tables across six files spelled the class names out by
 * hand, with two more copies of the step→CSS-length resolver. Nothing
 * kept any of them in sync, and the drift was silent — a step present in one
 * union and absent from another produced a missing utility, not a type error.
 *
 * Generating from app.css inverts that: the union IS the stylesheet, so a step
 * with no `@utility` behind it becomes unspellable rather than silently unstyled.
 *
 * THE LITERAL TABLES ARE STILL THE POINT. Tailwind emits an `@utility` only when
 * its source scanner finds the literal token, so `` `rail-x-${step}` `` at a call
 * site compiles to nothing. Generating the literals into a scanned `core/` module
 * keeps the scanner satisfied while removing the copies.
 *
 * Mirrors the `custom-utilities-gen` trio: `renderSpaceRamp` (in-memory),
 * `generateSpaceRamp` (write-on-diff), `spaceRampManifestPath`. Both generators
 * read app.css through the shared `app-css-utilities` scan, and both read it by
 * PATH via fs — a generator must not statically import the ui-kit plugin.
 *
 * ## The declarations
 *
 * ```css
 * /* @ramp steps: none 2xs xs sm md lg xl 2xl *\/
 * /* @ramp families: gap gap-x gap-y p px py pt pr pb pl *\/
 * /* @ramp families: rail rail-x rail-y rail-owe *\/
 * ```
 *
 * Exactly one `steps:` decl; one or more `families:` decls (unioned in file
 * order), so each section of app.css declares its own families next to them.
 *
 * Families are DECLARED, never inferred from suffixes. `control-xs/sm/md/lg`,
 * `control-icon-*` and `control-min-*` share four suffixes with the ramp but are
 * a different 4-step scale — suffix discovery would read them as ramp families
 * missing half their steps.
 */

const MANIFEST_REL_PATH =
  "plugins/primitives/plugins/css/plugins/space-ramp/core/ramp.generated.ts";

const MANIFEST_HEADER = [
  "// AUTO-GENERATED from app.css `/* @ramp … */` declarations. Do not edit.",
  "// Run `./equin build` to regenerate.",
  "// (see plugins/framework/plugins/tooling/plugins/codegen/core/space-ramp-gen.ts).",
  "//",
  "// The spacing ramp: its closed step set, and the literal class name each",
  "// step-keyed `@utility` family gives each step — derived from app.css, the",
  "// single source of truth for which of those classes exist.",
  "//",
  "// The `space-ramp-in-sync` check fails on drift.",
].join("\n");

/** The parsed ramp: the ordered step set, and the ordered family set. */
export interface RampDecl {
  steps: string[];
  families: string[];
}

/** Every `/* @ramp <keyword>: <words…> *\/` decl, in file order. */
function collectRampDecls(
  css: string,
): Array<{ keyword: string; words: string[] }> {
  return [...css.matchAll(/@ramp\s+(\w+)\s*:([^*]*)/g)].map((m) => ({
    keyword: m[1]!,
    words: m[2]!.trim().split(/\s+/).filter(Boolean),
  }));
}

/**
 * Read the `@ramp` declarations out of app.css.
 *
 * Throws (reported as a check failure, never a crash) on a missing, duplicated
 * or empty declaration, and on a token that could not be part of a class name.
 */
export function parseRampDecl(css: string): RampDecl {
  const decls = collectRampDecls(css);

  for (const { keyword } of decls) {
    if (keyword !== "steps" && keyword !== "families") {
      throw new Error(
        `app.css @ramp ${keyword}: unrecognized declaration. Expected ` +
          `"/* @ramp steps: <step…> */" or "/* @ramp families: <family…> */".`,
      );
    }
  }

  const stepDecls = decls.filter((d) => d.keyword === "steps");
  if (stepDecls.length === 0) {
    throw new Error(
      `app.css: no "/* @ramp steps: <step…> */" declaration found. It names the ` +
        `closed spacing ramp, and every declared family must carry all of its steps.`,
    );
  }
  if (stepDecls.length > 1) {
    throw new Error(
      `app.css: ${stepDecls.length} "/* @ramp steps: … */" declarations found; the ramp ` +
        `is one closed set, so there must be exactly one. Declare additional utility ` +
        `families with "/* @ramp families: … */" instead.`,
    );
  }

  const steps = stepDecls[0]!.words;
  if (steps.length === 0) {
    throw new Error(`app.css @ramp steps: needs at least one step.`);
  }

  const familyDecls = decls.filter((d) => d.keyword === "families");
  if (familyDecls.length === 0) {
    throw new Error(
      `app.css: no "/* @ramp families: <family…> */" declaration found. Each section ` +
        `declaring step-keyed utilities names its own families next to them.`,
    );
  }

  // Union in file order. Families are per-section, so a duplicate is a copy-paste
  // slip rather than a meaningful re-declaration.
  const families: string[] = [];
  for (const decl of familyDecls) {
    if (decl.words.length === 0) {
      throw new Error(
        `app.css @ramp families: needs at least one family (an empty declaration ` +
          `states nothing — delete it instead).`,
      );
    }
    for (const family of decl.words) {
      if (families.includes(family)) {
        throw new Error(
          `app.css @ramp families: "${family}" is declared twice.`,
        );
      }
      families.push(family);
    }
  }

  for (const token of [...steps, ...families]) {
    if (!/^[\w-]+$/.test(token)) {
      throw new Error(
        `app.css @ramp: "${token}" cannot be part of a utility class name.`,
      );
    }
  }

  return { steps, families };
}

/**
 * The ramp, checked against the `@utility` declarations that must back it.
 *
 * This is the load-bearing validation: every declared family must carry EVERY
 * declared step. It is what makes "add a step to the TypeScript union without
 * adding the CSS" impossible, and what catches a rename that lands in some
 * families but not others.
 *
 * The reverse direction is deliberately NOT an error — `p-chip`, `p-row`
 * and `p-card` are legitimate non-ramp members of the `p` prefix.
 */
export function parseSpaceRamp(css: string): RampDecl {
  const ramp = parseRampDecl(css);
  const declared = new Set(collectUtilityDecls(css).map((d) => d.name));

  const missing: string[] = [];
  for (const family of ramp.families) {
    for (const step of ramp.steps) {
      const cls = `${family}-${step}`;
      if (!declared.has(cls)) missing.push(cls);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `app.css: ${missing.length} ramp @utility declaration(s) missing — every family ` +
        `named in "/* @ramp families: … */" must carry every step named in ` +
        `"/* @ramp steps: … */":\n    ${missing.join("\n    ")}`,
    );
  }

  return ramp;
}

function renderManifest(ramp: RampDecl): string {
  const lines: string[] = [];
  lines.push(MANIFEST_HEADER);
  lines.push("");
  lines.push("export const SPACE_STEPS = [");
  for (const step of ramp.steps) lines.push(`  ${JSON.stringify(step)},`);
  lines.push("] as const;");
  lines.push("");
  lines.push(
    "/** Each step-keyed `@utility` family, and the literal class it gives each step. */",
  );
  lines.push("export const RAMP_CLASSES = {");
  for (const family of ramp.families) {
    const entries = ramp.steps
      .map((s) => `${JSON.stringify(s)}: ${JSON.stringify(`${family}-${s}`)}`)
      .join(", ");
    lines.push(`  ${JSON.stringify(family)}: { ${entries} },`);
  }
  lines.push("} as const;");
  lines.push("");
  return lines.join("\n");
}

/** Path to the committed generated manifest file. */
export function spaceRampManifestPath(root: string): string {
  return join(root, MANIFEST_REL_PATH);
}

/** Render the manifest file contents in-memory (used by the in-sync check). */
export function renderSpaceRamp(root: string): string {
  const css = readFileSync(appCssPath(root), "utf8");
  return renderManifest(parseSpaceRamp(css));
}

/** Regenerate `ramp.generated.ts` if it drifted. */
export async function generateSpaceRamp(opts: { root: string }): Promise<void> {
  await writeGenerated({
    file: spaceRampManifestPath(opts.root),
    content: renderSpaceRamp(opts.root),
  });
}
