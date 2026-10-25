import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
import { EnumCell } from "../components/enum-cell";

type Row = { status: string };

const FIELD: FieldDef<Row> = {
  id: "status",
  label: "Status",
  type: "enum",
  value: (r) => r.status,
  options: [
    { value: "failed", label: "Failed", variant: "destructive" },
    {
      value: "empty",
      label: "Empty",
      hint: "The run succeeded and found nothing.",
    },
    { value: "idle", label: "Idle" },
    { value: "manual", label: "By hand", quiet: true },
  ],
};

function renderCell(value: string) {
  return render(
    <EnumCell
      field={FIELD as FieldDef<unknown>}
      value={value}
      raw={{ status: value } satisfies Row}
    />,
  );
}

afterEach(cleanup);

describe("EnumCell reads its display metadata off the option", () => {
  it("tints the chip with the option's variant", () => {
    const { getByText } = renderCell("failed");
    // The chip shell, not the inner truncating label span.
    const chip = getByText("Failed").parentElement?.parentElement;
    expect(chip?.className).toContain("text-destructive");
  });

  it("spends the option's hint as the chip's tooltip", () => {
    const { getByText } = renderCell("empty");
    const chip = getByText("Empty").parentElement?.parentElement;
    expect(chip?.getAttribute("data-tooltip")).toBe(
      "The run succeeded and found nothing.",
    );
  });

  it("falls back to muted with no tooltip when the option declares neither", () => {
    const { getByText } = renderCell("idle");
    const chip = getByText("Idle").parentElement?.parentElement;
    expect(chip?.className).toContain("text-muted-foreground");
    expect(chip?.getAttribute("data-tooltip")).toBeNull();
  });

  it("falls back to the raw value when no option matches", () => {
    // The live-registry case: a value whose option is gone (an uninstalled
    // source type). The label is the id, and the chip stays muted.
    const { getByText } = renderCell("shotgun");
    const chip = getByText("shotgun").parentElement?.parentElement;
    expect(chip?.className).toContain("text-muted-foreground");
  });

  it("labels a boolean and the no-value by their canonical spelling", () => {
    const verdict: FieldDef<unknown> = {
      id: "status",
      label: "Status",
      type: "enum",
      valueDomain: "boolean",
      options: [
        { value: "true", label: "Online", variant: "success" },
        { value: "null", label: "Unknown" },
      ],
    };
    const cell = (value: boolean | null) =>
      render(<EnumCell field={verdict} value={value} raw={{}} />);
    expect(cell(true).getByText("Online")).toBeTruthy();
    expect(cell(null).getByText("Unknown")).toBeTruthy();
  });

  it("draws nothing for the no-value no option labels", () => {
    const { container } = render(
      <EnumCell field={FIELD as FieldDef<unknown>} value={null} raw={{}} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("a quiet option", () => {
  it("labels filters and groups but draws no chip in the cell", () => {
    const { container } = renderCell("manual");
    expect(container.textContent).toBe("");
  });
});

describe("EnumCell draws a tinted option without a variant as a dot", () => {
  const tinted: FieldDef<unknown> = {
    id: "source",
    label: "Source",
    type: "enum",
    options: [
      { value: "web", label: "Web", tint: "--categorical-3" },
      {
        value: "file",
        label: "File",
        tint: "--categorical-4",
        variant: "success",
      },
    ],
  };

  it("a dot in the tint beside the label, no chip", () => {
    const { container, getByText } = render(
      <EnumCell field={tinted} value="web" raw={{}} />,
    );
    const dot = container.querySelector<HTMLElement>("[data-enum-dot]")!;
    expect(dot.style.backgroundColor).toBe("var(--categorical-3)");
    expect(dot.getAttribute("class")).toContain("size-[7px]");
    expect(getByText("Web").closest("[data-tooltip]")).toBeNull();
  });

  it("a variant keeps the chip", () => {
    const { container, getByText } = render(
      <EnumCell field={tinted} value="file" raw={{}} />,
    );
    expect(container.querySelector("[data-enum-dot]")).toBeNull();
    const chip = getByText("File").parentElement?.parentElement;
    expect(chip?.className).toContain("text-success");
  });
});

describe("EnumCell, quiet (a row view's term)", () => {
  const quiet = (field: FieldDef<unknown>, value: string) =>
    render(
      <EnumCell field={field} value={value} raw={{}} presentation="quiet" />,
    );
  const tinted: FieldDef<unknown> = {
    id: "source",
    label: "Source",
    type: "enum",
    options: [
      { value: "web", label: "Web", tint: "--categorical-3", variant: "info" },
    ],
  };

  it("draws a dot and the label, never a chip — even for a variant", () => {
    const { container, getByText } = quiet(
      FIELD as FieldDef<unknown>,
      "failed",
    );
    const dot = container.querySelector<HTMLElement>("[data-enum-dot]")!;
    // The variant's ink, as the dot's fill.
    expect(dot.getAttribute("class")).toContain("bg-destructive");
    expect(
      getByText("Failed").closest("[class*='text-destructive']"),
    ).toBeNull();
  });

  it("the option's tint wins over its variant", () => {
    const dot = quiet(tinted, "web").container.querySelector<HTMLElement>(
      "[data-enum-dot]",
    )!;
    expect(dot.style.backgroundColor).toBe("var(--categorical-3)");
    expect(dot.getAttribute("class")).not.toContain("bg-info");
  });

  it("a value with no colour gets the faint dot, its hint the label's tooltip", () => {
    const { container, getByText } = quiet(FIELD as FieldDef<unknown>, "empty");
    const dot = container.querySelector<HTMLElement>("[data-enum-dot]")!;
    expect(dot.getAttribute("class")).toContain("bg-faint-foreground");
    expect(getByText("Empty").getAttribute("title")).toBe(
      "The run succeeded and found nothing.",
    );
  });

  it("a quiet option still draws nothing", () => {
    expect(
      quiet(FIELD as FieldDef<unknown>, "manual").container.textContent,
    ).toBe("");
  });
});
