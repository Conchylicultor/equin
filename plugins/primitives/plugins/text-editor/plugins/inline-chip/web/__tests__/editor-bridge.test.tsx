import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { TextEditor } from "@plugins/primitives/plugins/text-editor/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
// The BARREL, not the internals: importing it is what registers inline-chip's
// lazy node-extension source with the editor, which is exactly the wiring under
// test. Declaring the chip below is then the only thing the fixture does.
import { InlineChip, inlineChip } from "../index";

// Proves the editor bridge: an inline chip renders as a chip *inside the Lexical
// editor* (not just on read surfaces), driven entirely by the generic
// union-pattern node — no per-chip Lexical wiring. Uses a throwaway chip so the
// test doesn't couple inline-chip to any specific contributor.
function TestChip({
  content,
}: {
  content: string;
  attrs: Record<string, string>;
}) {
  return <button data-testid="chip">{content}</button>;
}

const plugin = {
  id: "editor-bridge-test",
  description: "editor bridge fixture",
  contributions: [
    InlineChip.Tag(
      inlineChip({
        id: "editor-bridge-test-chip",
        pattern: /@mention-\w+/g,
        surfaces: ["transcript"],
        modelText: "self-describing",
        component: TestChip,
      }),
    ),
  ],
} as unknown as LoadedPlugin;

afterEach(cleanup);

// The chip appears only after Lexical mounts and decorates the initial state —
// several async ticks. testing-library's default `findBy` window is 1s, which
// holds when this file runs alone but not when it shares the host with the rest
// of the DOM suite (whole-suite runs failed here on a mid-init empty editor).
const MOUNT_TIMEOUT = { timeout: 10_000 };

describe("inline chips render as chips in the Lexical editor", () => {
  it("deserializes an inline token into a chip via the generic node bridge", async () => {
    render(
      <PluginProvider plugins={[plugin]}>
        <TextEditor
          keep={transient("test")}
          value="hi @mention-bob there"
          onChange={() => {}}
        />
      </PluginProvider>,
    );
    // The token becomes a decorator chip; its component renders.
    const chip = await screen.findByTestId("chip", undefined, MOUNT_TIMEOUT);
    expect(chip.textContent).toBe("@mention-bob");
  });

  it("shows a generic Remove affordance on the chip when the editor is editable", async () => {
    render(
      <PluginProvider plugins={[plugin]}>
        <TextEditor
          keep={transient("test")}
          value="hi @mention-bob there"
          onChange={() => {}}
        />
      </PluginProvider>,
    );
    await screen.findByTestId("chip", undefined, MOUNT_TIMEOUT);
    // The bridge wraps every inline chip in a generic × removal affordance.
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("omits the Remove affordance when the editor is read-only", async () => {
    render(
      <PluginProvider plugins={[plugin]}>
        <TextEditor
          keep={transient("test")}
          value="hi @mention-bob there"
          onChange={() => {}}
          disabled
        />
      </PluginProvider>,
    );
    // The chip still renders, but no removal × in a non-editable editor (mirrors
    // read surfaces, which render the contribution directly without the bridge).
    await screen.findByTestId("chip", undefined, MOUNT_TIMEOUT);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
