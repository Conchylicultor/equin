import { describe, it, expect, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { BreadcrumbSlots } from "@plugins/primitives/plugins/breadcrumb/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { PathBar } from "../internal/path-bar";
import type {
  PathBarSource,
  PathResolution,
  PathTarget,
} from "../internal/types";

/**
 * The path bar's behaviour through its DOM: crumbs ⇄ field, completions,
 * keyboard, commit and revert. The pure transitions are pinned separately in
 * `internal/path-bar-machine.test.ts`.
 */

const plugin = {
  id: "path-bar-test",
  description: "path-bar fixture",
  contributions: [],
  slots: BreadcrumbSlots,
} as unknown as LoadedPlugin;

const DIRS = [
  "/vol",
  "/vol/me",
  "/vol/me/Documents",
  "/vol/me/Downloads",
  "/vol/me/Desktop",
  "/vol/me/code",
];
const FILES = ["/vol/me/notes.md"];

function fakeSource(): PathBarSource & {
  complete: ReturnType<typeof vi.fn>;
  validate: ReturnType<typeof vi.fn>;
} {
  return {
    segments: (path) => {
      const parts = path.split("/").filter(Boolean);
      return [
        { key: "/", label: "/", path: "/" },
        ...parts.map((p, i) => {
          const at = "/" + parts.slice(0, i + 1).join("/");
          return { key: at, label: p, path: at };
        }),
      ];
    },
    complete: vi.fn(async (prefix: string) => {
      const cut = prefix.lastIndexOf("/");
      const parent = prefix.slice(0, cut) || "";
      const stem = prefix.slice(cut + 1).toLowerCase();
      return DIRS.filter((d) => {
        const c = d.lastIndexOf("/");
        return (
          d.slice(0, c) === parent &&
          d
            .slice(c + 1)
            .toLowerCase()
            .startsWith(stem)
        );
      });
    }),
    validate: vi.fn(async (path: string): Promise<PathResolution> => {
      if (DIRS.includes(path)) return { kind: "dir", path };
      if (FILES.includes(path)) return { kind: "file", path };
      return { kind: "invalid", path, reason: "No such folder" };
    }),
  };
}

function setup(path = "/vol/me") {
  const source = fakeSource();
  // Every place is a link: `onNavigate` records a plain open (a crumb click,
  // a committed path), `href` what an "elsewhere" gesture opens instead.
  const onNavigate = vi.fn();
  const activationFor = (t: PathTarget): LinkTarget => ({
    open: () => onNavigate(t),
    href: () => `/files${t.path}`,
  });
  const utils = render(
    <PluginProvider plugins={[plugin]}>
      <PathBar path={path} source={source} activationFor={activationFor} />
    </PluginProvider>,
  );
  const bar = () =>
    utils.container.querySelector<HTMLElement>("[data-path-bar]")!;
  const field = () => screen.getByRole<HTMLInputElement>("combobox");
  const startEditing = async () => {
    fireEvent.mouseDown(bar(), { button: 0 });
    await waitFor(() => expect(field()).toBeTruthy());
  };
  return { ...utils, source, onNavigate, bar, field, startEditing };
}

afterEach(cleanup);

describe("PathBar", () => {
  it("shows crumbs; an ancestor crumb navigates to its folder", () => {
    const { bar, onNavigate } = setup();
    expect(bar().dataset.pathBar).toBe("crumbs");
    fireEvent.click(screen.getByRole("button", { name: "vol" }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "dir", path: "/vol" });
  });

  it("a middle-click on a crumb opens its href in a new browser tab, staying put", () => {
    const { onNavigate } = setup();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      fireEvent(
        screen.getByRole("button", { name: "vol" }),
        new MouseEvent("auxclick", { bubbles: true, button: 1 }),
      );
      expect(open).toHaveBeenCalledTimes(1);
      expect(String(open.mock.calls[0]?.[0])).toMatch(/\/files\/vol$/);
      expect(onNavigate).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it("a press on empty space opens the field on the path plus a separator, selected", async () => {
    const { field, source, startEditing } = setup();
    await startEditing();
    const input = field();
    expect(input.value).toBe("/vol/me/");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("/vol/me/".length);
    expect(source.complete).toHaveBeenCalledWith("/vol/me/");
  });

  it("forwards the trail's type role and leaf weight to the crumbs", () => {
    const source = fakeSource();
    const { container } = render(
      <PluginProvider plugins={[plugin]}>
        <PathBar
          path="/vol/me"
          source={source}
          activationFor={() => () => {}}
          text="body"
          leafWeight="semibold"
        />
      </PluginProvider>,
    );
    const leaf = container.querySelector("[data-breadcrumb-leaf]")!;
    expect(leaf.textContent).toBe("me");
    expect(leaf.className).toContain("font-semibold");
    expect(leaf.parentElement!.className).toContain("text-body");
  });

  it("the pencil opens the field too", async () => {
    const { field } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit the path" }));
    await waitFor(() => expect(field().value).toBe("/vol/me/"));
  });

  it("lists completions with the stem bold, and Tab completes the highlighted one", async () => {
    const { field, source, startEditing } = setup();
    await startEditing();
    fireEvent.change(field(), { target: { value: "/vol/me/do" } });
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "/vol/me/Documents",
      "/vol/me/Downloads",
    ]);
    expect(options[0]!.querySelector("b")!.textContent).toBe("Do");

    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(field().getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    fireEvent.keyDown(field(), { key: "Tab" });
    expect(field().value).toBe("/vol/me/Downloads/");
    expect(source.complete).toHaveBeenLastCalledWith("/vol/me/Downloads/");
  });

  it("Tab with nothing highlighted takes the first", async () => {
    const { field, startEditing } = setup();
    await startEditing();
    fireEvent.change(field(), { target: { value: "/vol/me/d" } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(field(), { key: "Tab" });
    expect(field().value).toBe("/vol/me/Documents/");
  });

  it("Enter on an invalid path stays editing, marked bad", async () => {
    const { field, onNavigate, startEditing, bar } = setup();
    await startEditing();
    fireEvent.change(field(), { target: { value: "/vol/me/nope" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("No such folder");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(bar().dataset.pathBar).toBe("editing");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("Enter commits a typed file, and the bar returns to crumbs", async () => {
    const { field, onNavigate, startEditing, bar } = setup();
    await startEditing();
    fireEvent.change(field(), { target: { value: "/vol/me/notes.md" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith({
        kind: "file",
        path: "/vol/me/notes.md",
      }),
    );
    expect(bar().dataset.pathBar).toBe("crumbs");
  });

  it("Enter commits the highlighted suggestion over the typed text", async () => {
    const { field, onNavigate, startEditing } = setup();
    await startEditing();
    fireEvent.change(field(), { target: { value: "/vol/me/de" } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith({
        kind: "dir",
        path: "/vol/me/Desktop",
      }),
    );
  });

  it("a press on a suggestion commits it", async () => {
    const { field, onNavigate, startEditing } = setup();
    await startEditing();
    fireEvent.change(field(), { target: { value: "/vol/me/c" } });
    const [code] = await screen.findAllByRole("option");
    fireEvent.mouseDown(code!);
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith({
        kind: "dir",
        path: "/vol/me/code",
      }),
    );
  });

  it("Esc and blur revert to the crumbs without navigating", async () => {
    const { field, onNavigate, startEditing, bar } = setup();
    await startEditing();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(bar().dataset.pathBar).toBe("crumbs");

    await startEditing();
    act(() => field().blur());
    expect(bar().dataset.pathBar).toBe("crumbs");
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
