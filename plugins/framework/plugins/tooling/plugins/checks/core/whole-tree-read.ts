import {
  newFsCallTally,
  summarizeFsCalls,
  withFsCallTally,
  type FsCallSummary,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  WHOLE_TREE_FILE_CALLS,
  type Check,
  type CheckResult,
} from "@plugins/framework/plugins/tooling/core";

// Whether a check's own body is O(tree) is a property of the check, declared
// on it (`Check.wholeTreeRead`) and measured here on every run of its body.
//
// The meter is the body's own file calls: every timed-fs call made in its
// async context. Work shared with other checks is not the body's — a per-pass
// memo (the plugin tree, the codegen pass) or a plugin record (a fold's scan,
// the module graph) runs under `sharedWork` and is counted under its own
// name, so the count is the same whichever check of a pass starts that work
// and whatever the record store already held: a verdict on it is a function
// of the tree and the check's code, like every other verdict.

/** At or under this many own calls a declared whole-tree read is stale. */
const STALE_BELOW = WHOLE_TREE_FILE_CALLS / 2;

/** `run` with the body's own file calls counted. */
export async function meterOwnFileCalls(
  run: () => Promise<CheckResult>,
): Promise<{ result: CheckResult; own: FsCallSummary }> {
  const tally = newFsCallTally();
  const result = await withFsCallTally(tally, run);
  return { result, own: summarizeFsCalls(tally) };
}

function describe(own: FsCallSummary): string {
  const kinds = (["read", "stat", "readdir", "glob"] as const)
    .filter((k) => own[k] > 0)
    .map((k) => `${own[k]} ${k}`)
    .join(", ");
  const where =
    own.top.length > 0
      ? `; most under ${own.top.map((t) => `${t.prefix} (${t.calls})`).join(", ")}`
      : "";
  return `${own.total} file calls (${kinds}${where})`;
}

/**
 * `result`, failed when the body's own file calls contradict the check's
 * declaration: over {@link WHOLE_TREE_FILE_CALLS} undeclared, or declared and
 * at most half of it. An inconclusive run did not do its work, so it is not judged.
 */
export function judgeOwnFileCalls(
  check: Pick<Check, "id" | "wholeTreeRead">,
  own: FsCallSummary,
  result: CheckResult,
): CheckResult {
  if (!result.ok && result.inconclusive) return result;
  const over = own.total > WHOLE_TREE_FILE_CALLS;
  const declared = check.wholeTreeRead;
  if (over && declared === undefined) {
    const detail =
      `${check.id}'s own body made ${describe(own)} on this pass — over the ` +
      `${WHOLE_TREE_FILE_CALLS} a check may make without declaring a whole-tree read.`;
    const hint =
      "A check's own work must be O(changes). Fold its per-file work " +
      "(defineFoldCheck, or foldRepoFiles: each file's part kept along the " +
      "directory tree, so a pass reads only the edited files), or make it " +
      "input-keyed over a narrow read-set. Until then, declare it on the check: " +
      '`wholeTreeRead: { kind: "debt", task: "<task id>", reason: "…" }`.';
    return result.ok
      ? { ok: false, message: detail, hint }
      : { ...result, message: `${result.message}\n${detail}` };
  }
  // Stale only well under the bound: a declared body whose count sits near
  // it (one more or fewer file of a kind on some branch) must not flip
  // between "undeclared" and "stale" from one tree to the next.
  const stale = own.total <= STALE_BELOW;
  if (stale && declared !== undefined && result.ok) {
    return {
      ok: false,
      message:
        `${check.id} declares a whole-tree read (${declared.kind}: ${declared.reason}), ` +
        `but its own body made ${describe(own)} — not even half the ${WHOLE_TREE_FILE_CALLS} bound.`,
      hint: "The read it declared is gone: delete `wholeTreeRead` from the check.",
    };
  }
  return result;
}
