import { Icon } from "@plugins/ui/plugins/icons/web";
import { useEffect, useRef, useState } from "react";
import {
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  DROP_COMMAND,
  PASTE_COMMAND,
  type LexicalEditor,
  type NodeKey,
} from "lexical";
import { $createLinkNode, $isLinkNode } from "@lexical/link";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import {
  CaretTriggerMenu,
  useCaretMenu,
  useForcedCaretQuery,
} from "@plugins/primitives/plugins/text-editor/plugins/caret-trigger/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  EndpointError,
  getEndpointErrorMessage,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  $setLinkText,
  readTransferText,
  useBlockEditor,
  type BlockTextPluginProps,
} from "@plugins/page/plugins/editor/web";
import {
  BOOKMARK_TYPE,
  linkMetaEndpoint,
} from "@plugins/page/plugins/bookmark/core";
import { EMBED_TYPE } from "@plugins/page/plugins/embed/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const alternateEmailIcon = symbol("alternate-email");
const bookmarkIcon = symbol("bookmark");
const linkIcon = symbol("link");
const smartDisplayIcon = symbol("smart-display");

/** A bare http(s) URL is a single whitespace-free token that parses as a URL. */
function bareUrl(text: string): string | null {
  if (!text || /\s/.test(text)) return null;
  try {
    const u = new URL(text);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return text;
  } catch (err) {
    // `new URL` throws TypeError on non-URL text — the expected case; not a URL.
    if (!(err instanceof TypeError)) throw err;
    return null;
  }
}

// Every row the menu can show, in commit-index order. Which of them a given
// paste offers is `rowsFor` — the index the keyboard commits is into THAT list.
const ALL_ROWS = [
  { kind: "link", icon: linkIcon, label: "Keep as link" },
  { kind: "mention", icon: alternateEmailIcon, label: "Mention" },
  { kind: "bookmark", icon: bookmarkIcon, label: "Create bookmark" },
  { kind: "embed", icon: smartDisplayIcon, label: "Create embed" },
] as const;

/** The menu a paste opened: what it inserted, and the text it left behind. */
interface OpenMenu {
  url: string;
  /** The inserted `LinkNode` — Mention re-finds it by key, never by position. */
  linkKey: NodeKey;
  /** The block held no text before the paste — Bookmark / Embed are offered. */
  wasEmpty: boolean;
  /** The root's text right after the insert. ANY change from it closes the menu. */
  snapshot: string;
}

function rowsFor(menu: OpenMenu | null, serverSync: boolean) {
  if (menu === null) return [];
  return ALL_ROWS.filter((row) => {
    // The memory-mode editor has no server to fetch a title from.
    if (row.kind === "mention") return serverSync;
    // Turning the block into a card only makes sense when the link is all it holds.
    if (row.kind === "bookmark" || row.kind === "embed") return menu.wasEmpty;
    return true;
  });
}

/** The live text of the whole block — never the row's lagging `data.text` copy. */
const $rootText = (): string => $getRoot().getTextContent();

/**
 * Run `fn` as ONE discrete (synchronously committed) Lexical update, and throw
 * if it was enqueued instead. `discrete: true` only commits synchronously when
 * no update is already in flight; `recordDocEdit`'s microtask is what guarantees
 * that, and the undo boundary depends on the edit landing INSIDE its scope — so
 * an enqueued update must be loud, not a silent no-op. Same contract as
 * `page/editor`'s `applyInlineFormat`.
 */
function discreteUpdate<T>(
  lexical: LexicalEditor,
  label: string,
  fn: () => T,
): T {
  // Boxed so the value written inside the update callback is visible here.
  const outcome: { ran?: { value: T } } = {};
  lexical.update(
    () => {
      outcome.ran = { value: fn() };
    },
    { discrete: true },
  );
  if (outcome.ran === undefined) {
    throw new Error(
      `url-paste ${label}: the discrete update was enqueued, not committed — it must run outside editor.update() / an update listener`,
    );
  }
  return outcome.ran.value;
}

/**
 * Pasting a bare URL makes it a LINK, right away, and offers what else it could
 * be. A Plugin-only block-text extension (no inline node of its own — the link is
 * an ordinary `LinkNode`, i.e. a `TextRun.link` in the stored text).
 *
 * ## The gate
 *
 * A single bare http(s) URL (`readTransferText`, trimmed), in any text block:
 *
 * - **Paste** needs a COLLAPSED caret. A non-collapsed selection is declined,
 *   because `@lexical/link`'s `LinkPlugin` already wraps a selected range in the
 *   pasted URL, and that is the right outcome there.
 * - **Drop** keeps its old gate: an EMPTY block only. A drop into existing text
 *   has no caret we control — the browser picks the drop point.
 *
 * "Empty" reads the LIVE root text inside the handler, not `textOf(block)`: that
 * row copy trails the editor by up to ~1 s, so a block the user just cleared
 * would still read as full.
 *
 * ## The insert is its own undo step
 *
 * The handler cancels the gesture, then hands the insert to
 * `useBlockEditor().recordDocEdit(block.id, "Paste link", …)`. That runs it one
 * microtask later (the command handler is inside an `editor.update()`, where a
 * discrete update would only be enqueued), closes the open typing run first, and
 * records the paste as ONE undo entry. The insert places the caret AFTER the
 * link — `LinkNode.canInsertTextAfter()` is false, so typing continues outside
 * it. A caret in the middle of an existing link splits that link around the new
 * one (`insertNodes` splits inline parents up to the block), so links never nest.
 *
 * ## The menu, and when it goes away
 *
 * Right after the insert, the menu opens at the caret: Keep as link / Mention
 * (only with a server to ask for the title) / Create bookmark + Create embed
 * (only when the link is all the block holds). It closes on a pick, Esc, a click
 * outside, and — the rule everything else leans on — on ANY change to the
 * block's text after the insert: typing, Backspace, a remote edit, an undo. That
 * is an update listener comparing the root text with a snapshot taken right
 * after the insert.
 *
 * That rule is the whole Cmd+Z story. Cmd+Z reaches the surface undo stack like
 * any other; the paste was its own entry and the stack seals any open typing run
 * first, so the entry popped is the paste. Replaying it removes the link, the
 * text changes, and the menu closes. There is no key interception.
 *
 * Bookmark / Embed convert the block through `editor.convertTo` without
 * stripping the link from its text (Turn-into does the same to a non-empty
 * block): undoing the conversion brings the pasted link back, and a second undo
 * removes the paste.
 *
 * ## Mention
 *
 * Closes the menu and asks `bookmark`'s `/api/link-meta` for the page title.
 * Until it answers the link shows its URL, which is its true state. When the
 * title arrives, the link is re-found BY KEY and retitled as its own undo step
 * ("Mention link") — but only while it still exists with the same URL and the
 * URL as its text. Anything else means the user changed it meanwhile, and their
 * edit wins. A fetch failure or a page with no title is a toast; the URL stays.
 *
 * ## One surface for both gestures
 *
 * The two gestures ask the same question, so they share the insert and the
 * menu — a link dragged out of another tab is the same intent as one pasted from
 * it. The drop cannot collide with the container's own drop door: a single-line
 * URL over a block's editing host classifies as `inline` there, so the
 * container declines it, and this native listener on the contenteditable runs
 * before the container's React handler anyway (see the DROP arm for the one
 * payload where that is not enough).
 *
 * The menu is a full member of the caret-trigger primitive rather than a bespoke
 * surface. A paste is an EXTERNAL open signal — exactly what
 * `useForcedCaretQuery` (the same producer behind the gutter `+`) exists for — so
 * `useCaretMenu` supplies arrows / Enter / Esc / outside-press and the
 * pointerdown-timed `commit` identically to `/`, `[[`, `@` and `$$`.
 */
export function UrlPastePlugin({ block, editor }: BlockTextPluginProps) {
  const [lexical] = useLexicalComposerContext();
  const { recordDocEdit, serverSync } = useBlockEditor();
  const fetchEndpoint = useFetchEndpoint();

  // The React copy drives the render; the ref is what the update listener reads.
  // Written together (only in `setMenu`), so a text change landing between the
  // insert and the next render still sees the menu it has to close.
  const [menu, setMenuState] = useState<OpenMenu | null>(null);
  const menuRef = useRef<OpenMenu | null>(null);
  const setMenu = useEventCallback((next: OpenMenu | null) => {
    menuRef.current = next;
    setMenuState(next);
  });

  // A Mention's title arrives after a network round-trip, by which time this
  // block's editor may be gone (the page closed, the block converted). A disposed
  // editor must not be written to: the write would land in a detached state that
  // nothing persists.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Insert `url` as a link at the caret — as its own undo entry — and open the
   * menu on it. Called from inside a command handler, so the insert itself is
   * deferred by `recordDocEdit` (see the component doc).
   */
  const insertLinkAndOpenMenu = useEventCallback(
    (url: string, wasEmpty: boolean) => {
      recordDocEdit(block.id, "Paste link", () => {
        const linkKey = discreteUpdate(lexical, "paste", (): NodeKey => {
          const sel = $getSelection();
          // The gate saw a RangeSelection one microtask ago, and nothing in
          // between takes the selection away from the editor it lives in.
          if (!$isRangeSelection(sel)) {
            throw new Error(
              "url-paste: the caret the link was gated on is gone — no RangeSelection to insert it at",
            );
          }
          const link = $createLinkNode(url).append($createTextNode(url));
          sel.insertNodes([link]);
          // Out of the link, so the next keystroke is plain text beside it.
          link.selectNext(0, 0);
          return link.getKey();
        });
        setMenu({
          url,
          linkKey,
          wasEmpty,
          snapshot: lexical.getEditorState().read($rootText),
        });
      });
    },
  );

  useEffect(() => {
    /**
     * The URL this transfer carries, or null when it is not a single bare
     * http(s) URL. `readTransferText` rather than a bare `text/plain` read — some
     * sources describe a dragged link ONLY as `text/uri-list`, which is the whole
     * payload here.
     */
    const transferUrl = (data: DataTransfer | null): string | null =>
      bareUrl(data ? readTransferText(data).trim() : "");

    const unregister = [
      lexical.registerCommand<ClipboardEvent>(
        PASTE_COMMAND,
        (event) => {
          const url = transferUrl(event.clipboardData);
          if (url === null) return false;
          const sel = $getSelection();
          // A selected range is `LinkPlugin`'s: it wraps the range in the URL.
          if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;
          const wasEmpty = $rootText().trim() === "";
          event.preventDefault();
          insertLinkAndOpenMenu(url, wasEmpty);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      lexical.registerCommand<DragEvent>(
        DROP_COMMAND,
        (event) => {
          const url = transferUrl(event.dataTransfer);
          if (url === null) return false;
          const root = $getRoot();
          // Only an EMPTY block — a drop into existing text lands at a point the
          // browser chose, not at a caret we hold. And only a HYDRATED one: a root
          // with no children has no paragraph to seat the caret in (its content
          // doc has not arrived yet), so the gesture is left to fall through.
          if (
            root.getTextContent().trim() !== "" ||
            root.getChildrenSize() === 0
          )
            return false;
          event.preventDefault();
          // CONSUME the gesture, don't merely claim it. The block editor's
          // container has a drop door of its own ABOVE this one (React's
          // root-delegated `onDrop`), and it classifies the RAW transfer text —
          // which for a `text/uri-list` ends in the CRLF RFC 2483 mandates. So
          // the one payload a link drag most often carries reads as MULTI-LINE
          // up there, and a single dropped URL would insert this link AND mint a
          // block of its own. `stopPropagation` is the browser's own answer to
          // "a handler nearer the caret owns this gesture": React's listener
          // sits at the app root, so the event never reaches it.
          //
          // Only the DROP arm needs it. A caret paste never reaches the
          // container's `onPaste` — that one gates on the CONTAINER holding
          // focus (block-selection mode), which a caret in a block excludes by
          // construction. A drop has no such gate, and correctly so: a drop need
          // not focus anything.
          event.stopPropagation();
          // A paste implies a caret; a DROP does not — the caret may be in
          // another block, or nowhere. The block is empty, so its start is the
          // only place the link can go: seat the selection there now (we are
          // inside the command's update), so the deferred insert finds it.
          root.selectStart();
          // …and take DOM focus, because `useForcedCaretQuery` gates `open` on
          // focus living inside this editor's root. Lexical's `focus()` is what
          // moves it — the reconciler writing the selection takes DOM focus
          // (`lexical@0.44.0 Lexical.dev.mjs:11259-11292`).
          lexical.focus();
          insertLinkAndOpenMenu(url, true);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      // The menu-lifetime rule: any change to the block's text after the insert
      // closes the menu — typing, Backspace, a remote edit, and the Cmd+Z that
      // takes the paste back. The insert's own update ran before `setMenu`, so
      // it never trips this.
      lexical.registerUpdateListener(({ editorState }) => {
        const open = menuRef.current;
        if (open === null) return;
        if (editorState.read($rootText) !== open.snapshot) setMenu(null);
      }),
    ];
    return () => {
      for (const u of unregister) u();
    };
  }, [lexical, insertLinkAndOpenMenu, setMenu]);

  /** Retitle the pasted link with its page's title, if it is still untouched. */
  const mention = useEventCallback(async (url: string, linkKey: NodeKey) => {
    let title: string | undefined;
    try {
      const answer = await fetchEndpoint(
        linkMetaEndpoint,
        {},
        // A dead or unreachable page is an expected answer about the user's
        // link, not an app defect — the toast below is where it goes, so it
        // files no endpoint-error report.
        { query: { url }, report: false },
      );
      // No computer behind the app to fetch the page: the link keeps its URL.
      if (answer.kind === "unavailable") {
        showToast({ description: answer.message, variant: "info" });
        return;
      }
      ({ title } = answer.value);
    } catch (err) {
      if (!(err instanceof EndpointError)) throw err;
      showToast({
        title: "Couldn't fetch the page title",
        description: getEndpointErrorMessage(err),
        variant: "error",
      });
      return;
    }
    title = title?.trim();
    if (!title) {
      showToast({
        description: "That page has no title, so the link keeps its URL.",
        variant: "info",
      });
      return;
    }
    if (!mountedRef.current) return;
    const text = title;
    recordDocEdit(block.id, "Mention link", () => {
      discreteUpdate(lexical, "mention", () => {
        const node = $getNodeByKey(linkKey);
        // The user's edit wins: a link that is gone, re-pointed, or already
        // retyped is no longer the one this title was fetched for.
        if (
          !$isLinkNode(node) ||
          node.getURL() !== url ||
          node.getTextContent() !== url
        )
          return;
        $setLinkText(node, text);
      });
    });
  });

  const rows = rowsFor(menu, serverSync);

  // Externally-driven open-state: the insert is the signal, so there is no
  // trigger char to derive from and no arbiter candidacy to resolve.
  const caret = useForcedCaretQuery({
    id: "url-paste",
    active: menu !== null,
    onDismiss: () => setMenu(null),
  });

  const { surfaceOpen, activeIndex, setActiveIndex, commit } = useCaretMenu(
    caret,
    {
      itemCount: rows.length,
      onCommit: (i) => {
        const row = rows[i];
        if (menu === null || row === undefined) return;
        setMenu(null);
        switch (row.kind) {
          case "link":
            // The link is already in place — keeping it is closing the menu.
            break;
          case "mention":
            void mention(menu.url, menu.linkKey);
            break;
          case "bookmark":
            editor.convertTo(BOOKMARK_TYPE, { url: menu.url });
            break;
          case "embed":
            editor.convertTo(EMBED_TYPE, { url: menu.url });
            break;
        }
      },
    },
  );

  return (
    <CaretTriggerMenu caret={caret} open={surfaceOpen} width="sm" padding="xs">
      {/* eslint-disable-next-line data-view/no-adhoc-row-list -- Transient caret-menu
          chrome, not a collection of domain records: up to four fixed choices
          whose index IS the keyboard commit key. Same shape as the `/` menu's rows. */}
      {rows.map(({ kind, icon, label }, i) => (
        <Row
          key={kind}
          selected={activeIndex === i}
          icon={<Icon icon={icon} />}
          onMouseEnter={() => setActiveIndex(i)}
          // Commits on `pointerdown`, never `click`: the focus-less surface
          // perturbs the host selection and unmounts this row before a later
          // mouse event could fire (see `useCaretMenu`'s `commit`).
          onPointerDown={(e: React.PointerEvent) => {
            e.preventDefault();
            commit(i);
          }}
        >
          {label}
        </Row>
      ))}
    </CaretTriggerMenu>
  );
}
