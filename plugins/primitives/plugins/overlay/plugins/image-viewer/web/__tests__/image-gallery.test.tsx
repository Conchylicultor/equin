import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ImageGallery,
  ViewerThumbnail,
  useImageProbe,
  useImageViewerTrigger,
} from "../index";

afterEach(cleanup);

// jsdom has no HTMLImageElement.decode(); the viewer decodes the next images
// ahead. Like jsdom's loads, these decodes never finish.
Object.defineProperty(HTMLImageElement.prototype, "decode", {
  configurable: true,
  writable: true,
  value: () => new Promise<void>(() => {}),
});

// jsdom never loads images, so the viewer stays on its loading state — which
// is all these tests need: they are about WHICH image is open, and in what
// order ← / → walks, not about pixels.
const src = (name: string) => `data:image/png;base64,${btoa(name)}`;

function Transcript({ names }: { names: readonly string[] }) {
  return (
    <ImageGallery>
      {names.map((name) => (
        <ViewerThumbnail key={name} image={{ src: src(name), name }} />
      ))}
    </ImageGallery>
  );
}

const open = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name: `View image ${name}` }));
const viewer = () => screen.getByRole("dialog");
const press = (key: string) => fireEvent.keyDown(viewer(), { key });
const showing = (name: string) =>
  expect(viewer().getAttribute("aria-label")).toBe(`Image viewer: ${name}`);

describe("ImageGallery", () => {
  it("steps through thumbnails in page order, not the order they mounted in", () => {
    const { rerender } = render(<Transcript names={["a", "c"]} />);
    // "b" mounts last, between the other two.
    rerender(<Transcript names={["a", "b", "c"]} />);

    open("b");
    showing("b");
    press("ArrowRight");
    showing("c");
    press("ArrowRight"); // already last: stays
    showing("c");
    press("ArrowLeft");
    press("ArrowLeft");
    showing("a");
    expect(
      screen.getByRole("button", { name: "Previous image" }),
    ).toHaveProperty("disabled", true);
  });

  it("keeps the keys working once a step disables the focused arrow", () => {
    render(<Transcript names={["a", "b", "c"]} />);
    open("b");
    const next = screen.getByRole("button", { name: "Next image" });
    next.focus();
    fireEvent.click(next);
    showing("c");
    // The › arrow is now disabled: focus must be back on the viewer, or the
    // next key lands on <body>, outside its handler.
    expect(document.activeElement).toBe(viewer());
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "ArrowLeft",
    });
    showing("b");
  });

  it("keeps the open image when another registers before it", () => {
    const { rerender } = render(<Transcript names={["a", "c"]} />);
    open("c");
    showing("c");
    expect(screen.getByRole("button", { name: "Next image" })).toHaveProperty(
      "disabled",
      true,
    );

    rerender(<Transcript names={["a", "b", "c"]} />);

    // Still "c" — the open image is tracked by key, not by its old index 1,
    // which now belongs to "b".
    showing("c");
    expect(screen.getByRole("button", { name: "Next image" })).toHaveProperty(
      "disabled",
      true,
    );
    press("ArrowLeft");
    showing("b");
  });

  it("keeps Escape from reaching the app's own shortcuts, and returns focus on close", async () => {
    const appShortcut = vi.fn();
    window.addEventListener("keydown", appShortcut);
    try {
      render(<Transcript names={["a", "b"]} />);
      const thumb = screen.getByRole("button", { name: "View image a" });
      fireEvent.click(thumb);
      press("Escape");
      expect(appShortcut).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(thumb);
    } finally {
      window.removeEventListener("keydown", appShortcut);
    }
  });

  it("closes the shortcut sheet before the viewer on Escape", () => {
    render(<Transcript names={["a"]} />);
    open("a");
    press("?");
    expect(screen.getByText("Shortcuts")).toBeTruthy();
    press("Escape");
    expect(screen.queryByText("Shortcuts")).toBeNull();
    showing("a");
  });
});

describe("a thumbnail outside any gallery", () => {
  it("is a gallery of one, with no way to step to another image", () => {
    render(
      <>
        <ViewerThumbnail image={{ src: src("x"), name: "x" }} />
        <ViewerThumbnail image={{ src: src("y"), name: "y" }} />
      </>,
    );
    open("y");
    showing("y");
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous image" })).toBeNull();
  });

  it("renders its viewer inside its own React tree", () => {
    // What a popover around a pasted-image chip relies on: a press inside the
    // viewer bubbles (through React, across the portal) to the chip's
    // ancestors, so the popover counts it as inside rather than dismissing.
    const ancestorClick = vi.fn();
    render(
      <div onClick={ancestorClick}>
        <ViewerThumbnail image={{ src: src("x"), name: "x" }} />
      </div>,
    );
    open("x");
    ancestorClick.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(ancestorClick).toHaveBeenCalledTimes(1);
  });
});

describe("useImageViewerTrigger", () => {
  it("throws outside any gallery: a hook cannot render the viewer", () => {
    function Block() {
      const trigger = useImageViewerTrigger<HTMLImageElement>({
        src: src("x"),
        name: "x",
      });
      return <img src={src("x")} alt="x" {...trigger} />;
    }
    // React logs the uncaught render error before rethrowing it.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      expect(() => render(<Block />)).toThrow(
        /must be rendered inside an <ImageGallery>/,
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("an image that does not load", () => {
  afterEach(() => vi.unstubAllGlobals());

  const fail = (name: string) =>
    fireEvent.error(
      screen
        .getByRole("button", { name: `View image ${name}` })
        .querySelector("img")!,
    );
  const answering = (status: number) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status }))),
    );

  it("says the file is gone when its server answers 404, and opens nothing", async () => {
    answering(404);
    render(<ViewerThumbnail image={{ src: "/api/x.png", name: "x.png" }} />);
    fail("x.png");
    await screen.findByText("No longer available");
    expect(screen.getByRole("img", { name: "Image unavailable: x.png" }));
    expect(
      screen.queryByRole("button", { name: "View image x.png" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers Retry for any other failure, which loads the image again", async () => {
    answering(500);
    render(<ViewerThumbnail image={{ src: "/api/x.png", name: "x.png" }} />);
    fail("x.png");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(screen.getByRole("button", { name: "View image x.png" }));
  });

  it("leaves its gallery, so ← / → step over it", async () => {
    render(<Transcript names={["a", "b", "c"]} />);
    // A data: URI has no server to ask: unreadable at once.
    fail("b");
    await screen.findByRole("img", { name: "Image unavailable: b" });
    open("a");
    press("ArrowRight");
    showing("c");
  });
});

describe("useImageProbe", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** jsdom never loads images: every off-DOM image fails. */
  class FailingImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(_: string) {
      queueMicrotask(() => this.onerror?.());
    }
  }

  function Probe({ src }: { src: string }) {
    const { load, retry } = useImageProbe(src);
    return (
      <button type="button" onClick={retry}>
        {load.kind === "failed" ? load.reason : load.kind}
      </button>
    );
  }

  const answering = (status: number) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status })));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("classifies a failure the way useImageLoad does: 404 is gone", async () => {
    vi.stubGlobal("Image", FailingImage);
    answering(404);
    render(<Probe src="/api/x.png" />);
    await screen.findByText("gone");
  });

  it("calls any other failure unreadable, and loads again on retry", async () => {
    vi.stubGlobal("Image", FailingImage);
    const fetch = answering(500);
    render(<Probe src="/api/x.png" />);
    fireEvent.click(await screen.findByText("unreadable"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
