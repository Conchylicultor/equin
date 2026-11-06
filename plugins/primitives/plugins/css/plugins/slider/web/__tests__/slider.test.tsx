import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Slider } from "../internal/slider";

afterEach(cleanup);

function renderSlider(orientation?: "horizontal" | "vertical") {
  const onValueChange = vi.fn();
  const { container } = render(
    <Slider
      value={0.25}
      min={0}
      max={1}
      step={0.05}
      orientation={orientation}
      aria-label="Volume"
      onValueChange={onValueChange}
    />,
  );
  const wrapper = container.querySelector<HTMLElement>(".slider")!;
  const input = container.querySelector<HTMLInputElement>("input")!;
  return { wrapper, input, onValueChange };
}

describe("Slider orientation", () => {
  it("is horizontal by default, with the input's own track", () => {
    const { wrapper, input } = renderSlider();
    expect(wrapper.dataset.orientation).toBe("horizontal");
    expect(input.getAttribute("aria-orientation")).toBe("horizontal");
    expect(wrapper.querySelector(".slider-rail")).toBeNull();
  });

  it("vertical draws its own inset rail and says so to assistive tech", () => {
    const { wrapper, input } = renderSlider("vertical");
    expect(wrapper.dataset.orientation).toBe("vertical");
    expect(input.getAttribute("aria-orientation")).toBe("vertical");
    expect(wrapper.querySelector(".slider-rail")).not.toBeNull();
    // The fill is normalized against the range, whichever the orientation.
    expect(wrapper.style.getPropertyValue("--slider-fill")).toBe("25");
  });

  it("reports the value, ends included", () => {
    const { input, onValueChange } = renderSlider("vertical");
    fireEvent.change(input, { target: { value: "0" } });
    expect(onValueChange).toHaveBeenLastCalledWith(0);
    fireEvent.change(input, { target: { value: "1" } });
    expect(onValueChange).toHaveBeenLastCalledWith(1);
  });
});
