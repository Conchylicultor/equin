import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import * as Y from "yjs";
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  createEditor,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { LinkNode } from "@lexical/link";
import {
  createBinding,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
  type Provider,
  type ProviderAwareness,
} from "@lexical/yjs";
import {
  editYDocState,
  yDocContent,
} from "@plugins/primitives/plugins/collab-doc/core";
import {
  $spliceRunsInto,
  runsToXmlText,
  xmlTextToRuns,
  type RichText,
} from "../../core";
import { corpusTokenNode } from "../../core/runs-corpus";
import {
  blockTextRunsOptions,
  blockTextTokenExtension,
  registerBlockTextExtension,
} from "./block-text-extensions";
import { projectableRunsOf } from "./doc-sourced-runs";
import {
  BindingReplica,
  CanonicalConnection,
  type CanonicalProviderPort,
} from "./binding-replica";
import { BlockRunTracker, type BlockRunsEdit } from "./block-run-tracker";
import { spliceOpenBlockDoc, TEXT_REPLAY_ORIGIN } from "./block-text-write";
import {
  undoConflictReportSink,
  type UndoConflictReport,
} from "./undo-conflict-report";

/**
 * The run tracker (`block-run-tracker.ts`) on a real `Y.Doc`: run boundaries
 * (one `BlockRunsEdit` per idle window, `before`/`after` exact), the stated
 * three-origin rule (a provider apply mid-run aborts and reports, the replay
 * origin opens no run), the `untracked` suppression scope, a run opened from
 * INSIDE a relayed binding transaction (headless editor + `createBinding` +
 * `BindingReplica` — the nested `editor.update` path), and marks and tokens
 * surviving capture → `spliceOpenBlockDoc` replay.
 *
 * Run with `./equin test plugins/page/plugins/editor/web/internal`.
 */

const IDLE_MS = 30;
const PROVIDER = { provider: true };
const BINDING = { binding: true };

/** The doc's runs, widened off the projection brand so `toEqual` can compare them. */
const runsIn = (doc: Y.Doc): RichText => projectableRunsOf(doc);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A canonical doc seeded from `runs` through the registry-bound bridge. */
function seededDoc(runs: RichText): Y.Doc {
  const doc = runsToXmlText(runs, blockTextRunsOptions()).doc;
  if (!doc) throw new Error("seed XmlText is not attached to a doc");
  return doc;
}

/** Bring `doc` to `runs` under `origin` — what a binding relay or a server apply looks like on the wire. */
function applyAs(doc: Y.Doc, origin: unknown, runs: RichText): void {
  const opts = blockTextRunsOptions();
  const delta = editYDocState(
    Y.encodeStateAsUpdate(doc),
    () => $spliceRunsInto(runs, opts.extensions),
    { nodes: [LinkNode, ...opts.nodes] },
  );
  Y.applyUpdate(doc, delta, origin);
}

function trackerOn(
  doc: Y.Doc,
  blockId = "b1",
): { tracker: BlockRunTracker; edits: BlockRunsEdit[] } {
  const tracker = new BlockRunTracker({
    blockId,
    doc,
    providerOrigin: PROVIDER,
    runsNow: () => projectableRunsOf(doc),
    idleMs: IDLE_MS,
  });
  const edits: BlockRunsEdit[] = [];
  tracker.onRunsEdit((e) => edits.push(e));
  return { tracker, edits };
}

// The corpus token, registered so the registry-bound bridge (`runsNow`, the
// splice) materializes `[[tok-…]]` as a decorator — the shape a real page
// link or date chip takes. Unregistered at the end so nothing leaks past this
// file.
let unregisterToken: () => void = () => {};
beforeAll(() => {
  unregisterToken = registerBlockTextExtension(
    blockTextTokenExtension({
      id: "test-token",
      node: corpusTokenNode,
      pattern: /\[\[(tok-[a-z0-9]+)\]\]/,
      markdownSpan: "transparent",
      renderToken: ({ tokenId }) => tokenId,
    }),
  );
});
afterAll(() => unregisterToken());

const reports: UndoConflictReport[] = [];
beforeEach(() => {
  reports.length = 0;
  undoConflictReportSink.register((r) => {
    reports.push(r);
  });
});
afterEach(() => undoConflictReportSink.register(null));

describe("run boundaries", () => {
  test("one BlockRunsEdit per idle window, before/after exact", async () => {
    const doc = seededDoc([{ text: "seed" }]);
    const { tracker, edits } = trackerOn(doc);
    try {
      applyAs(doc, BINDING, [{ text: "seed a" }]);
      applyAs(doc, BINDING, [{ text: "seed ab" }]);
      expect(tracker.hasOpenRun).toBe(true);
      expect(edits).toHaveLength(0);
      await sleep(IDLE_MS * 2);
      expect(tracker.hasOpenRun).toBe(false);
      expect(edits).toEqual([
        {
          blockId: "b1",
          before: [{ text: "seed" }],
          after: [{ text: "seed ab" }],
        },
      ]);

      applyAs(doc, BINDING, [{ text: "seed abc" }]);
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(2);
      expect(edits[1]).toEqual({
        blockId: "b1",
        before: [{ text: "seed ab" }],
        after: [{ text: "seed abc" }],
      });
    } finally {
      tracker.dispose();
    }
  });

  test("each local update re-arms the idle window", async () => {
    const doc = seededDoc([{ text: "" }]);
    const { tracker, edits } = trackerOn(doc);
    try {
      let text = "";
      for (let i = 0; i < 5; i++) {
        text += "x";
        applyAs(doc, BINDING, [{ text }]);
        await sleep(IDLE_MS / 2);
      }
      expect(edits).toHaveLength(0);
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(1);
      expect(edits[0]!.after).toEqual([{ text: "xxxxx" }]);
    } finally {
      tracker.dispose();
    }
  });

  test("closeRun seals a run early and is idempotent", async () => {
    const doc = seededDoc([{ text: "a" }]);
    const { tracker, edits } = trackerOn(doc);
    try {
      applyAs(doc, BINDING, [{ text: "ab" }]);
      tracker.closeRun();
      tracker.closeRun();
      expect(edits).toHaveLength(1);
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(1);
    } finally {
      tracker.dispose();
    }
  });

  test("a run that changes nothing emits nothing", async () => {
    const doc = seededDoc([{ text: "a" }]);
    const { tracker, edits } = trackerOn(doc);
    try {
      applyAs(doc, BINDING, [{ text: "ab" }]);
      applyAs(doc, BINDING, [{ text: "a" }]);
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(0);
    } finally {
      tracker.dispose();
    }
  });

  test("a local transaction that integrates nothing leaves no run open", () => {
    const doc = seededDoc([{ text: "a" }]);
    const { tracker } = trackerOn(doc);
    try {
      doc.transact(() => {}, BINDING);
      expect(tracker.hasOpenRun).toBe(false);
      // …so a later provider apply is not an "abort" of anything.
      applyAs(doc, PROVIDER, [{ text: "remote" }]);
      expect(reports).toHaveLength(0);
    } finally {
      tracker.dispose();
    }
  });
});

describe("the three origins", () => {
  test("a provider-origin apply mid-run aborts the run and reports it", async () => {
    const doc = seededDoc([{ text: "seed" }]);
    const { tracker, edits } = trackerOn(doc);
    try {
      applyAs(doc, BINDING, [{ text: "seed x" }]);
      expect(tracker.hasOpenRun).toBe(true);
      applyAs(doc, PROVIDER, [{ text: "seed x + remote" }]);
      expect(tracker.hasOpenRun).toBe(false);
      expect(reports).toEqual([
        {
          reason: "run-aborted",
          blockId: "b1",
          direction: null,
          expectedLength: "seed".length,
          actualLength: "seed x + remote".length,
        },
      ]);
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(0);
    } finally {
      tracker.dispose();
    }
  });

  test("a provider-origin apply with no run open is not a conflict", () => {
    const doc = seededDoc([{ text: "seed" }]);
    const { tracker } = trackerOn(doc);
    try {
      applyAs(doc, PROVIDER, [{ text: "remote" }]);
      expect(tracker.hasOpenRun).toBe(false);
      expect(reports).toHaveLength(0);
    } finally {
      tracker.dispose();
    }
  });

  test("the replay origin opens no run", async () => {
    const doc = seededDoc([{ text: "seed" }]);
    const { tracker, edits } = trackerOn(doc);
    try {
      spliceOpenBlockDoc({ doc }, [{ text: "replayed" }]);
      expect(tracker.hasOpenRun).toBe(false);
      applyAs(doc, TEXT_REPLAY_ORIGIN, [{ text: "replayed again" }]);
      expect(tracker.hasOpenRun).toBe(false);
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(0);
      expect(reports).toHaveLength(0);
    } finally {
      tracker.dispose();
    }
  });
});

describe("untracked(edit)", () => {
  test("emits nothing for the transactions inside the scope", async () => {
    const doc = seededDoc([{ text: "seed" }]);
    const { tracker, edits } = trackerOn(doc);
    try {
      const out = tracker.untracked(() => {
        applyAs(doc, BINDING, [{ text: "surgery" }]);
        return 42;
      });
      expect(out).toBe(42);
      expect(tracker.hasOpenRun).toBe(false);
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(0);
      // The doc DID change; only the recording was suppressed.
      expect(runsIn(doc)).toEqual([{ text: "surgery" }]);
    } finally {
      tracker.dispose();
    }
  });

  test("closes an open run first, then suppresses", async () => {
    const doc = seededDoc([{ text: "seed" }]);
    const { tracker, edits } = trackerOn(doc);
    try {
      applyAs(doc, BINDING, [{ text: "seed typed" }]);
      tracker.untracked(() =>
        applyAs(doc, BINDING, [{ text: "seed typed|cut" }]),
      );
      expect(edits).toEqual([
        {
          blockId: "b1",
          before: [{ text: "seed" }],
          after: [{ text: "seed typed" }],
        },
      ]);
      // Typing after the scope opens a fresh run from the post-surgery state.
      applyAs(doc, BINDING, [{ text: "seed typed|cut more" }]);
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(2);
      expect(edits[1]!.before).toEqual([{ text: "seed typed|cut" }]);
    } finally {
      tracker.dispose();
    }
  });
});

describe("marks and tokens", () => {
  test("survive capture → spliceOpenBlockDoc round trip", async () => {
    const seed: RichText = [
      { text: "bold ", marks: ["bold"] },
      { text: "[[tok-a1]]" },
      { text: " and ", marks: ["italic"] },
      { text: "link", link: "https://example.com" },
    ];
    const doc = seededDoc(seed);
    const { tracker, edits } = trackerOn(doc);
    try {
      expect(runsIn(doc)).toEqual(seed);
      const typed: RichText = [
        { text: "bold ", marks: ["bold"] },
        { text: "[[tok-a1]]" },
        { text: " and ", marks: ["italic"] },
        { text: "link", link: "https://example.com" },
        { text: " typed" },
      ];
      applyAs(doc, BINDING, typed);
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(1);
      const edit = edits[0]!;
      expect(edit.before).toEqual(seed);
      expect(edit.after).toEqual(typed);

      // Undo: replay `before` onto the open doc.
      spliceOpenBlockDoc({ doc }, edit.before);
      expect(runsIn(doc)).toEqual(seed);
      // Redo: replay `after`.
      spliceOpenBlockDoc({ doc }, edit.after);
      expect(runsIn(doc)).toEqual(typed);
      // Neither replay opened a run.
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(1);
    } finally {
      tracker.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// A real Lexical binding on a BindingReplica, relaying into the canonical
// ---------------------------------------------------------------------------

function noopProvider(): Provider {
  const awareness: ProviderAwareness = {
    getLocalState: () => null,
    getStates: () => new Map(),
    off: () => {},
    on: () => {},
    setLocalState: () => {},
    setLocalStateField: () => {},
  };
  return {
    awareness,
    connect: () => {},
    disconnect: () => {},
    off: () => {},
    on: () => {},
  };
}

/**
 * A headless editor bound to `replicaDoc` the way `CollaborationPlugin` binds
 * — the `observeDeep` hydration observer plus the update listener that syncs
 * Lexical edits into the doc under the BINDING as origin.
 */
function bindHeadlessEditor(
  replicaDoc: Y.Doc,
  nodes: Klass<LexicalNode>[],
): LexicalEditor {
  const editor = createEditor({
    namespace: "test-binding",
    nodes,
    onError: (e) => {
      throw e;
    },
  });
  const provider = noopProvider();
  const binding = createBinding(
    editor,
    provider,
    "test-binding",
    replicaDoc,
    new Map([["test-binding", replicaDoc]]),
  );
  binding.root.getSharedType().observeDeep((events, transaction) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexical(
        binding,
        provider,
        events as Parameters<typeof syncYjsChangesToLexical>[2],
        false,
      );
    }
  });
  editor.registerUpdateListener(
    ({
      prevEditorState,
      editorState,
      dirtyElements,
      dirtyLeaves,
      normalizedNodes,
      tags,
    }) => {
      syncLexicalUpdateToYjs(
        binding,
        provider,
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      );
    },
  );
  return editor;
}

/** One keystroke: append `ch` to the paragraph's last text node, committed discretely. */
function typeChar(editor: LexicalEditor, ch: string): void {
  editor.update(
    () => {
      const para = $getRoot().getChildren().find($isElementNode);
      if (!para) throw new Error("no paragraph to type into");
      const last = para.getLastChild();
      if ($isTextNode(last)) last.setTextContent(last.getTextContent() + ch);
      else para.append($createTextNode(ch));
    },
    { discrete: true },
  );
}

/** Commit whatever the hydration observer queued (its update is a microtask). */
function settle(editor: LexicalEditor): void {
  editor.update(() => {}, { discrete: true });
}

class FakeTransport implements CanonicalProviderPort {
  connect(): void {}
  disconnect(): void {}
  on(): void {}
  off(): void {}
}

describe("a run opened from inside a relayed binding transaction", () => {
  test("the nested editor.update path opens, extends and closes a run", async () => {
    const canonical = seededDoc([{ text: "seed" }]);
    const { tracker, edits } = trackerOn(canonical);
    const transport = new FakeTransport();
    const replica = new BindingReplica(
      canonical,
      transport,
      new CanonicalConnection(transport),
    );
    try {
      const editor = bindHeadlessEditor(replica.replicaDoc, [
        LinkNode,
        ...blockTextRunsOptions().nodes,
      ]);
      replica.connect(); // catch-up state relays in post-attach
      settle(editor);
      expect(tracker.hasOpenRun).toBe(false);
      expect(
        xmlTextToRuns(yDocContent(replica.replicaDoc), blockTextRunsOptions()),
      ).toEqual([{ text: "seed" }]);

      typeChar(editor, "x");
      // The relay's canonical transaction carries the binding origin, so the
      // run opened INSIDE that transaction — with `before` read at its start.
      expect(tracker.hasOpenRun).toBe(true);
      typeChar(editor, "y");
      await sleep(IDLE_MS * 2);
      expect(edits).toEqual([
        {
          blockId: "b1",
          before: [{ text: "seed" }],
          after: [{ text: "seedxy" }],
        },
      ]);

      // And a replay onto the canonical renders in the binding.
      spliceOpenBlockDoc({ doc: canonical }, edits[0]!.before);
      settle(editor);
      expect(
        xmlTextToRuns(yDocContent(replica.replicaDoc), blockTextRunsOptions()),
      ).toEqual([{ text: "seed" }]);
      await sleep(IDLE_MS * 2);
      expect(edits).toHaveLength(1);
      expect(reports).toHaveLength(0);
    } finally {
      replica.destroy();
      tracker.dispose();
    }
  });
});
