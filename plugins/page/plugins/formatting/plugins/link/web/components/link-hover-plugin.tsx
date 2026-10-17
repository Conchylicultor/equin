import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from "lexical";
import { $isLinkNode, type LinkNode } from "@lexical/link";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $setLinkText,
  useBlockEditor,
  type BlockTextPluginProps,
} from "@plugins/page/plugins/editor/web";
import { useHoverIntent } from "../internal/use-hover-intent";
import { LinkHoverCard } from "./link-hover-card";
import type { LinkFormResult } from "./link-form";

/** Rest this long on a link before its card opens (ms). */
const OPEN_DELAY = 300;
/**
 * Close this long after the pointer has left both the link and the card (ms).
 * The grace is what carries the pointer ACROSS the gap onto the card, so it has
 * to cover a hand that drifts sideways over the text beside the link on the way
 * down, not only a straight drop through the 4px gap.
 */
const CLOSE_DELAY = 300;

/** A hovered link: its node, and the `<a>` Lexical rendered for it. */
interface HoveredLink {
  key: NodeKey;
  element: HTMLAnchorElement;
}

const sameLink = (a: HoveredLink, b: HoveredLink) => a.element === b.element;

/** The `LinkNode` at or above `node`, or null. */
function $linkAbove(node: LexicalNode | null): LinkNode | null {
  let cur = node;
  while (cur !== null && !$isLinkNode(cur)) cur = cur.getParent();
  return cur;
}

/**
 * The link this `<a>` renders, or null when it renders none — an anchor some
 * inline decorator draws inside a link resolves UP to that link, so the
 * element check keeps the card hanging off the link's own `<a>` only.
 */
function resolveLink(
  lexical: LexicalEditor,
  element: HTMLAnchorElement,
): HoveredLink | null {
  return lexical.getEditorState().read(
    () => {
      const link = $linkAbove($getNearestNodeFromDOMNode(element));
      if (link === null) return null;
      const key = link.getKey();
      return lexical.getElementByKey(key) === element ? { key, element } : null;
    },
    { editor: lexical },
  );
}

/**
 * Run `fn` as ONE discrete Lexical update, and fail loudly if it could not be.
 *
 * `discrete: true` is what makes the edit land synchronously inside
 * `recordDocEdit`'s `untracked` scope, so it is recorded as its own undo entry
 * and not folded into the typing run. It only commits synchronously when no
 * update is already in flight — nested inside one, Lexical would QUEUE it and
 * the undo boundary would silently vanish. `recordDocEdit` defers the edit one
 * microtask precisely so that never happens; this turns a violation into an
 * error rather than a quietly wrong history.
 */
function updateDiscrete(lexical: LexicalEditor, fn: () => void): void {
  let ran = false;
  lexical.update(
    () => {
      ran = true;
      fn();
    },
    { discrete: true },
  );
  if (!ran) {
    throw new Error(
      "LinkHoverPlugin: the discrete update was enqueued, not committed — it must run outside editor.update() / an update listener",
    );
  }
}

/**
 * The link's live href + text, re-read on every editor update, or null once
 * the node is gone. The snapshot is a JSON pair so `useSyncExternalStore` gets
 * a value that compares equal while nothing changed.
 */
function useLiveLink(
  lexical: LexicalEditor,
  key: NodeKey | null,
): { url: string; text: string } | null {
  const subscribe = useCallback(
    (onChange: () => void) => lexical.registerUpdateListener(onChange),
    [lexical],
  );
  const snapshot = useSyncExternalStore(subscribe, () =>
    key === null
      ? null
      : lexical.getEditorState().read(() => {
          const node = $getNodeByKey(key);
          return $isLinkNode(node)
            ? JSON.stringify([node.getURL(), node.getTextContent()])
            : null;
        }),
  );
  return useMemo(() => {
    if (snapshot === null) return null;
    const [url, text] = JSON.parse(snapshot) as [string, string];
    return { url, text };
  }, [snapshot]);
}

/**
 * The link hover card. Rest the pointer on a link in an editable block and a
 * small card opens under it: the URL (click to open it in a new tab), Copy, and
 * Edit — which turns the card into a URL + Title form with Remove link.
 *
 * A Plugin-only block-text extension: one instance per block editor, tracking
 * the `<a>` under the pointer with `pointerover` / `pointerout` on the editor
 * root. Hover intent (dwell to open, grace to close, travel onto the card) is
 * `useHoverIntent`; a link entered with a mouse button held — a drag-select
 * sweeping across it — is never reported, and a press mid-dwell cancels the
 * pending open.
 *
 * Every write (Apply, Remove link) goes through `recordDocEdit`, which records
 * it as ONE entry on the page's undo stack, looking the link up by its node key
 * when the deferred edit runs. A link that vanished in between (a remote edit,
 * an undo) makes the edit a no-op, which records nothing.
 */
export function LinkHoverPlugin({ block }: BlockTextPluginProps) {
  const [lexical] = useLexicalComposerContext();
  const { recordDocEdit } = useBlockEditor();
  const intent = useHoverIntent<HoveredLink>(sameLink, {
    openDelay: OPEN_DELAY,
    closeDelay: CLOSE_DELAY,
  });
  const { enterTrigger, leaveTrigger, cancelPendingOpen, close } = intent;
  const activeKey = intent.active?.key ?? null;
  const live = useLiveLink(lexical, activeKey);

  // Track the `<a>` under the pointer. Re-attached whenever Lexical swaps its
  // root element; `hovered` is per-root state, reset with it.
  useEffect(() => {
    const attach = (root: HTMLElement) => {
      let hovered: HTMLAnchorElement | null = null;
      const moveTo = (next: HTMLAnchorElement | null, e: PointerEvent) => {
        if (next === hovered) return;
        if (hovered !== null) leaveTrigger();
        hovered = next;
        if (next === null) return;
        // Hover intent is for a pointer that hovers: not touch, not a
        // drag-select sweeping across the link, not a read-only editor.
        if (e.pointerType === "touch" || e.buttons !== 0) return;
        if (!lexical.isEditable()) return;
        const link = resolveLink(lexical, next);
        if (link !== null) enterTrigger(link);
      };
      const onOver = (e: PointerEvent) => {
        const a = e.target instanceof Element ? e.target.closest("a") : null;
        moveTo(a !== null && root.contains(a) ? a : null, e);
      };
      const onOut = (e: PointerEvent) => {
        // Leaving the editor root altogether (onto the card, or anywhere else):
        // no `pointerover` inside the root will report it, so report it here.
        const to = e.relatedTarget;
        if (!(to instanceof Node) || !root.contains(to)) moveTo(null, e);
      };
      root.addEventListener("pointerover", onOver);
      root.addEventListener("pointerout", onOut);
      root.addEventListener("pointerdown", cancelPendingOpen);
      return () => {
        root.removeEventListener("pointerover", onOver);
        root.removeEventListener("pointerout", onOut);
        root.removeEventListener("pointerdown", cancelPendingOpen);
      };
    };
    let detach: (() => void) | null = null;
    const unregister = lexical.registerRootListener((root) => {
      detach?.();
      detach = root ? attach(root) : null;
    });
    return () => {
      unregister();
      detach?.();
      detach = null;
    };
  }, [lexical, enterTrigger, leaveTrigger, cancelPendingOpen]);

  // Close once the link is gone (deleted, undone, rewritten by a remote edit),
  // rather than leave a card hanging off a detached `<a>`.
  useEffect(() => {
    if (activeKey === null) return;
    return lexical.registerUpdateListener(({ editorState }) => {
      const alive = editorState.read(() =>
        $isLinkNode($getNodeByKey(activeKey)),
      );
      if (!alive) close();
    });
  }, [lexical, activeKey, close]);

  // Esc closes the card before it does anything else in the editor (it would
  // otherwise leave text editing for block selection). CRITICAL, because the
  // editor's own Esc handler sits at HIGH and registers first. In edit mode the
  // focus is in the form, which handles its own Esc.
  useEffect(() => {
    if (activeKey === null) return;
    return lexical.registerCommand<KeyboardEvent | null>(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        close();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [lexical, activeKey, close]);

  if (intent.active === null || live === null) return null;
  const { key, element } = intent.active;

  const apply = ({ href, title }: LinkFormResult) => {
    close();
    recordDocEdit(block.id, "Edit link", () => {
      updateDiscrete(lexical, () => {
        const link = $getNodeByKey(key);
        if (!$isLinkNode(link)) return;
        if (link.getURL() !== href) link.setURL(href);
        if (title === undefined) return;
        $setLinkText(link, title);
      });
    });
  };

  const remove = () => {
    close();
    recordDocEdit(block.id, "Remove link", () => {
      updateDiscrete(lexical, () => {
        const link = $getNodeByKey(key);
        if (!$isLinkNode(link)) return;
        // Unwrap: the text stays where it was, minus the link around it.
        for (const child of link.getChildren()) link.insertBefore(child);
        link.remove();
      });
    });
  };

  return (
    <LinkHoverCard
      anchor={element}
      url={live.url}
      text={live.text}
      editing={intent.pinned}
      surfaceProps={intent.surfaceProps}
      onEdit={intent.pin}
      onApply={apply}
      onRemove={remove}
      onClose={close}
    />
  );
}
