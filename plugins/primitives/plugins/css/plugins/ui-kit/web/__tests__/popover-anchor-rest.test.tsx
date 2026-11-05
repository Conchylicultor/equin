import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  PopupAnchorRest,
  PopupOpenScope,
} from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";

/**
 * A popover requested from a region still moving into place (a floating bar
 * morphing open) is reported at once — that opens the bar — but drawn only once
 * the region is at rest, so it is laid out against where its trigger ends up.
 */

afterEach(cleanup);

function Subject({ atRest }: { atRest: boolean }) {
  return (
    <PopupOpenScope>
      {(popupOpen) => (
        <>
          <span data-testid="held">{String(popupOpen)}</span>
          <PopupAnchorRest atRest={atRest}>
            <Popover open={true} onOpenChange={() => {}}>
              <PopoverTrigger>wish</PopoverTrigger>
              <PopoverContent>panel</PopoverContent>
            </Popover>
          </PopupAnchorRest>
        </>
      )}
    </PopupOpenScope>
  );
}

describe("Popover waits for its anchor to rest", () => {
  it("reports the open at once but draws only once at rest", () => {
    const { getByTestId, queryByText, rerender } = render(
      <Subject atRest={false} />,
    );
    expect(getByTestId("held").textContent).toBe("true");
    expect(queryByText("panel")).toBeNull();

    rerender(<Subject atRest={true} />);
    expect(queryByText("panel")).not.toBeNull();
  });

  it("stays drawn if the region moves again while it is open", () => {
    const { queryByText, rerender } = render(<Subject atRest={true} />);
    expect(queryByText("panel")).not.toBeNull();
    rerender(<Subject atRest={false} />);
    expect(queryByText("panel")).not.toBeNull();
  });

  it("opens at once outside any moving region", () => {
    const { getByRole, queryByText } = render(
      <Popover>
        <PopoverTrigger>wish</PopoverTrigger>
        <PopoverContent>panel</PopoverContent>
      </Popover>,
    );
    expect(queryByText("panel")).toBeNull();
    act(() => getByRole("button", { name: "wish" }).click());
    expect(queryByText("panel")).not.toBeNull();
  });
});
