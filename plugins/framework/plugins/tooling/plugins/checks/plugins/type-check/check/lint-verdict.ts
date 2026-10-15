// The type-aware lint verdict, assembled from every file's raw messages —
// whether they were just produced by the worker or read back from the result
// store — and the CURRENT exemption manifests.
//
// Exemptions are applied here, at read time, rather than in the worker before
// the result is stored: an exemption decides only which messages are dropped,
// so keeping it out of the stored result is what lets a manifest edit re-lint
// nothing (`./lint-groups`).

import {
  createExemptionIndex,
  describeExemption,
  isLintRuleId,
  type ResolvedExemption,
} from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import type { RawLintMessage } from "../core";

export interface FileLintMessages {
  /** Repo-relative path. */
  rel: string;
  messages: readonly RawLintMessage[];
}

/**
 * The violation lines for a set of files, in the order given: every message an
 * exemption does not cover, then every FILE-level exemption on a file that
 * suppressed nothing.
 *
 * The unused-exemption report is the same contract as
 * `reportUnusedDisableDirectives: "error"`. It is now judged on every file,
 * since every file's full result is at hand; a directory-level exemption still
 * cannot be judged here (`exempt:manifests-valid` checks that it exists).
 * Rule-id validation of the manifests is that check's job too.
 */
export function lintViolationLines(
  files: readonly FileLintMessages[],
  exemptions: readonly ResolvedExemption[],
): string[] {
  const index = createExemptionIndex(
    exemptions.filter((e) => isLintRuleId(e.rule)),
  );
  const lines: string[] = [];
  for (const { rel, messages } of files) {
    const kept = messages.filter(
      (m) =>
        m.ruleId === null ||
        index.exemptionsFor(m.ruleId).match(rel) === undefined,
    );
    for (const m of kept) {
      // A null ruleId is the linter itself, not a rule: a parse failure
      // (fatal) or an unused-disable-directive report. Labelled apart, so the
      // latter does not send the reader hunting for a syntax bug.
      const source = m.ruleId ?? (m.fatal ? "(parse)" : "(unused-disable)");
      lines.push(`${rel}:${m.line}:${m.column}  ${source}  ${m.message}`);
    }
    for (const e of index.unused(index.at(rel))) {
      lines.push(
        `${rel}:1:1  (unused-exemption)  suppressed nothing — delete it from ${e.manifest}: ${describeExemption(e)}`,
      );
    }
  }
  return lines;
}
