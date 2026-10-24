import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  createPluginRegistry,
  PluginProvider,
} from "@plugins/framework/plugins/web-sdk/core";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  Markdown,
  MarkdownEnhancerSlot,
} from "@plugins/primitives/plugins/markdown/web";
import {
  InlineText,
  InlineTextWalkerSlot,
} from "@plugins/primitives/plugins/inline-text/web";
import { FileLinksWorkspaceProvider } from "@plugins/primitives/plugins/file-links/web";
import { FileLinksEnhancer } from "../internal/file-links-enhancer";
import { FileLinksInlineWalker } from "../internal/file-links-inline-walker";
import { CodeEnhancer } from "../internal/code-enhancer";
import { ImgEnhancer } from "../internal/img-enhancer";

// The enhancers are rendered with NO PaneSurfaceProvider anywhere — the global
// chrome case (a Core.Root card hosting an agent thread). They must not read
// the pane route: the checkout comes from FileLinksWorkspaceProvider only.

afterEach(() => cleanup());

function Plugins({ children }: { children: ReactNode }) {
  const registry = createPluginRegistry();
  registry.append([
    {
      id: asPluginId("conversations/conversation-view/markdown-extensions"),
      description: "test",
      contributions: [
        MarkdownEnhancerSlot({
          id: "file-links",
          order: 10,
          Component: FileLinksEnhancer,
        }),
        MarkdownEnhancerSlot({
          id: "code-inline",
          order: 20,
          Component: CodeEnhancer,
        }),
        MarkdownEnhancerSlot({
          id: "img-proxy",
          order: 30,
          Component: ImgEnhancer,
        }),
        InlineTextWalkerSlot({
          id: "file-links",
          order: 10,
          Component: FileLinksInlineWalker,
        }),
      ],
    },
  ]);
  return (
    <PluginProvider
      registry={registry}
      composition={{ id: "test", home: null }}
    >
      {children}
    </PluginProvider>
  );
}

const TEXT = "See research/foo.md and `plugins/x/web/index.ts:12`.";

describe("file links outside every pane surface", () => {
  it("Markdown renders paths as plain text with no provider", async () => {
    render(
      <Plugins>
        <Markdown>{TEXT}</Markdown>
      </Plugins>,
    );
    expect(await screen.findByText(/research\/foo\.md/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("Markdown links paths inside a FileLinksWorkspaceProvider", async () => {
    render(
      <Plugins>
        <FileLinksWorkspaceProvider workspace="main">
          <Markdown>{TEXT}</Markdown>
        </FileLinksWorkspaceProvider>
      </Plugins>,
    );
    // Both the prose path and the inline-code path become file-peek chips
    // (LinkChip buttons carrying the link gestures).
    expect(
      await screen.findByRole("button", { name: "research/foo.md" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "plugins/x/web/index.ts:12" }),
    ).toBeTruthy();
  });

  it("an undefined workspace (host not known yet) keeps paths plain", async () => {
    render(
      <Plugins>
        <FileLinksWorkspaceProvider workspace="main">
          <FileLinksWorkspaceProvider workspace={undefined}>
            <Markdown>{TEXT}</Markdown>
          </FileLinksWorkspaceProvider>
        </FileLinksWorkspaceProvider>
      </Plugins>,
    );
    expect(await screen.findByText(/research\/foo\.md/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("InlineText follows the same scope", () => {
    const { unmount } = render(
      <Plugins>
        <InlineText text="open research/foo.md" />
      </Plugins>,
    );
    expect(screen.getByText(/research\/foo\.md/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    render(
      <Plugins>
        <FileLinksWorkspaceProvider workspace="main">
          <InlineText text="open research/foo.md" />
        </FileLinksWorkspaceProvider>
      </Plugins>,
    );
    expect(
      screen.getByRole("button", { name: "research/foo.md" }),
    ).toBeTruthy();
  });
});
