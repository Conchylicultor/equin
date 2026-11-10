/**
 * An inline chip (a `task-…` id) inside an inline `<go>` in a reply renders as
 * its chip: the walkers leave the tag's custom element opaque, so the tag runs
 * the markdown transforms on its own words.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import {
  InlineChip,
  inlineChip,
} from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/web";
import { activeDataPlugin } from "@plugins/active-data/web/testing";
import { loadLazyComponents } from "@plugins/primitives/plugins/lazy-component/web/testing";
import { goPlugin } from "../testing";

beforeAll(loadLazyComponents);
afterEach(cleanup);

function Chip({ content }: { content: string }) {
  return <button type="button">{content.replace("chip-", "Chip ")}</button>;
}

const chipPlugin = {
  id: "go-chips-test",
  description: "an inline chip fixture",
  contributions: [
    InlineChip.Tag(
      inlineChip({
        id: "go-chips-test-chip",
        pattern: /chip-\w+/g,
        surfaces: ["transcript"],
        modelText: "self-describing",
        component: Chip,
      }),
    ),
  ],
} as unknown as LoadedPlugin;

describe("an inline <go> in a reply", () => {
  it("renders the inline chips among its words", async () => {
    render(
      <PluginProvider plugins={[activeDataPlugin, goPlugin, chipPlugin]}>
        <Markdown>{"Should I <go>let chip-abc implement it</go>?"}</Markdown>
      </PluginProvider>,
    );
    expect((await screen.findByText("Chip abc")).tagName).toBe("BUTTON");
  });
});
