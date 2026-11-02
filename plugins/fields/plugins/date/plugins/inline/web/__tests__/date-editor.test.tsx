import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

/**
 * The editor is **unreachable in the UI today** — every `type: "date"` field in
 * the repo is read-only (none declares `onEdit`) and `custom-columns` v1 only
 * authors `"text"` columns — so this suite is its only verification.
 *
 * It stands in a fake `DatePickerPopover` rather than driving the real month
 * grid, because what this file owns is the **wiring**: which of `onCommit` /
 * `onCancel` a given popover outcome maps to, and that exactly one of them ever
 * fires. The calendar's own rendering and day math are the primitive's tests.
 * The stand-in exposes each prop as a button so an outcome can be triggered in
 * isolation — including the pathological orderings a real popover might produce.
 */
interface FakePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: Date | null;
  onChange: (next: Date) => void;
  onClear: () => void;
  trigger: ReactElement;
}

const PICKED = new Date(2026, 7, 14);

vi.mock(
  "@plugins/primitives/plugins/date-picker/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    DatePickerPopover: (props: FakePopoverProps): ReactNode => (
      <div>
        <div data-testid="open">{String(props.open)}</div>
        <div data-testid="seed">
          {props.value === null ? "null" : props.value.toISOString()}
        </div>
        <div data-testid="trigger">{props.trigger}</div>
        <button data-testid="pick" onClick={() => props.onChange(PICKED)} />
        <button data-testid="clear" onClick={() => props.onClear()} />
        <button
          data-testid="dismiss"
          onClick={() => props.onOpenChange(false)}
        />
      </div>
    ),
  }),
);

import { DateEditor } from "../components/date-editor";

afterEach(cleanup);

function renderEditor(value: Date | string | null) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <DateEditor
      value={value}
      field={{ id: "when", label: "When", type: "date", value: () => null }}
      onCommit={onCommit}
      onCommitValues={vi.fn()}
      onCancel={onCancel}
    />,
  );
  return { onCommit, onCancel };
}

describe("DateEditor — outcome wiring", () => {
  it("opens on mount", () => {
    renderEditor(null);
    expect(screen.getByTestId("open").textContent).toBe("true");
  });

  it("picking a day commits that Date and closes", () => {
    const { onCommit, onCancel } = renderEditor(null);
    fireEvent.click(screen.getByTestId("pick"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(PICKED);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId("open").textContent).toBe("false");
  });

  it("clearing commits null", () => {
    const { onCommit } = renderEditor(new Date(2026, 0, 5));
    fireEvent.click(screen.getByTestId("clear"));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("dismissing without picking cancels, and never commits", () => {
    const { onCommit, onCancel } = renderEditor(new Date(2026, 0, 5));
    fireEvent.click(screen.getByTestId("dismiss"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a close following a commit is not a second outcome", () => {
    const { onCommit, onCancel } = renderEditor(null);
    fireEvent.click(screen.getByTestId("pick"));
    // A popover that self-closes AFTER reporting the pick must not read as a
    // cancel on top of the commit the host already received.
    fireEvent.click(screen.getByTestId("dismiss"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("commits at most once", () => {
    const { onCommit } = renderEditor(null);
    fireEvent.click(screen.getByTestId("pick"));
    fireEvent.click(screen.getByTestId("pick"));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe("DateEditor — value projection", () => {
  it("seeds the picker with the field's Date", () => {
    const d = new Date(2026, 0, 5, 9, 30);
    renderEditor(d);
    expect(screen.getByTestId("seed").textContent).toBe(d.toISOString());
  });

  it("parses a string value", () => {
    renderEditor("2026-01-05T09:30:00.000Z");
    expect(screen.getByTestId("seed").textContent).toBe("2026-01-05T09:30:00.000Z");
  });

  it("treats an unparseable value as empty", () => {
    renderEditor("not a date");
    expect(screen.getByTestId("seed").textContent).toBe("null");
  });

  /**
   * The regression this migration fixes. `toISOString().slice(0, 10)` — what the
   * old editor used — is UTC, so a local instant near a day boundary serializes
   * as the wrong calendar day: west of Greenwich the early hours label as the
   * PREVIOUS day, east of it the late hours label as the NEXT one. Both edges
   * are asserted so the test fails under the old implementation in ANY non-UTC
   * zone rather than only in whichever one CI happens to run.
   */
  it.each([
    ["just after local midnight", 0, 30],
    ["just before local midnight", 23, 30],
  ])("labels the trigger with the LOCAL calendar day (%s)", (_name, h, m) => {
    renderEditor(new Date(2026, 7, 14, h, m));
    expect(screen.getByTestId("trigger").textContent).toBe("2026-08-14");
  });

  it("labels an empty value with nothing", () => {
    renderEditor(null);
    expect(screen.getByTestId("trigger").textContent).toBe("");
  });
});
