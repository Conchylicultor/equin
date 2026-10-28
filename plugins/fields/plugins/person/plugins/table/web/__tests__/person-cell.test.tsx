import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type {
  FieldDef,
  TableCellProps,
} from "@plugins/primitives/plugins/data-view/web";
import { PersonCell } from "../components/person-cell";

const field: FieldDef<unknown> = {
  id: "composer",
  label: "Composer",
  type: "person",
};

function renderCell(value: TableCellProps["value"]) {
  return render(<PersonCell value={value} field={field} />);
}

afterEach(cleanup);

describe("PersonCell", () => {
  it("draws the name's initial in an avatar beside the name", () => {
    const { container, getByText } = renderCell("Johann Sebastian Bach");
    expect(getByText("Johann Sebastian Bach").getAttribute("title")).toBe(
      "Johann Sebastian Bach",
    );
    expect(getByText("J")).not.toBeNull();
    expect(container.textContent).toBe("JJohann Sebastian Bach");
  });

  it("gives one name one colour", () => {
    const a = renderCell("Clara Schumann").container.innerHTML;
    cleanup();
    expect(renderCell("Clara Schumann").container.innerHTML).toBe(a);
  });

  it("draws nothing for an absent or blank value", () => {
    expect(renderCell(null).container.textContent).toBe("");
    cleanup();
    expect(renderCell("  ").container.textContent).toBe("");
  });
});
