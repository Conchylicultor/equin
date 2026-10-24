import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { REVIEW_MARKER, hasReviewMarker } from "../core";

// A descriptor that sets `requiresAuthoredOverride` has its committed override
// SEEDED by `./equin build` — written from the origin (real hash, full
// body) when missing, and re-marked + re-stamped when the origin hash shifts
// under it. Both events insert the one-line `// @review` marker, so presence of
// the file is no longer the thing to test: REVIEW is. This check is therefore a
// dumb marker scan — it computes no deltas, imports no manifest, and knows no
// config family (the guidance it echoes is the file's own).

const CONFIG_DIR = "config";

// Sibling artifacts that are never hand-authored and never seeded: `.origin` is
// codegen output, `.ancestor` is a propagate() merge-base snapshot. A marker can
// only ever reach the override itself, but skip them explicitly so a marker-like
// line copied into one can't manufacture an obligation that has no owner.
const GENERATED_SUFFIXES = [".origin.jsonc", ".ancestor.jsonc"];

function collectOverrideFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectOverrideFiles(path, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonc")) continue;
    if (GENERATED_SUFFIXES.some((s) => entry.name.endsWith(s))) continue;
    out.push(path);
  }
}

/**
 * The marker block a seeder wrote: the `// @review` line plus the contiguous
 * comment lines beneath it, which are the DESCRIPTOR's own guidance prose.
 *
 * Echoing the block verbatim is what keeps this check family-agnostic — the
 * instructions for arranging a reorder slot's `items` or a DataView's `views`
 * come from the file, so a third family that opts into `requiresAuthoredOverride`
 * gets a self-describing failure with zero edits here.
 *
 * Empty when the file carries no marker, so "is this file unreviewed?" and "what
 * does it say?" are one computation and cannot disagree.
 */
function reviewBlock(text: string): string[] {
  const lines = text.split("\n");
  // `hasReviewMarker` is line-anchored, so applying it per line is exactly the
  // whole-file predicate — the marker regex is never re-spelled here.
  const start = lines.findIndex((line) => hasReviewMarker(line));
  if (start === -1) return [];
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("//")) break;
    block.push(line);
  }
  return block;
}

const check: Check = {
  id: "config:overrides-authored",
  description:
    "No committed config override may still carry the seeded `// @review` marker — its values must be reviewed, then the marker deleted",
  // Cheap (one filesystem walk of `config/` — no barrel import, no manifest, no
  // subprocess) and codegen-coupled: the build itself mints the marker, so fail
  // at build — including `--skip-checks` builds — not only at push.
  alwaysRun: true,
  // Never cache: the marker is written by the BUILD, after that run's tree hash
  // was taken, so a PASS recorded before the seeding pass would replay straight
  // over a freshly marked file. The scan is cheap, so always re-running it is
  // the correct trade.
  cacheSignature: () => null,
  async run() {
    const root = await getWorktreeRoot();

    const files: string[] = [];
    collectOverrideFiles(join(root, CONFIG_DIR), files);
    files.sort();

    const marked: { path: string; block: string[] }[] = [];
    for (const file of files) {
      const block = reviewBlock(readFileSync(file, "utf8"));
      if (block.length > 0) marked.push({ path: relative(root, file), block });
    }

    if (marked.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `${marked.length} config override(s) still carry the seeded \`${REVIEW_MARKER}\` marker:\n\n` +
        marked
          .map(
            ({ path, block }) =>
              `    ${path}\n` + block.map((l) => `        ${l}`).join("\n"),
          )
          .join("\n\n") +
        "\n\nWhy this is required: `./equin build` writes these values for " +
        "you — it seeds a missing mandatory override from its origin, and " +
        "re-marks one whose origin default moved underneath it. The marker means " +
        "the values below are machine-produced, NOT deliberate. Deleting it is a " +
        "claim that you looked at them and they are what this surface should be.",
      hint:
        "For each path: open the file, follow its own guidance comments (echoed " +
        `above), arrange the values, then delete the \`${REVIEW_MARKER}\` line. ` +
        "Keep the leading `// @hash` line — it is already correct, and never " +
        "needs retyping. Re-run `./equin check config:overrides-authored` " +
        "to confirm.",
    };
  },
};

export default check;
