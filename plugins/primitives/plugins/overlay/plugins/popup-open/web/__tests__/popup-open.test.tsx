import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import {
  anyPopupOpen,
  PopupOpenScope,
  subscribeOpenPopups,
  usePublishOpenPopup,
  useReportPopupOpen,
} from "../index";

/**
 * The invariant under test: a scope reads `true` exactly while at least one
 * descendant popup is open — including a popup that leaves the tree while still
 * open, which is how a hover-reveal latches open forever if the release is tied
 * to the close event rather than to the subscription's teardown.
 */

/** A popup wrapper stand-in: reports whatever its `open` prop says. */
function Popup({ open }: { open: boolean }) {
  useReportPopupOpen(open);
  return null;
}

/** Renders the scope's aggregate as text so assertions read off the DOM. */
function Probe({ children }: { children: ReactNode }) {
  return (
    <PopupOpenScope>
      {(open) => (
        <>
          <span data-testid="held">{String(open)}</span>
          {children}
        </>
      )}
    </PopupOpenScope>
  );
}

afterEach(cleanup);

describe("PopupOpenScope", () => {
  it("holds while a popup is open and releases when it closes", () => {
    const { getByTestId, rerender } = render(
      <Probe>
        <Popup open={false} />
      </Probe>,
    );
    expect(getByTestId("held").textContent).toBe("false");

    rerender(
      <Probe>
        <Popup open={true} />
      </Probe>,
    );
    expect(getByTestId("held").textContent).toBe("true");

    rerender(
      <Probe>
        <Popup open={false} />
      </Probe>,
    );
    expect(getByTestId("held").textContent).toBe("false");
  });

  it("holds until BOTH concurrent popups close", () => {
    const { getByTestId, rerender } = render(
      <Probe>
        <Popup open={true} />
        <Popup open={true} />
      </Probe>,
    );
    expect(getByTestId("held").textContent).toBe("true");

    rerender(
      <Probe>
        <Popup open={false} />
        <Popup open={true} />
      </Probe>,
    );
    expect(getByTestId("held").textContent).toBe("true");

    rerender(
      <Probe>
        <Popup open={false} />
        <Popup open={false} />
      </Probe>,
    );
    expect(getByTestId("held").textContent).toBe("false");
  });

  it("releases when a still-open popup unmounts", () => {
    const { getByTestId, rerender } = render(
      <Probe>
        <Popup open={true} />
      </Probe>,
    );
    expect(getByTestId("held").textContent).toBe("true");

    // The popup never reports `false` — it just leaves the tree.
    rerender(<Probe>{null}</Probe>);
    expect(getByTestId("held").textContent).toBe("false");
  });

  it("aggregates only its own descendants (innermost scope wins)", () => {
    render(
      <div>
        <PopupOpenScope>
          {(outerOpen) => (
            <>
              <span data-testid="outer">{String(outerOpen)}</span>
              <PopupOpenScope>
                {(innerOpen) => (
                  <>
                    <span data-testid="inner">{String(innerOpen)}</span>
                    <Popup open={true} />
                  </>
                )}
              </PopupOpenScope>
            </>
          )}
        </PopupOpenScope>
      </div>,
    );

    expect(document.querySelector('[data-testid="inner"]')?.textContent).toBe(
      "true",
    );
    expect(document.querySelector('[data-testid="outer"]')?.textContent).toBe(
      "false",
    );
  });

  it("is a no-op with no enclosing scope", () => {
    // Also exercises a real open→close transition driven from inside the
    // reporter, the shape a controlled ui-kit Root has.
    function Standalone() {
      const [open, setOpen] = useState(true);
      useReportPopupOpen(open);
      return (
        <button type="button" onClick={() => setOpen(false)}>
          close
        </button>
      );
    }

    const { getByRole } = render(<Standalone />);
    expect(() => act(() => getByRole("button").click())).not.toThrow();
  });
});

/** A real popup stand-in: publishes page-wide whatever its `open` prop says. */
function PagePopup({ open }: { open: boolean }) {
  usePublishOpenPopup(open);
  return null;
}

describe("anyPopupOpen", () => {
  it("counts every popup on the page, scope or not, and releases on unmount", () => {
    let changes = 0;
    const unsubscribe = subscribeOpenPopups(() => (changes += 1));
    const { rerender, unmount } = render(
      <>
        <PagePopup open={false} />
        <Probe>
          <PagePopup open={false} />
        </Probe>
      </>,
    );
    expect(anyPopupOpen()).toBe(false);
    rerender(
      <>
        <PagePopup open />
        <Probe>
          <PagePopup open />
        </Probe>
      </>,
    );
    expect(anyPopupOpen()).toBe(true);
    rerender(
      <>
        <PagePopup open={false} />
        <Probe>
          <PagePopup open />
        </Probe>
      </>,
    );
    expect(anyPopupOpen()).toBe(true);
    unmount();
    expect(anyPopupOpen()).toBe(false);
    expect(changes).toBe(4);
    unsubscribe();
  });

  it("is not held by a region reporting to its scope only", () => {
    render(
      <Probe>
        <Popup open />
      </Probe>,
    );
    expect(anyPopupOpen()).toBe(false);
  });
});
