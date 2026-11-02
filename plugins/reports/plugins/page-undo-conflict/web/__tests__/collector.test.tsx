// The collector is the ONE mapping from the editor's neutral sink body to a
// `page-undo-conflict` report. Two things are load-bearing: the mapping itself
// (kind, source, a message that reads plainly, the body carried as `data`) and
// the lifetime — a mounted collector drains the sink, an unmounted one leaves
// it inert, so a body emitted after unmount reaches nothing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { undoConflictReportSink } from "@plugins/page/plugins/editor/web";
import { report } from "@plugins/reports/web";
import { PageUndoConflictCollector } from "../components/page-undo-conflict-collector";

vi.mock("@plugins/reports/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  report: vi.fn(async () => null),
}));

const reportMock = vi.mocked(report);

afterEach(() => {
  cleanup();
  undoConflictReportSink.register(null);
  reportMock.mockClear();
});

describe("PageUndoConflictCollector", () => {
  it("maps a stale-entry body to a page-undo-conflict report", () => {
    render(<PageUndoConflictCollector />);
    undoConflictReportSink.emit({
      reason: "stale-entry",
      blockId: "block-a",
      direction: "undo",
      expectedLength: 115,
      actualLength: 42,
    });
    expect(reportMock).toHaveBeenCalledTimes(1);
    const body = reportMock.mock.calls[0]![0];
    expect(body.kind).toBe("page-undo-conflict");
    expect(body.source).toBe("client-page-undo-conflict");
    expect(body.message).toBe(
      "Undo replay found block text of 42 chars where the entry expected 115 (undo)",
    );
    expect(body.data).toEqual({
      reason: "stale-entry",
      blockId: "block-a",
      direction: "undo",
      expectedLength: 115,
      actualLength: 42,
    });
  });

  it("names the block for a run-aborted body", () => {
    render(<PageUndoConflictCollector />);
    undoConflictReportSink.emit({
      reason: "run-aborted",
      blockId: "block-b",
      direction: null,
      expectedLength: 10,
      actualLength: 30,
    });
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock.mock.calls[0]![0].message).toBe(
      "A typing run in block block-b was dropped because a remote change landed mid-run (10 → 30 chars)",
    );
  });

  it("unregisters on unmount so a later emit reaches nothing", () => {
    const { unmount } = render(<PageUndoConflictCollector />);
    unmount();
    undoConflictReportSink.emit({
      reason: "run-aborted",
      blockId: "block-c",
      direction: null,
      expectedLength: 1,
      actualLength: 2,
    });
    expect(reportMock).not.toHaveBeenCalled();
  });
});
