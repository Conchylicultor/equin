import { describe, expect, test } from "bun:test";
import {
  PUSH_POLICY_TEXT,
  renderPrompt,
} from "@plugins/tasks/plugins/automations/core";
import {
  DEPS_UPGRADE_PROMPT,
  outdatedSections,
  upgradeTaskTitle,
  type OutdatedUpdater,
} from "./upgrade-prompt";

const batch: OutdatedUpdater[] = [
  {
    updaterId: "mise",
    outdated: [{ name: "bun", current: "1.3.12", latest: "1.3.13" }],
    lapsed: [],
    holdsFile: "mise.holds.jsonc",
  },
];

describe("DEPS_UPGRADE_PROMPT", () => {
  test("fills from the batch and the push policy, with no hole left", () => {
    const rendered = renderPrompt(DEPS_UPGRADE_PROMPT, {
      outdated: outdatedSections(batch),
      pushPolicy: PUSH_POLICY_TEXT.checks,
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.text).toContain("- bun 1.3.12 → 1.3.13");
    expect(rendered.text).toContain("`mise` (holds in `mise.holds.jsonc`)");
    expect(rendered.text).toContain("You are authorized to push");
    expect(rendered.text).not.toContain("{{");
  });

  test("push never: no authorization reaches the agent", () => {
    const rendered = renderPrompt(DEPS_UPGRADE_PROMPT, {
      outdated: outdatedSections(batch),
      pushPolicy: PUSH_POLICY_TEXT.never,
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.text).not.toContain("authorized to push");
    expect(rendered.text).toContain("Do NOT push.");
  });
});

describe("held and blocked rows", () => {
  const mixed: OutdatedUpdater[] = [
    {
      updaterId: "npm",
      holdsFile: "package.json",
      lapsed: [],
      outdated: [
        { name: "vite", current: "6.4.2", latest: "7.1.0" },
        {
          name: "react",
          current: "19.1.0",
          latest: "20.0.0",
          waiting: {
            kind: "held",
            reason: "waits on x",
            reviewBy: "2026-12-01",
            lapsed: false,
          },
        },
        {
          name: "@embedded-postgres/darwin-arm64",
          current: "18.3.0-beta.17",
          latest: "18.4.0-beta.1",
          waiting: { kind: "blocked", prerequisite: "publish pg-client 18.4" },
        },
      ],
    },
  ];

  test("the task text names why each waits", () => {
    const text = outdatedSections(mixed);
    expect(text).toContain("- vite 6.4.2 → 7.1.0\n");
    expect(text).toContain("HELD (review by 2026-12-01): waits on x");
    expect(text).toContain("BLOCKED, do this first: publish pg-client 18.4");
  });

  test("the title lists only the actionable rows", () => {
    const title = upgradeTaskTitle(mixed);
    expect(title).toContain("vite");
    expect(title).toContain("@embedded-postgres/darwin-arm64");
    expect(title).not.toContain("react");
  });
});

describe("holds to review", () => {
  const overdue: OutdatedUpdater[] = [
    {
      updaterId: "uv",
      holdsFile: "uv-holds.ts",
      outdated: [
        {
          name: "audio-analysis:cpython",
          current: "3.14.7",
          latest: "3.15.0",
          waiting: {
            kind: "held",
            reason: "no cp315 wheels",
            reviewBy: "2026-11-15",
            lapsed: true,
          },
        },
      ],
      lapsed: [
        {
          names: ["cpython"],
          version: "3.15.0",
          reason: "no cp315 wheels",
          issue: "https://example.com/i/1",
          reviewBy: "2026-11-15",
        },
      ],
    },
  ];

  test("each lapsed hold is its own checklist item, with its reason and issue", () => {
    const text = outdatedSections(overdue);
    expect(text).toContain(
      "HELD, REVIEW OVERDUE since 2026-11-15: no cp315 wheels",
    );
    expect(text).toContain(
      "Holds to review:\n- [ ] cpython 3.15.0 (review by 2026-11-15): no cp315 wheels — https://example.com/i/1",
    );
  });

  test("a lapsed hold alone is work: it titles the task", () => {
    expect(upgradeTaskTitle(overdue)).toBe(
      "Upgrade uv: review hold on cpython",
    );
  });
});
