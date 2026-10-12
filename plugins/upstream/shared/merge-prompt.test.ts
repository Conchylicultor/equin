import { describe, expect, test } from "bun:test";
import { templateVariables } from "@plugins/tasks/plugins/automations/core";
import {
  UPSTREAM_MERGE_PROMPT,
  upstreamMergeInstructions,
  upstreamMergeVariables,
  type UpstreamUpdates,
} from "./merge-prompt";

const base: UpstreamUpdates = {
  ref: "origin/main",
  url: "https://github.com/Conchylicultor/singularity",
  count: 3,
  newest: [
    { sha: "1111111111111111111111111111111111111111", subject: "feat: a" },
    { sha: "2222222222222222222222222222222222222222", subject: "fix: b" },
    { sha: "3333333333333333333333333333333333333333", subject: "chore: c" },
  ],
};

describe("upstreamMergeInstructions", () => {
  test("names the gap, the ref and the remote's URL", () => {
    const text = upstreamMergeInstructions(base);
    expect(text).toContain("3 commits");
    expect(text).toContain("origin/main");
    expect(text).toContain(base.url);
  });

  test("one commit reads as one commit", () => {
    const text = upstreamMergeInstructions({
      ...base,
      count: 1,
      newest: [base.newest[0]!],
    });
    expect(text).toContain("1 commit this checkout does not");
    expect(text).not.toContain("1 commits");
  });

  test("lists each commit by short sha and subject", () => {
    const text = upstreamMergeInstructions(base);
    for (const c of base.newest) {
      expect(text).toContain(c.sha.slice(0, 9));
      expect(text).toContain(c.subject);
    }
    // Only the newest are listed, so nothing claims there are more than there are.
    expect(text).not.toContain("older");
  });

  test("says how many it did not list when the list is capped", () => {
    const text = upstreamMergeInstructions({ ...base, count: 250 });
    expect(text).toContain("… and 247 older");
  });

  test("carries the five steps, ending on do-not-push", () => {
    const text = upstreamMergeInstructions(base);
    // The mechanical half is one command, not prose the agent re-derives.
    expect(text).toContain("./singularity upstream merge");
    expect(text).toContain("./singularity build");
    expect(text).toContain("build-status.json");
    for (const step of ["1.", "2.", "3.", "4.", "5."])
      expect(text).toContain(`\n${step} `);
    expect(text).toContain("Do not push");
  });

  test("concludes the merge through the command, never a raw git commit", () => {
    const text = upstreamMergeInstructions(base);
    // The repo's rule is that an agent never commits. `merge --continue` exists
    // so this prompt never has to carve an exception into it.
    expect(text).toContain("./singularity upstream merge --continue");
    expect(text).not.toContain("git commit");
  });

  test("keeps the two conflict rules that decide whether to stop", () => {
    const text = upstreamMergeInstructions(base);
    // Generated files are re-derived, never hand-resolved…
    expect(text).toContain("Generated files re-derive themselves");
    // …and a conflicted migration is a person's call.
    expect(text).toContain("conflicted migration");
  });

  test("explains the migration merge node, and when to stop on migrations", () => {
    const text = upstreamMergeInstructions(base);
    // The build writes a merge node; the agent must not mistake it for noise.
    expect(text).toContain("merge node");
    expect(text).toContain("singularity:merge-snapshot");
    // Stop and report, verbatim, on either failure mode.
    expect(text).toContain("snapshot merge conflict");
    expect(text).toContain("migration-applies-clean");
    expect(text).toContain("verbatim");
    // Published migrations are immutable.
    expect(text).toContain(
      "Never delete, rename or edit a file under\n   `plugins/database/plugins/migrations/data`",
    );
  });
});

describe("UPSTREAM_MERGE_PROMPT", () => {
  test("names exactly the variables the automation fills", () => {
    // `updates` and `ref` come from upstreamMergeVariables, `pushPolicy` from
    // the automation's Push setting — anything else would refuse to render.
    expect(templateVariables(UPSTREAM_MERGE_PROMPT).sort()).toEqual(
      [...Object.keys(upstreamMergeVariables(base)), "pushPolicy"].sort(),
    );
  });

  test("leaves landing to the push policy", () => {
    // Step 5 is the push policy; the template itself never decides it.
    expect(UPSTREAM_MERGE_PROMPT).not.toContain("Do not push");
    expect(UPSTREAM_MERGE_PROMPT).toContain("{{pushPolicy}}");
  });
});
