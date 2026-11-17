import { describe, expect, test } from "bun:test";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import {
  renderPrompt,
  templateVariables,
} from "@plugins/tasks/plugins/automations/core";
import {
  UPSTREAM_MERGE_PROMPT,
  upstreamMergeTitle,
  upstreamMergeVariables,
  type UpstreamUpdates,
} from "./merge-prompt";

const base: UpstreamUpdates = {
  latest: "v2026.11.14",
  current: "v2026.10.30",
  url: "https://github.com/equinai/equin",
};

function rendered(d: UpstreamUpdates): string {
  const r = renderPrompt(UPSTREAM_MERGE_PROMPT, {
    ...upstreamMergeVariables(d),
    pushPolicy: "**Wait.**",
  });
  if (!r.ok) throw new Error(`unfilled: ${r.unknown.join(", ")}`);
  return r.text;
}

describe("upstreamMergeVariables", () => {
  test("names the release, where this checkout stands, and the remote", () => {
    const text = rendered(base);
    expect(text).toContain("2026.11.14");
    expect(text).toContain("is on 2026.10.30");
    expect(text).toContain(base.url);
  });

  test("a checkout holding no release says so", () => {
    expect(rendered({ ...base, current: null })).toContain(
      "holds no release yet",
    );
  });

  test("merges the release tag, never upstream's main", () => {
    expect(upstreamMergeVariables(base).ref).toBe("v2026.11.14");
    expect(rendered(base)).not.toContain("/main");
  });

  test("the title names the version", () => {
    expect(upstreamMergeTitle(base)).toContain("2026.11.14");
  });
});

describe("UPSTREAM_MERGE_PROMPT", () => {
  test("carries the five steps", () => {
    const text = rendered(base);
    // The mechanical half is one command, not prose the agent re-derives.
    expect(text).toContain("./equin upstream merge");
    expect(text).toContain("./equin build");
    expect(text).toContain("build-status.json");
    for (const step of ["1.", "2.", "3.", "4.", "5."])
      expect(text).toContain(`\n${step} `);
  });

  test("concludes the merge through the command, never a raw git commit", () => {
    const text = rendered(base);
    // The repo's rule is that an agent never commits. `merge --continue` exists
    // so this prompt never has to carve an exception into it.
    expect(text).toContain("./equin upstream merge --continue");
    expect(text).not.toContain("git commit");
  });

  test("keeps the two conflict rules that decide whether to stop", () => {
    const text = rendered(base);
    expect(text).toContain("Generated files re-derive themselves");
    expect(text).toContain("conflicted migration");
  });

  test("explains the migration merge node, and when to stop on migrations", () => {
    const text = rendered(base);
    expect(text).toContain("merge node");
    expect(text).toContain(`${LEGACY_IDS.migrationMarker}:snapshot id=`);
    expect(text).toContain("snapshot merge conflict");
    expect(text).toContain("migration-applies-clean");
    expect(text).toContain("verbatim");
    expect(text).toContain(
      "Never delete, rename or edit a file under\n   `plugins/database/plugins/migrations/data`",
    );
  });

  test("names exactly the variables the automation fills", () => {
    // `updates` and `ref` come from upstreamMergeVariables, `pushPolicy` from
    // the automation's Push setting — anything else would refuse to render.
    expect(templateVariables(UPSTREAM_MERGE_PROMPT).sort()).toEqual(
      [...Object.keys(upstreamMergeVariables(base)), "pushPolicy"].sort(),
    );
  });

  test("leaves landing to the push policy", () => {
    expect(UPSTREAM_MERGE_PROMPT).not.toContain("Do not push");
    expect(UPSTREAM_MERGE_PROMPT).toContain("{{pushPolicy}}");
  });
});
