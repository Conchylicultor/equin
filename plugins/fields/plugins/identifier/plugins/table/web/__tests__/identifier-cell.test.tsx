import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type {
  FieldDef,
  TableCellProps,
} from "@plugins/primitives/plugins/data-view/web";
import { IdentifierCell } from "../components/identifier-cell";

const field: FieldDef<unknown> = {
  id: "sha",
  label: "Commit",
  type: "identifier",
};

function renderCell(value: TableCellProps["value"]) {
  return render(<IdentifierCell value={value} field={field} />);
}

afterEach(cleanup);

describe("IdentifierCell", () => {
  it("draws the value in the code role with the whole value as its tooltip", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const { getByText } = renderCell(sha);
    const text = getByText(sha);
    expect(text.getAttribute("title")).toBe(sha);
    expect(text.className).toMatch(/text-code/);
  });

  it("draws nothing for an absent value", () => {
    expect(renderCell(null).container.textContent).toBe("");
    cleanup();
    expect(renderCell("").container.textContent).toBe("");
  });

  it("copies the value without the click reaching the row", () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const rowClick = vi.fn();
    const { getByRole } = render(
      <div onClick={rowClick}>
        <IdentifierCell value="run-42" field={field} />
      </div>,
    );
    fireEvent.click(getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("run-42");
    expect(rowClick).not.toHaveBeenCalled();
  });
});
