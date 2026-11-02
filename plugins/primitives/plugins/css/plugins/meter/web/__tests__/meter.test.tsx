import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { Meter } from "../internal/meter";

afterEach(cleanup);

function bar(ui: ReactElement): HTMLElement {
  return render(ui).container.firstElementChild as HTMLElement;
}

function fillWidth(el: HTMLElement): string {
  return el.querySelector<HTMLElement>("[data-meter-fill]")!.style.width;
}

describe("Meter", () => {
  it("reports its reading as a percentage", () => {
    const el = bar(<Meter value={0.514} label="Week usage" />);
    expect(el.getAttribute("role")).toBe("meter");
    expect(el.getAttribute("aria-label")).toBe("Week usage");
    expect(el.getAttribute("aria-valuenow")).toBe("51");
    expect(fillWidth(el)).toBe("51.4%");
  });

  it("clamps an overfull or negative value when drawn", () => {
    expect(fillWidth(bar(<Meter value={1.7} label="x" />))).toBe("100%");
    cleanup();
    const el = bar(<Meter value={-0.2} label="x" />);
    expect(fillWidth(el)).toBe("0%");
    expect(el.getAttribute("aria-valuenow")).toBe("0");
  });

  it("is a progressbar when asked", () => {
    const el = bar(<Meter value={0.3} label="Scan" role="progressbar" />);
    expect(el.getAttribute("role")).toBe("progressbar");
  });

  it("draws the marker only when given, with its tooltip", () => {
    expect(
      bar(<Meter value={0.5} label="x" />).querySelector("[data-meter-marker]"),
    ).toBeNull();
    cleanup();
    const marker = bar(
      <Meter value={0.5} label="x" marker={0.32} markerLabel="Pace" />,
    ).querySelector<HTMLElement>("[data-meter-marker]")!;
    expect(marker.getAttribute("title")).toBe("Pace");
    expect(marker.style.left).toBe("32%");
  });
});
