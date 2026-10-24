import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Column } from "../index";

afterEach(cleanup);

describe("Column", () => {
  it("renders header content inside a shrink-0 wrapper", () => {
    render(
      <Column data-testid="col" header={<span data-testid="hdr">H</span>} />,
    );
    const hdr = document.querySelector<HTMLElement>('[data-testid="hdr"]')!;
    const wrapper = hdr.parentElement!;
    expect(wrapper.classList.contains("shrink-0")).toBe(true);
  });

  it("by default wraps body in a scroll region (overflow-y-auto + min-h-0 flex-1)", () => {
    render(<Column body={<span data-testid="bdy">B</span>} />);
    const bdy = document.querySelector<HTMLElement>('[data-testid="bdy"]')!;
    const wrapper = bdy.parentElement!;
    expect(wrapper.classList.contains("overflow-y-auto")).toBe(true);
    expect(wrapper.classList.contains("min-h-0")).toBe(true);
    expect(wrapper.classList.contains("flex-1")).toBe(true);
  });

  it("with scrollBody={false} the body wrapper is plain flexible (no overflow-y-auto)", () => {
    render(
      <Column scrollBody={false} body={<span data-testid="bdy">B</span>} />,
    );
    const bdy = document.querySelector<HTMLElement>('[data-testid="bdy"]')!;
    const wrapper = bdy.parentElement!;
    expect(wrapper.classList.contains("min-h-0")).toBe(true);
    expect(wrapper.classList.contains("flex-1")).toBe(true);
    expect(wrapper.classList.contains("overflow-y-auto")).toBe(false);
  });

  it("renders footer content inside a shrink-0 wrapper", () => {
    render(<Column footer={<span data-testid="ftr">F</span>} />);
    const ftr = document.querySelector<HTMLElement>('[data-testid="ftr"]')!;
    const wrapper = ftr.parentElement!;
    expect(wrapper.classList.contains("shrink-0")).toBe(true);
  });

  it("fill adds min-h-0 flex-1 to the root; without it the root has neither", () => {
    render(<Column fill data-testid="filled" header={<span>H</span>} />);
    const filled = document.querySelector<HTMLElement>('[data-testid="filled"]')!;
    expect(filled.classList.contains("min-h-0")).toBe(true);
    expect(filled.classList.contains("flex-1")).toBe(true);

    cleanup();

    render(<Column data-testid="plain" header={<span>H</span>} />);
    const plain = document.querySelector<HTMLElement>('[data-testid="plain"]')!;
    expect(plain.classList.contains("min-h-0")).toBe(false);
    expect(plain.classList.contains("flex-1")).toBe(false);
  });

  it("omitted slots render nothing for that region", () => {
    render(<Column data-testid="col" body={<span data-testid="bdy">B</span>} />);
    const root = document.querySelector<HTMLElement>('[data-testid="col"]')!;
    // Only the body region is present — no header/footer wrappers.
    expect(root.children.length).toBe(1);
    expect(root.querySelector('[data-testid="bdy"]')).not.toBeNull();
  });

  it("fit lays out as a grid with one row track per present slot", () => {
    render(
      <Column
        data-testid="fit"
        fit
        header={<span>H</span>}
        body={<span>B</span>}
      />,
    );
    const root = document.querySelector<HTMLElement>('[data-testid="fit"]')!;
    expect(root.classList.contains("grid")).toBe(true);
    expect(root.classList.contains("flex")).toBe(false);
    expect(root.style.gridTemplateRows).toBe("auto minmax(0, 1fr)");
    expect(root.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
  });
});
