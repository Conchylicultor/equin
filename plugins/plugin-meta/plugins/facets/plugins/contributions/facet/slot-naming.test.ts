import { describe, expect, test } from "bun:test";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { declarePluginSlots } from "@plugins/framework/plugins/slot-declaration/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { ExtractContext } from "@plugins/plugin-meta/plugins/facets/core";
import type { ContributionsFacetData } from "../core";
import contributionsFacet from "./index";

// These tests replace a guard that no longer exists. The facet used to throw
// when it was handed barrels in a process where no slot-declaration pass had
// run, because reading a derived `contributions` array that early answers with a
// silently smaller set. The barrels and the naming of the pass over them now
// arrive as ONE value (`ExtractContext.imported`), so that state is unspellable
// and there is nothing left to assert.
//
// What is worth testing instead is what the facet DOES with that naming — and
// note what is no longer true of these tests: not one of them depends on how
// many passes have run in this process. Each mints its own naming and reads
// answers only out of that one. Process-global state deciding a reader's answer
// is the disease the pairing cures; a test that reintroduced the dependency
// would be testing the thing that was removed.

// A plugin dir that cannot exist, so the static half of `extract` reads no files
// and the tests stay hermetic — no tree build, no barrel imports, no disk.
const ctx = (imported: ExtractContext["imported"]): ExtractContext => ({
  dir: "/nonexistent/plugin-dir-for-slot-naming-test",
  pluginId: "slot.naming.test",
  imported,
});

/**
 * A slot as `isSlot` recognises one: a callable carrying `useContributions` and
 * `meta`. Built by hand rather than via `defineRenderSlot` so this file keeps
 * the leaf's import graph — no web-sdk, no React.
 */
const makeSlot = (): SlotHandle =>
  Object.assign(function slot() {}, {
    useContributions: () => [],
    meta: { kind: "render", reorderable: true } satisfies SlotHandle["meta"],
  }) as unknown as SlotHandle;

const OWNER = "owner.plugin" as PluginId;

const oneWebBarrel = (contributions: unknown[]) => [
  {
    mod: { default: { contributions } },
    runtime: "web" as const,
  },
];

const extract = (imported: ExtractContext["imported"]) =>
  contributionsFacet.extract(ctx(imported)) as ContributionsFacetData;

describe("contributions facet: slot ids come from the paired naming", () => {
  test("a contribution's slot id is the one this pass settled", () => {
    const target = makeSlot();
    const naming = declarePluginSlots(
      [{ id: OWNER, slots: { section: target } }],
      "source",
    );

    expect(
      extract({ modules: oneWebBarrel([{ _slot: target }]), naming }).runtime,
    ).toEqual([
      {
        kind: "slot",
        slotId: "owner.plugin.section",
        componentName: undefined,
        doc: {},
        id: undefined,
      },
    ]);
  });

  test("a slot this pass did not name is skipped, not emitted under a guessed id", () => {
    const declared = makeSlot();
    const stranger = makeSlot();
    // `stranger` is declared by nobody in this pass, so `idOf` answers
    // `out-of-scope`. Under the source scope the plugin tree runs, that means no
    // plugin declares it anywhere — an orphan, which the build-time orphan guard
    // owns and reports; the facet must not invent a name for it.
    const naming = declarePluginSlots(
      [{ id: OWNER, slots: { section: declared } }],
      "source",
    );

    expect(
      extract({ modules: oneWebBarrel([{ _slot: stranger }]), naming }).runtime,
    ).toEqual([]);
  });

  test("a naming answers only for its own pass, whatever else has been declared since", () => {
    const target = makeSlot();
    const first = declarePluginSlots(
      [{ id: OWNER, slots: { early: target } }],
      "source",
    );
    // A later pass over a different plugin set re-stamps the shared slot object.
    // The first naming holds its own map, so its answer does not move — which is
    // what lets two checks run concurrently and still each read the truth.
    declarePluginSlots(
      [{ id: "other.plugin" as PluginId, slots: { late: target } }],
      "source",
    );

    expect(
      extract({ modules: oneWebBarrel([{ _slot: target }]), naming: first })
        .runtime[0]?.slotId,
    ).toBe("owner.plugin.early");
  });

  test("a server registration carries no slot, so the naming never enters into it", () => {
    const naming = declarePluginSlots([], "source");

    expect(
      extract({
        modules: oneWebBarrel([{ _kind: Symbol("page.block-data") }]),
        naming,
      }).runtime,
    ).toEqual([
      {
        kind: "server",
        slotId: "page.block-data",
        doc: {},
        id: undefined,
      },
    ]);
  });

  test("a barrel-free extraction is untouched — no modules, nothing to read", () => {
    // The static half scans a plugin dir that cannot exist, so the locally
    // scanned join inputs (panes, routes, the barrel's pane imports) are empty
    // too — this ctx has no files at all, not merely no barrels.
    const empty = {
      static: [],
      runtime: [],
      panes: [],
      routes: [],
      paneRefs: {},
      serverCompanionKinds: [],
      serverCompanions: [],
    };
    expect(
      extract({ modules: [], naming: declarePluginSlots([], "source") }),
    ).toEqual(empty);
    expect(extract(undefined)).toEqual(empty);
  });
});
