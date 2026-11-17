import { useState } from "react";
import { $getNodeByKey, type LexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  cn,
  Textarea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { KatexMath } from "@plugins/page/plugins/math/plugins/render/web";
import { textVariantClass } from "@plugins/primitives/plugins/css/plugins/text/web";
import { inlineMathNode } from "../../core";

// Bare-string mono metric for the LaTeX-source field. Kept as a standalone const
// (not inlined into a cn(...) class context) so the typography rule treats it as
// the sanctioned out-of-scope mono/code metric rather than an ad-hoc size.
const MONO_FIELD = textVariantClass("code");

/**
 * The browser half of the inline-math token: the SAME family declared in
 * `core/node.ts`, with rendering added. Clicking the rendered math opens a
 * popover with a LaTeX source field + live preview; edits rewrite the node's
 * `expression` field.
 */
export const inlineMathWebNode = inlineMathNode.decorated({
  className: "inline-flex align-baseline",
  render: ({ expression }, node) => (
    <InlineMathView nodeKey={node.getKey()} expression={expression} />
  ),
});

/** The Lexical class to register in a block editor's `nodes` config. */
export const InlineMathNode = inlineMathWebNode.Node;

function InlineMathView({
  nodeKey,
  expression,
}: {
  nodeKey: string;
  expression: string;
}) {
  const [lexicalEditor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(expression);

  function commit(value: string) {
    setDraft(value);
    lexicalEditor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node && inlineMathNode.is(node)) {
        inlineMathNode.setFields(node, { expression: value });
      }
    });
  }

  return (
    <InlinePopover
      open={open}
      onOpenChange={(next) => {
        setDraft(expression);
        setOpen(next);
      }}
      width="lg"
      padding="sm"
      trigger={
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "rounded-sm px-xs",
            "hover:bg-muted",
            open && "bg-muted",
          )}
        >
          <KatexMath expression={expression} display={false} />
        </span>
      }
    >
      <Stack gap="sm">
        <Center className="min-h-6">
          {draft === "" ? (
            <Text variant="caption" tone="muted">
              Empty
            </Text>
          ) : (
            <KatexMath expression={draft} display={false} />
          )}
        </Center>
        <Textarea
          bare
          keep={transient(
            "committed into the block's text (its content doc) on every keystroke",
          )}
          // NOT redundant, however portaled this looks. This field reads as
          // `local` today only because the popover portals to `document.body`,
          // which severs it from the page body's `surfaceUndoProps` subtree so
          // `resolveUndoOwner`'s `closest()` walk finds nothing. That is an
          // accident: `PortalForwardProvider` re-stamps ancestry-derived `data-*`
          // across portals and already carries four, so the day
          // `data-undo-owner` joins them this flips to `surface` with no test to
          // catch it. Declared, the answer stays true either way.
          {...localUndoProps}
          value={draft}
          autoFocus
          onChange={(e) => commit(e.target.value)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="LaTeX… e.g. E = mc^2"
          className={cn(
            "border-border w-full resize-none rounded-sm border bg-transparent p-sm",
            "caret-foreground outline-none placeholder:text-muted-foreground",
            MONO_FIELD,
          )}
          rows={2}
        />
      </Stack>
    </InlinePopover>
  );
}

export function $createInlineMathNode(expression: string): LexicalNode {
  return inlineMathWebNode.create({ expression });
}
