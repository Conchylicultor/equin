/**
 * Tests for the `no-adhoc-caret-trigger` lint rule. Run with `bun test`.
 *
 * The rule flags two shapes:
 *
 * 1. The hand-rolled caret-menu shape: scanning editor text for a trigger
 *    (`lastIndexOf` / `indexOf`) from inside a Lexical `registerUpdateListener`.
 *    Either half alone is legitimate — a bare update listener is how the markdown
 *    shortcuts and the doc→row projection subscribe, and a bare `indexOf` is just
 *    string work — so only the conjunction fires.
 * 2. The half-adoption shape: importing the caret-menu PANEL (`CaretTriggerMenu`
 *    from the caret-trigger barrel, or `FloatingSurface` from the
 *    floating-surface barrel) without calling `useCaretMenu`, i.e. a caret menu
 *    with no keyboard model.
 */

import rule from "./no-adhoc-caret-trigger";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-caret-trigger", rule, {
  valid: [
    // An update listener with no text scan — the format toolbar / markdown shortcuts.
    `editor.registerUpdateListener(() => { const sel = $getSelection(); });`,
    // A text scan with no update listener — insertLink locating the trigger to replace.
    `const idx = full.slice(0, caretOffset).lastIndexOf("[[");`,
    // The sanctioned consumer shape: no listener, no scan.
    `const caret = useCaretQuery({ id: "slash", trigger: "/" });`,
    // Full adoption — the surface import is paired with the keyboard model.
    `
    import { CaretTriggerMenu, useCaretMenu, useCaretQuery } from "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web";
    const caret = useCaretQuery({ id: "slash", trigger: "/" });
    const { surfaceOpen, commit } = useCaretMenu(caret, { itemCount: n, onCommit: pick });
    `,
      // Ditto via the FORCED producer (external open signal: a paste, a button).
      `
    import { CaretTriggerMenu, useCaretMenu, useForcedCaretQuery } from "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web";
    const caret = useForcedCaretQuery({ id: "url-paste", active: url !== null });
    const { surfaceOpen } = useCaretMenu(caret, { itemCount: 3, onCommit: pick });
    `,
      // Full adoption spelled with the raw panel: `FloatingSurface` paired with
      // the keyboard model is the primitive taken whole, just rendered by hand.
      `
    import { FloatingSurface } from "@plugins/primitives/plugins/overlay/plugins/floating-surface/web";
    import { useCaretMenu, useCaretQuery } from "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web";
    const caret = useCaretQuery({ id: "slash", trigger: "/" });
    const { surfaceOpen, commit } = useCaretMenu(caret, { itemCount: n, onCommit: pick });
    `,
      // The non-surface exports carry no keyboard obligation on their own.
      `import { atWordBoundary } from "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web";`,
      // A same-named import from an unrelated module is not the primitive.
      `import { FloatingSurface } from "./local-surface";`,
      // `indexOf` on an array in a component that happens to also subscribe is the
      // one plausible false positive; it is accepted as the cost of a cheap rule.
      // (Documented, not tested — the rule deliberately reports it.)
    ],
    invalid: [
      {
        // The original bug's shape, verbatim.
        code: `
        useEffect(() => {
          function sync() {
            editorState.read(() => {
              const upToCaret = node.getTextContent().slice(0, offset);
              const idx = upToCaret.lastIndexOf(TRIGGER);
              if (idx === -1) { dismissedRef.current = false; close(); return; }
              setOpen(!dismissedRef.current);
            });
          }
          return lexicalEditor.registerUpdateListener(sync);
        }, [lexicalEditor]);
      `,
        errors: [{ messageId: "adhocCaretTrigger" }],
      },
      {
        // `indexOf` is the same shape.
        code: `
        const idx = text.indexOf("@");
        editor.registerUpdateListener(() => setOpen(idx !== -1));
      `,
        errors: [{ messageId: "adhocCaretTrigger" }],
      },
      {
        // Two listeners in one scanning file → one report each.
        code: `
        const idx = text.lastIndexOf("/");
        a.registerUpdateListener(f);
        b.registerUpdateListener(g);
      `,
        errors: [
          { messageId: "adhocCaretTrigger" },
          { messageId: "adhocCaretTrigger" },
        ],
      },
      {
        // The half-adoption shape: `url-paste`'s bug. It hand-rolled the panel, so
        // the menu had no arrows / Enter — mouse-only. The rule keys on the panel,
        // so it fires whatever the anchor is (here, not a caret rect at all).
        code: `
        import { FloatingSurface } from "@plugins/primitives/plugins/overlay/plugins/floating-surface/web";
        const el = createElement(FloatingSurface, { anchor: elementAnchor(ref), onDismiss: close }, rows);
      `,
        errors: [
          {
            messageId: "caretSurfaceWithoutMenu",
            data: { name: "FloatingSurface" },
          },
        ],
      },
      {
        // The menu COMPONENT without the hook is the same half-adoption: the
        // surface renders and dismisses, but no key moves or commits.
        code: `
        import { CaretTriggerMenu, useCaretQuery } from "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web";
        const caret = useCaretQuery({ id: "x", trigger: "/" });
        const el = createElement(CaretTriggerMenu, { caret, open: caret.open }, rows);
      `,
        errors: [
          {
            messageId: "caretSurfaceWithoutMenu",
            data: { name: "CaretTriggerMenu" },
          },
        ],
      },
    ],
  },
);
