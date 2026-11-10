import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import type { PageData } from "@plugins/page/plugins/editor/core";
import {
  PageReference,
  usePageReferenceTint,
  type PageReferenceChipProps,
} from "../index";
import { usePageReferenceDecoration } from "../internal/decoration";

// The decoration seam's two reads, against a fixture kind of page. The renderers
// (sub-page row, Pages sidebar) name no kind, so this is where "which kind wins"
// and "no kind at all" are pinned.

function Chip({ pageId }: PageReferenceChipProps) {
  return <span>{`chip for ${pageId}`}</span>;
}

const plugins = [
  // The slot's declaring plugin, so the slot has an id to isolate under.
  {
    id: "page.page-reference",
    description: "declares PageReference",
    slots: PageReference,
    contributions: [],
  },
  {
    id: "page.decoration-fixture",
    description: "two kinds of page",
    contributions: [
      PageReference.Decoration({
        applies: (page) => page.author === "agent",
        tint: "bg-info/10",
        component: Chip,
      }),
      PageReference.Decoration({
        applies: (page) => page.title === "Pinned",
        tint: "bg-muted",
      }),
    ],
  },
] as unknown as LoadedPlugin[];

function page(over: Partial<PageData>): PageData {
  return { title: "A page", icon: null, ...over };
}

function Probe({ data }: { data: PageData }) {
  const decoration = usePageReferenceDecoration("page-1", data);
  const tintOf = usePageReferenceTint();
  return (
    <div
      data-testid="probe"
      data-tint={decoration?.tint ?? "none"}
      data-list-tint={tintOf(data) ?? "none"}
    >
      {decoration?.chip}
    </div>
  );
}

function renderProbe(data: PageData) {
  render(
    <PluginProvider plugins={plugins}>
      <Probe data={data} />
    </PluginProvider>,
  );
  return screen.getByTestId("probe");
}

afterEach(cleanup);

describe("usePageReferenceDecoration / usePageReferenceTint", () => {
  it("paints a page of a decorated kind with its tint and its chip", () => {
    const probe = renderProbe(page({ author: "agent" }));
    expect(probe.dataset.tint).toBe("bg-info/10");
    expect(probe.dataset.listTint).toBe("bg-info/10");
    // The chip is handed the referenced page's id, rendered through the slot.
    expect(probe.textContent).toBe("chip for page-1");
  });

  it("leaves a page of no decorated kind exactly as it was", () => {
    const probe = renderProbe(page({}));
    expect(probe.dataset.tint).toBe("none");
    expect(probe.dataset.listTint).toBe("none");
    expect(probe.textContent).toBe("");
  });

  it("gives a decoration with no chip a tint and a null chip", () => {
    const probe = renderProbe(page({ title: "Pinned" }));
    expect(probe.dataset.tint).toBe("bg-muted");
    expect(probe.textContent).toBe("");
  });

  it("picks the FIRST decoration that applies, in registration order", () => {
    const probe = renderProbe(page({ title: "Pinned", author: "agent" }));
    expect(probe.dataset.tint).toBe("bg-info/10");
    expect(probe.dataset.listTint).toBe("bg-info/10");
  });
});
