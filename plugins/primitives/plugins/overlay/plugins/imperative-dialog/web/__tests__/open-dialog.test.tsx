import { createContext, useContext } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { DialogTitle } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { RenderOrigin } from "@plugins/primitives/plugins/scope/plugins/render-origin/web";
import { useOpenDialog, type OpenDialog } from "../internal/open-dialog";

afterEach(cleanup);

/** Stands for any context the dialog reads (a transport, a navigator). */
const World = createContext("page");

function Body({ close }: { close: () => void }) {
  return (
    <>
      <DialogTitle>{`dialog in ${useContext(World)}`}</DialogTitle>
      <button type="button" onClick={close}>
        Done
      </button>
    </>
  );
}

let open: OpenDialog | null = null;
/** Hands the opener out, as the render-origin test captures its origin. */
function Opener({ into }: { into: (o: OpenDialog) => void }) {
  into(useOpenDialog());
  return null;
}

function Tree({ withOrigin }: { withOrigin: boolean }) {
  return withOrigin ? (
    <World.Provider value="demo">
      <RenderOrigin>
        <Opener into={(o) => (open = o)} />
      </RenderOrigin>
    </World.Provider>
  ) : null;
}

describe("useOpenDialog", () => {
  it("renders the dialog in the caller's origin and settles on close", async () => {
    render(<Tree withOrigin />);
    let settled = false;
    act(() => {
      void open!((close) => <Body close={close} />).then(() => {
        settled = true;
      });
    });
    expect(await screen.findByText("dialog in demo")).toBeTruthy();
    await act(async () => {
      screen.getByRole("button", { name: "Done" }).click();
      await Promise.resolve();
    });
    expect(settled).toBe(true);
    expect(screen.queryByText("dialog in demo")).toBeNull();
  });

  it("settles when the origin it was opened in goes away", async () => {
    const view = render(<Tree withOrigin />);
    let settled = false;
    act(() => {
      void open!((close) => <Body close={close} />).then(() => {
        settled = true;
      });
    });
    expect(await screen.findByText("dialog in demo")).toBeTruthy();
    view.rerender(<Tree withOrigin={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).toBe(true);
  });
});
