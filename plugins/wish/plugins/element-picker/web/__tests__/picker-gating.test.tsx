/**
 * The draft form's element picker is offered only where the draft's page can
 * be picked (`DraftPage.picker`): in place by default, through the host's
 * pick() for a page elsewhere, and not at all for a draft about no page.
 */
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  DraftPageProvider,
  NO_DRAFT_PAGE,
} from "@plugins/tasks/plugins/task-draft-form/web";
import { TaskDraftPickerButton } from "../components/task-draft-picker-button";

type DraftPage = ComponentProps<typeof DraftPageProvider>["value"];

function renderUnder(page: DraftPage | null) {
  const button = <TaskDraftPickerButton insertText={() => {}} />;
  return render(
    page === null ? (
      button
    ) : (
      <DraftPageProvider value={page}>{button}</DraftPageProvider>
    ),
  );
}

describe("TaskDraftPickerButton", () => {
  afterEach(cleanup);

  it("picks in place on this document (no provider)", () => {
    const { getByRole } = renderUnder(null);
    expect(getByRole("button", { name: "Attach UI element" })).toBeTruthy();
  });

  it("asks the host for a page elsewhere", () => {
    const { getByRole } = renderUnder({
      readUrl: () => "https://example.com/",
      picker: { kind: "remote", pick: () => new Promise(() => {}) },
    });
    expect(getByRole("button", { name: "Attach UI element" })).toBeTruthy();
  });

  it("is not offered on a draft about no page", () => {
    const { container } = renderUnder(NO_DRAFT_PAGE);
    expect(container.innerHTML).toBe("");
  });
});
