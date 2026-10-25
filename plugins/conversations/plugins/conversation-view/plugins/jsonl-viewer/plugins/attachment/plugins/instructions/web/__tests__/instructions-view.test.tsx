/**
 * The instructions attachment arrives in two shapes, and the card must read
 * both. The launch snapshot lists the CLAUDE.md files the harness loaded; the
 * session-start re-read reports what CHANGED, and its `files` is legitimately
 * empty when the only news is that a file dropped out.
 *
 * The empty-`files` re-read is the regression this suite exists for: the card
 * used to throw on it and take the transcript row down with a crash boundary.
 * The payloads below are copied from real transcripts.
 */

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import type { AttachmentEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";

// The card's two chrome dependencies are stubbed, because both need the live
// app around them and neither is what is under test. `FilePath` reads the pane
// route (to open a file-peek pane) and throws outside a pane surface;
// `CollapsibleCard` renders the shared row-action strip, which reads the plugin
// registry. What IS under test is the reading the card takes of the payload —
// which counts it announces, which paths it lists, and whether it throws — so
// the stubs render exactly the pieces it hands them.
vi.mock(
  "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web",
  () => ({
    FilePath: ({ filePath }: { filePath: string }) => <span>{filePath}</span>,
    toRelativePath: (p: string) => p,
  }),
);

vi.mock(
  "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web",
  () => ({
    CollapsibleCard: ({
      label,
      note,
      aside,
      children,
    }: {
      label?: ReactNode;
      note?: ReactNode;
      aside?: ReactNode;
      children?: ReactNode;
    }) => (
      <div>
        <div>
          {label}
          {note}
          {aside}
        </div>
        <div>{children}</div>
      </div>
    ),
    CardHeaderAction: ({ children }: { children?: ReactNode }) => (
      <span>{children}</span>
    ),
  }),
);

const { InstructionsView } = await import("../components/instructions-view");

afterEach(cleanup);

/** The real payloads carry an absolute path under the user's home. */
const MEMORY = `${HOME_DIR}/.claude/projects/equin/memory/MEMORY.md`;

function event(attachment: unknown): AttachmentEvent {
  return {
    kind: "attachment",
    at: "2026-09-08T12:02:50.598Z",
    subtype: "instructions",
    attachment,
  };
}

describe("InstructionsView", () => {
  it("renders a re-read whose only news is a removal", () => {
    render(
      <InstructionsView
        event={event({
          type: "instructions",
          files: [],
          removed: [MEMORY],
          changed: true,
          reason: "session_start",
        })}
      />,
    );

    expect(screen.getByText(/1 removed/)).toBeTruthy();
    expect(screen.getByText(MEMORY, { exact: false })).toBeTruthy();
  });

  it("counts files and removals together on the collapsed line", () => {
    render(
      <InstructionsView
        event={event({
          type: "instructions",
          files: [
            { path: "/repo/CLAUDE.md", type: "Project", content: "# a" },
            { path: "/repo/docs/CLAUDE.md", type: "Project", content: "# b" },
          ],
          removed: [MEMORY],
          changed: true,
          reason: "session_start",
        })}
      />,
    );

    expect(screen.getByText(/2 files, 1 removed/)).toBeTruthy();
  });

  it("names a launch snapshot by its file count", () => {
    render(
      <InstructionsView
        event={event({
          type: "instructions",
          files: [{ path: "/repo/CLAUDE.md", type: "Project", content: "# a" }],
        })}
      />,
    );

    expect(screen.getByText(/1 file/)).toBeTruthy();
  });

  it("still throws on a launch snapshot carrying no files at all", () => {
    expect(() =>
      render(
        <InstructionsView event={event({ type: "instructions", files: [] })} />,
      ),
    ).toThrow(/carries no `files`/);
  });
});
