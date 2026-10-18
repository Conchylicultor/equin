import { test, expect } from "bun:test";
import { z } from "zod";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import type { BlockData } from "@plugins/page/plugins/block-entity/core";
import { defineBlock, textBlockSchema } from "../../core";
import { pageBlockHandle } from "../../core/schemas";
import { Editor, resolveBlockHandle } from "./block-registry";
import {
  parseBlockData,
  rekindPageData,
  rewriteBlockData,
} from "./parse-block-data";

// Throwaway handles registered via `collectContributions`, keeping this resolver
// unit test decoupled from any concrete block-type plugin (importing one would form
// a cross-plugin cycle). `empty()` supplies the type's default so the absent-data
// path is observable.
const noteBlock = defineBlock({
  type: "__note__",
  schema: z.object({ title: z.string(), pinned: z.boolean() }),
  empty: () => ({ title: "untitled", pinned: false }),
});

function register(): void {
  collectContributions([
    { id: "note", contributions: [Editor.BlockData(noteBlock)] },
  ]);
}

// `BlockData` is branded so only `parseBlockData` can mint one; widening to the
// plain record it structurally IS lets `toEqual` compare against a literal. An
// annotated upcast, not a cast — the brand must never be forgeable.
function asRecord(data: BlockData): Record<string, unknown> {
  return data;
}

test("valid data parses to canonical output", () => {
  register();
  expect(
    asRecord(parseBlockData("__note__", { title: "hi", pinned: true })),
  ).toEqual({
    title: "hi",
    pinned: true,
  });
});

test("missing required key is a 400", () => {
  register();
  try {
    parseBlockData("__note__", { title: "hi" });
    throw new Error("expected parseBlockData to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  }
});

test("unknown key is a 400 (strict, never stripped)", () => {
  register();
  try {
    parseBlockData("__note__", { title: "hi", pinned: false, junk: 1 });
    throw new Error("expected parseBlockData to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  }
});

test("absent data falls back to the type's empty()", () => {
  register();
  expect(asRecord(parseBlockData("__note__", undefined))).toEqual({
    title: "untitled",
    pinned: false,
  });
});

test("unknown block type is a 400", () => {
  register();
  try {
    parseBlockData("__does_not_exist__", {});
    throw new Error("expected parseBlockData to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  }
});

test("duplicate registration for one type throws loudly", () => {
  collectContributions([
    { id: "a", contributions: [Editor.BlockData(noteBlock)] },
    { id: "b", contributions: [Editor.BlockData(noteBlock)] },
  ]);
  expect(() => resolveBlockHandle("__note__")).toThrow(/Duplicate/);
});

// ── Stage 2: string `data.text` → runs normalization at the write boundary ──
//
// The persisted `data.text` shape is runs-only (`string | RichText` retired). A
// text-bearing type composes `textBlockSchema`; a void type has no `text` field.
// `__void__` mirrors the divider: it must still reject an injected `text` key.

const textBlock = defineBlock({
  type: "__text__",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
});

const voidBlock = defineBlock({
  type: "__void__",
  schema: z.object({}),
  empty: () => ({}),
});

function registerText(): void {
  collectContributions([
    {
      id: "text-blocks",
      contributions: [Editor.BlockData(textBlock), Editor.BlockData(voidBlock)],
    },
  ]);
}

test("string data.text is normalized to a single run", () => {
  registerText();
  expect(asRecord(parseBlockData("__text__", { text: "hello" }))).toEqual({
    text: [{ text: "hello" }],
  });
});

test("empty-string data.text normalizes to []", () => {
  registerText();
  expect(asRecord(parseBlockData("__text__", { text: "" }))).toEqual({
    text: [],
  });
});

test("runs data.text passes through unchanged", () => {
  registerText();
  expect(
    asRecord(
      parseBlockData("__text__", { text: [{ text: "hi", marks: ["bold"] }] }),
    ),
  ).toEqual({ text: [{ text: "hi", marks: ["bold"] }] });
});

test("a MISSING text key on a text-bearing type is a loud 400 (never materialized as [])", () => {
  registerText();
  try {
    // A provided object without `text` must NOT fall back to empty() — only an
    // entirely absent `data` does. The normalizer is `text`-presence-gated.
    parseBlockData("__text__", {});
    throw new Error("expected parseBlockData to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  }
});

test("a void type with an injected string text key is still a 400", () => {
  registerText();
  try {
    parseBlockData("__void__", { text: "" });
    throw new Error("expected parseBlockData to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  }
});

// ── rewriteBlockData: a data edit never changes a row's author ───────────────
//
// The data-edit minting site of the update brand, so every path that rewrites
// an existing row's payload — the op writer, the patch writer, `PATCH
// /api/blocks/:id`, history restore — refuses the same thing here: a data write
// that changes whose words the row holds. The row that decides it per row today
// is a page (`data.author === "agent"`), and its author changes only through
// `rekindPageData`, below.

function registerPage(): void {
  collectContributions([
    {
      id: "page",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(noteBlock),
      ],
    },
  ]);
}

const humanPage = { type: "page", data: { title: "Notes", icon: null } };
const agentPage = {
  type: "page",
  data: { title: "Findings", icon: null, author: "agent" },
};

function expectStatus(fn: () => unknown, status: number): void {
  try {
    fn();
    throw new Error(`expected a ${status}`);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
  }
}

test("a rewrite that keeps the author passes — a title edit carries the marker", () => {
  registerPage();
  expect(
    asRecord(
      rewriteBlockData({
        type: "page",
        before: agentPage,
        next: { ...agentPage.data, title: "Renamed" },
      }),
    ),
  ).toEqual({ ...agentPage.data, title: "Renamed" });
});

test("marking a human's page as agent-authored is a 409", () => {
  registerPage();
  expectStatus(
    () =>
      rewriteBlockData({
        type: "page",
        before: humanPage,
        next: { ...humanPage.data, author: "agent" },
      }),
    409,
  );
});

test("DROPPING the marker from an agent-authored page is a 409 too", () => {
  // A writer that restated `{ title, icon }` without spreading the stored data
  // would take the page away from the agent — as silently as the other way.
  registerPage();
  expectStatus(
    () =>
      rewriteBlockData({
        type: "page",
        before: agentPage,
        next: { title: "Findings", icon: null },
      }),
    409,
  );
});

test("a TYPE change is not judged — turn-into-page is where a page is born", () => {
  registerPage();
  expect(
    asRecord(
      rewriteBlockData({
        type: "page",
        before: { type: "__note__", data: { title: "x", pinned: false } },
        next: { title: "x", icon: null, author: "agent" },
      }),
    ),
  ).toEqual({ title: "x", icon: null, author: "agent" });
});

test("it still validates like parseBlockData — a malformed payload is a 400", () => {
  registerPage();
  expectStatus(
    () =>
      rewriteBlockData({ type: "page", before: agentPage, next: { title: 1 } }),
    400,
  );
});

// ── rekindPageData: the kind change, and nothing else ────────────────────────
//
// The brand's other minter — the whole write of `setPageKind`. It takes no
// payload, only the stored row and the kind to give it, so the flip cannot
// carry any other edit.

/** A page carrying every optional key, so "verbatim" is a real check. */
const decoratedPage = {
  type: "page",
  data: {
    title: "Findings",
    icon: "🚀",
    cover: null,
  },
};

test("human → agent writes the marker and copies every other key verbatim", () => {
  registerPage();
  expect(
    asRecord(
      rekindPageData({ before: decoratedPage, kind: { kind: "agent-page" } }),
    ),
  ).toEqual({ ...decoratedPage.data, author: "agent" });
});

test("agent → human REMOVES the key rather than writing a value", () => {
  registerPage();
  const data = asRecord(
    rekindPageData({
      before: {
        type: "page",
        data: { ...decoratedPage.data, author: "agent" },
      },
      kind: { kind: "page" },
    }),
  );
  expect(data).toEqual(decoratedPage.data);
  expect("author" in data).toBe(false);
});

test("setting the author a page already has is an identity on its data", () => {
  registerPage();
  expect(
    asRecord(
      rekindPageData({ before: agentPage, kind: { kind: "agent-page" } }),
    ),
  ).toEqual(agentPage.data);
  expect(
    asRecord(rekindPageData({ before: humanPage, kind: { kind: "page" } })),
  ).toEqual(humanPage.data);
});

test("a non-page row is refused (400), never written", () => {
  registerPage();
  expectStatus(
    () =>
      rekindPageData({
        before: { type: "__note__", data: { title: "x", pinned: false } },
        kind: { kind: "agent-page" },
      }),
    400,
  );
});

test("the flip still cannot ride a data edit — rewriteBlockData refuses it both ways", () => {
  // The pair keeps the two changes apart: what `rekindPageData` produces is
  // exactly what a data edit may NOT say.
  registerPage();
  const flipped = asRecord(
    rekindPageData({ before: humanPage, kind: { kind: "agent-page" } }),
  );
  expectStatus(
    () => rewriteBlockData({ type: "page", before: humanPage, next: flipped }),
    409,
  );
  const unflipped = asRecord(
    rekindPageData({ before: agentPage, kind: { kind: "page" } }),
  );
  expectStatus(
    () =>
      rewriteBlockData({ type: "page", before: agentPage, next: unflipped }),
    409,
  );
});

// ── instructions pages: a third kind, exclusive with the agent's ─────────────

const instructionsPage = {
  type: "page",
  data: { title: "Track rules", icon: null, instructions: true },
};

test("turning a human's page into an instructions page by a data edit is a 409", () => {
  registerPage();
  expectStatus(
    () =>
      rewriteBlockData({
        type: "page",
        before: humanPage,
        next: { ...humanPage.data, instructions: true },
      }),
    409,
  );
});

test("dropping `instructions` by a data edit is a 409 too", () => {
  registerPage();
  expectStatus(
    () =>
      rewriteBlockData({
        type: "page",
        before: instructionsPage,
        next: { title: "Track rules", icon: null },
      }),
    409,
  );
});

test("a title edit on an instructions page carries the marker and passes", () => {
  registerPage();
  expect(
    asRecord(
      rewriteBlockData({
        type: "page",
        before: instructionsPage,
        next: { ...instructionsPage.data, title: "Renamed" },
      }),
    ),
  ).toEqual({ ...instructionsPage.data, title: "Renamed" });
});

test("an agent page that is also an instructions page is refused at the boundary (400)", () => {
  registerPage();
  expectStatus(
    () =>
      parseBlockData("page", {
        title: "x",
        icon: null,
        author: "agent",
        instructions: true,
      }),
    400,
  );
});

test("`global` without `instructions` is refused at the boundary (400)", () => {
  registerPage();
  expectStatus(
    () => parseBlockData("page", { title: "x", icon: null, global: true }),
    400,
  );
});

test("rekind to instructions replaces the author and writes `global` only when true", () => {
  registerPage();
  expect(
    asRecord(
      rekindPageData({
        before: agentPage,
        kind: { kind: "instructions", global: false },
      }),
    ),
  ).toEqual({ title: "Findings", icon: null, instructions: true });
  expect(
    asRecord(
      rekindPageData({
        before: humanPage,
        kind: { kind: "instructions", global: true },
      }),
    ),
  ).toEqual({ ...humanPage.data, instructions: true, global: true });
});
