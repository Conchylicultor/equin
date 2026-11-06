import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useBlockEditor } from "../block-editor-context";
import { useSelectionControl } from "../selection-control";
import type { BlockEditorAPI } from "../types";
import { useInsertParagraphBelow } from "./use-insert-block-below";
import { useAnchorTypes } from "../internal/block-handles";
import { resolveTab } from "../internal/keystroke-intent";
import { toNodes } from "../internal/optimistic-block-ops";
import { scopeNodes } from "../internal/zoom-scope";

/**
 * How a **void** block — one owning no editable text — takes part in the
 * editor's caret model, in one place instead of hand-copied per block type.
 *
 * A text-bearing block gets all of this for free: its Lexical editor IS the
 * focusable node, the browser paints a caret in it, and the shared text
 * renderer registers its focus handle. A void block has none of that, and the
 * eight media types proved what "each block does its own" costs — image, video,
 * audio, file, embed, bookmark, place and page-link each registered nothing at
 * all, so `navigate()` skipped them and the caret jumped over content the user
 * could plainly see and click into.
 *
 * So the split here is no longer "the plumbing, for whoever remembers to call
 * it". It is:
 *
 * - {@link BlockCaretHost} — what the EDITOR mounts around a block's row when
 *   the type registers `caret: "editor"`. The block writes no caret code at all:
 *   focusability, arrow navigation, the caret cue, Backspace and Enter all come
 *   from here. This is the answer for every block whose payload is an object the
 *   user looks at rather than types into.
 * - {@link useVoidCaret} — the plumbing, for the few types that must hold the
 *   caret somewhere only they know about (`caret: "renderer"`: a `<textarea>` of
 *   source, a `Row`'s synthesized inner control). It takes a focus
 *   **capability** rather than a node, which is exactly what lets one hook serve
 *   all of them without knowing about any of them.
 * - {@link useCaretEscape} — the ↑/↓ escape on its own, for those same types.
 *   "The caret can always leave a void block" is the EDITOR's invariant, so it
 *   is spelled once here rather than re-derived by each block that needs it. It
 *   is a separate export rather than a field on {@link useVoidCaret}'s result
 *   because the textarea types must NOT take it — their arrows move through
 *   their own source — and "don't spread that field" is a discipline, whereas
 *   "don't call that hook" is a spelling.
 * - {@link useBlockActivate} — how a render state tells the host what Enter
 *   means on it.
 */

/** What a void block hands the editor so the caret can land on it. */
export interface VoidCaretOptions {
  /** The block's row id — the key the editor's focus handle registry is keyed by. */
  blockId: string;
  /** Does the editor's focus model currently point at this block? */
  isFocused: boolean;
  editor: BlockEditorAPI;
  /**
   * Make this block the focused element. A **capability, never a node**: the
   * focus-holding element differs per block type (a textarea, a `Row`'s inner
   * control which `Row` re-synthesizes the moment the row grows actions, a box),
   * and only the block knows which. It may be an inline arrow — it is wrapped
   * with `useEventCallback` internally, so a fresh closure every render does not
   * churn the handle registration.
   */
  focus: () => void;
}

export interface VoidCaret {
  /**
   * Spread onto whichever element actually takes DOM focus, so a click / Tab
   * that focuses this block moves the editor's focus model here too. Without it
   * the two disagree: the browser thinks the user is in this block, the editor
   * thinks they are still in the last one they arrowed through.
   */
  onFocus: () => void;
}

/**
 * Wire a void block into the editor's caret model.
 *
 * Registering the focus handle is not cosmetic: `navigate()` walks the
 * registered handles, so a block with none is **skipped entirely** by arrow-key
 * navigation while a click can still focus it — the caret jumps over a block the
 * user can plainly see and click into. (A void handle registers `focus` only. It
 * deliberately omits `replayInput`, and the caret authority's `landFlight` keys
 * its void arm on exactly that absence, so a landing here resolves without any
 * `onLanded` plumbing on the block's side.)
 *
 * The pull-focus effect has **no "is it already the focused element?" guard**.
 * Three of the four original call sites carried one
 * (`document.activeElement !== ref.current`) and one did not, which is the tell
 * that it was never load-bearing: `.focus()` on the already-focused element
 * fires no focus event and moves no caret, so the guard bought nothing. It is
 * also unspellable here — this holds a capability, not a node, and there is
 * nothing to compare `activeElement` against.
 *
 * That is NOT the same question as the two guards {@link BlockCaretHost} adds
 * for itself, and the difference is worth keeping straight: those are about
 * focus being somewhere ELSE (inside the block, or nowhere at all), which only
 * became askable once a caret host started wrapping interactive content.
 */
export function useVoidCaret({
  blockId,
  isFocused,
  editor,
  focus,
}: VoidCaretOptions): VoidCaret {
  const { registerFocusHandle } = useBlockEditor();
  // Stable identity, latest closure: the registration effect must re-run when
  // the block id changes, never because the caller wrote an inline arrow.
  const focusBlock = useEventCallback(focus);
  const onFocus = useEventCallback(() => editor.onFocus());

  useEffect(
    () => registerFocusHandle(blockId, { focus: focusBlock }),
    [blockId, registerFocusHandle, focusBlock],
  );

  // The editor's focus model is the authority; the DOM follows it. This is what
  // makes a conversion (`---`, `$$`, ```` ``` ````) or an arrow-key landing that
  // kept `focusedBlockId` on this id actually put the keyboard here.
  useEffect(() => {
    if (isFocused) focusBlock();
  }, [isFocused, focusBlock]);

  return { onFocus };
}

/**
 * The ↑/↓ escape, for a `caret: "renderer"` block whose own focus target is not
 * a text control (sub-page's `Row`).
 *
 * A block that swallowed the arrows would strand the user on a line they cannot
 * leave, which makes "the caret can always leave a void block" the EDITOR's
 * invariant rather than each block's promise — and an invariant belongs to
 * whoever owns it. Everything else (what Backspace means here, what Enter seeds)
 * is the block's own meaning and stays with the block.
 */
export function useCaretEscape(
  editor: BlockEditorAPI,
): (e: React.KeyboardEvent) => void {
  return useEventCallback((e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      editor.navigate("up");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      editor.navigate("down");
    }
  });
}

/**
 * Registering an activation returns the unregister; `null` registers nothing.
 * The host supplies a stable one, so a block may call the hook unconditionally.
 */
type RegisterActivate = (
  activate: (() => void) | null,
  opts: BlockActivateOptions,
) => () => void;

export interface BlockActivateOptions {
  /**
   * Also run the activation when the block ARRIVES under the caret — the host
   * mounted with the editor's caret already on it, which is what a `/place`,
   * a gutter-`+` pick or a Turn-into produces. For a prompt whose payload is
   * typed (a search box, a URL field) that is where the user's next keystroke
   * belongs. Leave it off for an activation that would surprise on arrival (a
   * native file dialog). Arriving by ↑/↓ never runs it: the host was already
   * mounted.
   */
  onArrival?: boolean;
}

const BlockActivateContext = createContext<RegisterActivate | null>(null);

/**
 * Declare what **Enter** (and Space) mean on this block, in this render state.
 *
 * An unfilled media block is a *prompt* — it is asking for a payload — so Enter
 * should fill it: open the file picker, focus the URL box, open the page picker.
 * A filled one is an *object*, so Enter starts a paragraph below it instead.
 * That is a per-state fact, which is why it is registered from inside the
 * component rather than declared on the registration next to `caret`: the answer
 * depends on state a registration cannot see (the hidden `<input>`'s ref, which
 * arm rendered), and a static declaration would have to lie about one of the
 * arms.
 *
 * **Registering nothing is a legitimate state, not a failure.** `null` means
 * "this block has no primary action", and Enter then falls through to the host's
 * own meaning. Passing an inline arrow is fine — it is wrapped internally.
 *
 * Outside a {@link BlockCaretHost} — a `caret: "renderer"` block, or a component
 * reused off the block surface entirely — this is a **no-op**. That is
 * deliberate: `AttachmentUpload` is a shared component and its callers should
 * not have to know which surface they are on.
 */
export function useBlockActivate(
  activate: (() => void) | null,
  { onArrival = false }: BlockActivateOptions = {},
): void {
  const register = useContext(BlockActivateContext);
  const run = useEventCallback(() => activate?.());
  // The IDENTITY of the registration must depend only on whether there is one,
  // never on the closure — otherwise every render of the block re-registers.
  const enabled = activate !== null;
  useEffect(() => {
    if (!register) return;
    return register(enabled ? run : null, { onArrival });
  }, [register, enabled, run, onArrival]);
}

/**
 * Claim the caret cue for a box inside the host. Returns the release; the host
 * paints the cue on itself again once every claim is released.
 */
type ClaimCaretCue = () => () => void;

interface CaretCue {
  claim: ClaimCaretCue;
  /** The caret is in a field inside the block (`useInnerCaret`): no cue. */
  inner: boolean;
}

const CaretCueContext = createContext<CaretCue | null>(null);

/** Declare that the caret is in a field inside the block. Returns the release. */
type HoldInnerCaret = () => () => void;

const InnerCaretContext = createContext<HoldInnerCaret | null>(null);

/**
 * The caret cue, painted on a claiming box instead of the host: the same two
 * layered conditions as the host's own (see {@link BlockCaretHost}, *The cue*),
 * read off the host through its named group — DOM focus from its
 * `:focus-visible`, the editor's caret from its `aria-current` — so the box
 * can never disagree with the host it stands in for.
 */
const CLAIMED_CUE =
  "rounded-md group-focus-visible/caret-host:ring-3 group-focus-visible/caret-host:ring-ring/50 group-aria-[current=true]/caret-host:bg-accent";

/**
 * Paint the caret cue on THIS box rather than on the host around the block.
 *
 * For a box whose visual extent is not the host's: a `WideBlock` grows past the
 * reading column (centered on it), so a cue on the column-wide host shows as a
 * ring cutting through the middle of the table, and a tint covering only part
 * of it. Returns the class to put on the box; `undefined` outside a caret host
 * (a read-only surface, a `caret: "renderer"` block), where there is no cue.
 */
export function useCaretCueTarget(): string | undefined {
  const cue = useContext(CaretCueContext);
  const claim = cue?.claim;
  useEffect(() => claim?.(), [claim]);
  if (!cue) return undefined;
  return cue.inner ? undefined : CLAIMED_CUE;
}

/**
 * Declare that the caret is in a field INSIDE the block — a table's open cell —
 * while `inside` is true. The block-level cue (the tint and ring that say "the
 * caret is on this block") then steps aside: the field draws where the caret is
 * itself, and tinting the whole block on every click into it changes how the
 * block looks merely because it is being edited. The cue comes back once the
 * caret is the block's again (Escape out of the cell).
 *
 * Outside a {@link BlockCaretHost} this is a no-op, as `useBlockActivate` is.
 */
export function useInnerCaret(inside: boolean): void {
  const hold = useContext(InnerCaretContext);
  useEffect(() => (inside ? hold?.() : undefined), [hold, inside]);
}

export interface BlockCaretHostProps {
  /** The block's row id — the key the editor's focus handle registry is keyed by. */
  blockId: string;
  /** Does the editor's focus model currently point at this block? */
  isFocused: boolean;
  editor: BlockEditorAPI;
  /** Accessible name for the host — it has no text of its own to be named by. */
  label: string;
  children?: ReactNode;
}

/**
 * The focusable box that holds the caret for a `caret: "editor"` block, and
 * **the one place the "the caret is on this block" cue is written**.
 *
 * Mounted by `BlockRow` around the block's dispatch, never by the block. It adds
 * **no padding of its own**: it sits at the row's content-left edge `C`, which
 * is where the page-column invariant puts a block DECORATION, and the caret cue
 * is one. Every block keeps its own `<Inset x={BLOCK_INSET}>` for its content.
 *
 * ## The cue
 *
 * Two visual conditions, deliberately SEPARATE, and they layer:
 *
 * - `focus-ring` is the app's canonical indicator for "this element has DOM
 *   keyboard focus" — and it is the same utility that suppresses the browser's
 *   own outline, so the replacement is drawn on **exactly the condition the
 *   original was suppressed for**.
 * - `bg-accent` is "the editor's caret is on this block". It is the tint
 *   `Row.selected` paints, so a void block that delegates to `Row` (sub-page)
 *   and one that takes this host say the same thing the same way. It is also a
 *   different hue from the block-SELECTION band (`bg-primary/15`), which is the
 *   app's existing two-cue language rather than a coincidence.
 *
 * That separation is a bug this closes. The divider used to write `outline-none`
 * unconditionally and then draw a ring on `isFocused` — a *different* condition
 * — so a box that had genuinely taken keyboard focus while the editor's model
 * disagreed showed **nothing at all**.
 *
 * ## Focus: three rules, three different questions
 *
 * `useVoidCaret` answers "the model moved, so move the DOM". Wrapping
 * INTERACTIVE content — which a media block is full of — makes two more
 * questions askable that a divider never had to answer:
 *
 * 1. **Focus is already inside me.** Clicking "Remove image" focuses the button,
 *    which bubbles here, which makes this block the current one, which flips
 *    `isFocused` — and the pull would then yank focus off the button the user
 *    just clicked. So the focus capability declines when
 *    `contains(document.activeElement)`. This is a CONTAINMENT question and is
 *    load-bearing, unlike the identity guard `useVoidCaret` documents dropping.
 *    It cannot see through a **portal**, and nothing here can: a popover
 *    rendered to `document.body` is not a descendant. That is why a block whose
 *    affordance is a popover opens it from its own {@link useBlockActivate}
 *    rather than auto-opening on mount — an auto-open would race this.
 * 2. **Focus went nowhere.** The block's own control can unmount under the
 *    user's feet: "Remove image" clears the payload, so the button that was
 *    focused disappears and DOM focus falls to `<body>`. `isFocused` never
 *    changed, so rule 1's effect never re-runs, and the model says the caret is
 *    on this block while the keyboard is nowhere — arrows dead until the user
 *    clicks again. So focus is reclaimed on every commit, but ONLY from `null` /
 *    `<body>`. Not "anywhere outside this row": that would steal from a portal,
 *    which is rule 1's blind spot arriving by a different road.
 *
 * ## Keys: escapes are unconditional, meanings are the box's own
 *
 * The split matters, and getting it wrong strands the caret. A single origin
 * guard (`e.target === e.currentTarget`, the discipline the block-selection
 * container uses) would mean that once focus is on any inner control — the
 * upload dropzone, a URL field, a link — ↑/↓ reach nothing at all and the user
 * cannot leave the block by keyboard. So:
 *
 * - **↑/↓ and Escape run wherever they originated**, subject only to
 *   `defaultPrevented`. That is the protocol: an inner control that genuinely
 *   wants the arrows says so by preventing default, which is exactly what the
 *   place block's result list already does while its suggestions are open.
 * - **Backspace/Delete/Enter/Space/Tab are origin-guarded**, so typing in an
 *   inner field is never swallowed by the block around it (and Tab still walks
 *   focus between a block's own controls). On the box, Tab / Shift+Tab indent
 *   and outdent the block through the text blocks' own ladder (`resolveTab`).
 *
 * Backspace deletes the whole block in one press, whatever its payload holds: a
 * filled image is ONE object, not content to clear and then a block to delete.
 * (Clearing the payload is what the block's own "Remove"/"Replace" button is
 * for. Two affordances, two meanings, deliberately.) The caret lands above,
 * which is where the user's line then is — Notion's model, and it makes a
 * Backspace arriving from the block below read as one continuous motion.
 */
export function BlockCaretHost({
  blockId,
  isFocused,
  editor,
  label,
  children,
}: BlockCaretHostProps) {
  const ref = useRef<HTMLDivElement>(null);
  const activateRef = useRef<(() => void) | null>(null);
  // Mounted with the caret already here = the block just became this type under
  // the caret (see `BlockActivateOptions.onArrival`). Pending until the first
  // arrival activation consumes it, or the caret leaves — the block's prompt may
  // register a render or two late (its provider still loading).
  const arrivalPendingRef = useRef(isFocused);
  useEffect(() => {
    if (!isFocused) arrivalPendingRef.current = false;
  }, [isFocused]);
  const insertParagraphBelow = useInsertParagraphBelow();
  const selection = useSelectionControl();
  const { rowsRef, scope, makeBlockAPI } = useBlockEditor();
  const anchorTypes = useAnchorTypes();
  // How many boxes inside paint the cue in the host's place (`useCaretCueTarget`).
  const [cueClaims, setCueClaims] = useState(0);
  const claimCue = useCallback<ClaimCaretCue>(() => {
    setCueClaims((n) => n + 1);
    return () => setCueClaims((n) => n - 1);
  }, []);
  // How many fields inside hold the caret (`useInnerCaret`) — no cue while any do.
  const [innerCarets, setInnerCarets] = useState(0);
  const holdInnerCaret = useCallback<HoldInnerCaret>(() => {
    setInnerCarets((n) => n + 1);
    return () => setInnerCarets((n) => n - 1);
  }, []);
  const inner = innerCarets > 0;
  const cue = useMemo<CaretCue>(
    () => ({ claim: claimCue, inner }),
    [claimCue, inner],
  );

  // Stable for the lifetime of the host — `no-unstable-context-value`, and more
  // to the point a fresh identity would re-run every consumer's effect.
  const register = useCallback<RegisterActivate>((activate, { onArrival }) => {
    activateRef.current = activate;
    if (activate && onArrival && arrivalPendingRef.current) {
      arrivalPendingRef.current = false;
      // Runs in the block's effect, ahead of this host's own pull-focus effect —
      // which then declines, focus being inside the block (rule 1).
      activate();
    }
    return () => {
      // Only clear what THIS registration installed: a state flip can mount the
      // next arm's registration before the previous one's cleanup runs.
      if (activateRef.current === activate) activateRef.current = null;
    };
  }, []);

  const { onFocus } = useVoidCaret({
    blockId,
    isFocused,
    editor,
    // Rule 1 — see the docblock. The guard is CONTAINMENT, not identity.
    focus: () => {
      const el = ref.current;
      if (!el || el.contains(document.activeElement)) return;
      el.focus();
    },
  });

  // Rule 2 — see the docblock. Deliberately no dependency array: the question is
  // "where is focus right now", which nothing in this component's props can
  // answer, and the check is one property read.
  useEffect(() => {
    if (!isFocused) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    ref.current?.focus();
  });

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.defaultPrevented) return;

    // The escapes. Unconditional, so the caret can leave from anywhere inside.
    if (e.key === "ArrowUp") {
      e.preventDefault();
      editor.navigate("up");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      editor.navigate("down");
      return;
    }
    if (e.key === "Escape") {
      // The one keyboard route from a void block into a multi-block selection.
      // A text block reaches it through Lexical's own listener; this box has no
      // Lexical, and its Backspace deletes rather than selects, so without this
      // there is no way to select a media block from the keyboard at all.
      if (!selection) return;
      e.preventDefault();
      selection.enterSelectionMode(blockId);
      return;
    }

    // Everything below is the BOX's own meaning, so it must have originated on
    // the box — never on an input, a link or a button inside it.
    if (e.target !== e.currentTarget) return;

    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      editor.navigate("up"); // land the caret on the block above…
      editor.remove(); // …then delete this one
      return;
    }
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // The text block's Tab ladder, resolved for this block: the void block
      // has no caret position, and Tab never needed one. Always consumed, so
      // Tab never walks DOM focus out of the block list.
      e.preventDefault();
      const all = toNodes(rowsRef.current);
      const intent = resolveTab(
        { shift: e.shiftKey },
        {
          nodes: scope.rootId === null ? all : scopeNodes(all, scope.rootId),
          scopeRootId: scope.rootId,
          blockId,
          isAnchor: (n) => anchorTypes.has(n.type),
        },
      );
      if (intent.type === "indent") editor.indent();
      else if (intent.type === "outdent") editor.outdent();
      else if (intent.type === "expand")
        makeBlockAPI(intent.blockId).setExpanded(true);
      return;
    }
    const activate = activateRef.current;
    if (e.key === "Enter") {
      e.preventDefault();
      if (activate) activate();
      // Nothing to fill in — keep typing on a fresh line below. The paragraph
      // type comes from the registry's own `defaultText` flag, so the editor
      // still names no block type.
      else insertParagraphBelow(editor);
      return;
    }
    if (e.key === " " && activate) {
      // Space activates but never seeds a paragraph: on a filled media object it
      // would be a surprise, and on the ones with native controls the browser
      // has its own meaning for it.
      e.preventDefault();
      activate();
    }
  }

  return (
    <BlockActivateContext.Provider value={register}>
      <InnerCaretContext.Provider value={holdInnerCaret}>
        <CaretCueContext.Provider value={cue}>
      <div
        ref={ref}
        tabIndex={0}
        // The row's own background handler treats a press that lands on the host
        // ITSELF (its margin, not its content) as a press on the row background,
        // so a marquee can still start from the empty strip beside a narrow
        // image. See `block-editor.tsx`'s `onPointerDown`.
        data-caret-host=""
        aria-label={label}
        aria-current={isFocused ? true : undefined}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
          // The cue is the host's own unless a box inside claimed it (see
          // `useCaretCueTarget`); `group/caret-host` is what the claimer reads.
        className={cn(
            "group/caret-host cursor-default",
              cueClaims > 0 || inner
              ? "outline-none"
              : cn("focus-ring rounded-md", isFocused && "bg-accent"),
        )}
      >
        {children}
      </div>
      </CaretCueContext.Provider>
      </InnerCaretContext.Provider>
    </BlockActivateContext.Provider>
  );
}
