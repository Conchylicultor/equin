import { lazyComponent } from "@plugins/primitives/plugins/lazy-component/web";
import type { TextEditorProps } from "./text-editor-impl";

// Code-splits the heavy Lexical bundle (~186KB) off the eager plugin-boot wave:
// the impl chunk (and all `@lexical/*` deps) loads on first mount instead. This
// is an inline editor (compose bar, task description), so the fallback is `null`
// — it pops in with no spinner flash; React.lazy caches the module so only the
// first mount in a session suspends.
//
// Preloaded once the page is idle: the editor is in every app (the Wish
// popover, compose bars), and a first mount that suspends opens its host
// without it — the Wish popover drew header and footer only, then grew by the
// editor's height ~1 s later (the import takes 0.3-1.2 s).
export const TextEditor = lazyComponent<TextEditorProps>(
  () => import("./text-editor-impl").then((m) => ({ default: m.TextEditor })),
  { fallback: null, preload: "idle" },
);
