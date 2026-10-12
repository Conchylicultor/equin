import {
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  cn,
  Input,
  useControlSize,
  type ControlSize,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Breadcrumb,
  type BreadcrumbProps,
} from "@plugins/primitives/plugins/breadcrumb/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { FloatingSurface } from "@plugins/primitives/plugins/overlay/plugins/floating-surface/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  runActivation,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  CRUMBS,
  commitTarget,
  editText,
  pathBarReducer,
  readyItems,
  splitSuggestion,
} from "./path-bar-machine";
import type { PathBarSource, PathTarget } from "./types";

const editIcon = symbol("edit");

/** The keyboard shortcut that turns the crumbs into the field. */
const EDIT_KEYS = "mod+l";

/** Crumb mode stands at exactly the field's height, so flipping between the two
 *  moves nothing. Literal per tier so the utilities are extracted. */
const CONTROL_HEIGHT: Record<ControlSize, string> = {
  xs: "control-xs",
  sm: "control-sm",
  md: "control-md",
  lg: "control-lg",
};

export interface PathBarProps {
  /** The current path (crumb mode shows its segments). */
  path: string;
  source: PathBarSource;
  /**
   * What going to a resolved path does — a crumb's activation, and what Enter
   * on a valid typed path runs. A `LinkTarget` for a bar whose places are
   * links, so ⌘/middle-click on a crumb opens it in a new browser tab.
   */
  activationFor: (target: PathTarget) => Activation;
  /**
   * Register ⌘L / Ctrl+L to start editing, scoped to the surface the bar is
   * rendered in. Default `true`; a surface with two path bars turns it off on
   * one of them.
   */
  shortcut?: boolean;
  /** The crumbs' type role, forwarded to the trail (`Breadcrumb.text`). */
  text?: BreadcrumbProps["text"];
  /** The current place's weight, forwarded to the trail (`Breadcrumb.leafWeight`). */
  leafWeight?: BreadcrumbProps["leafWeight"];
  className?: string;
}

/**
 * Dolphin-style path bar: a breadcrumb that turns into a text field.
 *
 * - **Crumbs** — the `primitives/breadcrumb` trail (ancestors navigate, overflow
 *   folds into a menu). A press on empty space or the current crumb, the pencil,
 *   or ⌘L flips to the field.
 * - **Field** — mono, pre-filled with the path plus a separator and selected,
 *   with a combobox of the source's completions (max 8, the typed stem bold):
 *   ↑ / ↓ move, Tab completes the highlighted (or first) one plus a separator,
 *   Enter commits the highlighted one or the typed text, Esc and blur revert.
 *   A commit that does not resolve stays in the field, marked invalid with the
 *   source's reason.
 *
 * Generic over `source`: it imports no filesystem.
 */
export function PathBar({
  path,
  source,
  activationFor,
  shortcut = true,
  text: trailText,
  leafWeight,
  className,
}: PathBarProps): ReactNode {
  const separator = source.separator ?? "/";
  const [state, dispatch] = useReducer(pathBarReducer, CRUMBS);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Bumped whenever an edit session starts or ends, so a validation that
  // settles after the user has already left (Esc, blur) navigates nowhere.
  const session = useRef(0);
  const listId = useId();
  const density = useControlSize();

  const segments = useMemo(() => source.segments(path), [source, path]);

  const start = useEventCallback(() => {
    session.current += 1;
    dispatch({ type: "start", text: editText(path, separator) });
  });
  const cancel = useEventCallback(() => {
    session.current += 1;
    dispatch({ type: "cancel" });
  });

  const shortcuts = useMemo(
    () =>
      shortcut
        ? [
            {
              id: "path-bar.edit",
              keys: EDIT_KEYS,
              label: "Edit the path",
              handler: () => start(),
            },
          ]
        : [],
    [shortcut, start],
  );
  useSurfaceShortcuts(shortcuts);

  const editing = state.mode === "editing";
  const text = editing ? state.text : null;
  const pending = editing && state.suggestions.kind === "pending";

  // Entering the field: focus it with the whole text selected, so typing
  // replaces the path and an arrow key keeps it.
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  // Completions for the text in the field. Keyed by the text they were asked
  // for (the reducer drops an answer to an older keystroke), so no request
  // needs cancelling.
  useEffect(() => {
    if (text === null || !pending) return;
    const forText = text;
    // completion fetch: the source's completions for the typed text are external data, requested whenever the field's text changes; the reducer discards an answer to stale text
    source.complete(forText).then(
      (items) =>
        dispatch({
          type: "suggestions",
          forText,
          result: { kind: "ready", items },
        }),
      (err: unknown) =>
        dispatch({
          type: "suggestions",
          forText,
          result: { kind: "failed", message: errorMessage(err) },
        }),
    );
  }, [text, pending, source]);

  const commit = useEventCallback((target: string) => {
    const mine = session.current;
    dispatch({ type: "validating" });
    source.validate(target).then(
      (resolution) => {
        if (session.current !== mine) return;
        if (resolution.kind === "invalid") {
          dispatch({
            type: "invalid",
            reason: resolution.reason ?? `Nothing at ${resolution.path}`,
          });
          return;
        }
        session.current += 1;
        dispatch({ type: "cancel" });
        runActivation(activationFor(resolution));
      },
      (err: unknown) => {
        if (session.current !== mine) return;
        dispatch({
          type: "invalid",
          reason: `Could not check this path: ${errorMessage(err)}`,
        });
      },
    );
  });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (state.mode !== "editing") return;
    const items = readyItems(state);
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (items.length === 0) return;
        e.preventDefault();
        dispatch({ type: "move", delta: e.key === "ArrowDown" ? 1 : -1 });
        return;
      case "Tab":
        if (e.shiftKey || items.length === 0) return;
        e.preventDefault();
        dispatch({ type: "complete", separator });
        return;
      case "Enter": {
        e.preventDefault();
        if (state.validating) return;
        const target = commitTarget(state, separator);
        if (target) commit(target);
        return;
      }
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        cancel();
        return;
    }
  };

  // A press anywhere in the crumb bar that is not a crumb (or another control)
  // starts editing: the empty space after the trail, the current crumb's name.
  // DOM containment, not React bubbling — the overflow menu portals out of the
  // bar, and a press in it must stay a menu press.
  const onCrumbsMouseDown = (e: MouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (!e.currentTarget.contains(target)) return;
    if (target.closest("button, a, [role='menuitem']")) return;
    e.preventDefault();
    start();
  };

  if (state.mode === "crumbs") {
    return (
      <Stack
        direction="row"
        align="center"
        gap="2xs"
        data-path-bar="crumbs"
        title="Click to type a path"
        onMouseDown={onCrumbsMouseDown}
        className={cn(
          hoverRevealGroup,
          CONTROL_HEIGHT[density],
          "cursor-text rounded-lg border border-transparent px-2xs hover:bg-muted/60",
          className,
        )}
      >
        <Breadcrumb
          segments={segments.map((seg) => ({
            ...seg,
            activation: activationFor({ kind: "dir", path: seg.path }),
          }))}
          text={trailText}
          leafWeight={leafWeight}
        />
        <IconButton
          icon={editIcon}
          label="Edit the path"
          shortcut={shortcut ? EDIT_KEYS : undefined}
          variant="ghost"
          onClick={() => start()}
          className={cn(rigidClass(), hoverRevealTarget)}
        />
      </Stack>
    );
  }

  const items = readyItems(state);
  const activeId =
    state.highlighted >= 0 ? `${listId}-${state.highlighted}` : undefined;
  const showPanel =
    items.length > 0 ||
    state.suggestions.kind === "failed" ||
    state.invalid !== null;

  return (
    <div
      ref={setAnchor}
      data-path-bar="editing"
      className={cn("relative w-full", className)}
    >
      <Input
        ref={inputRef}
        value={state.text}
        readOnly={state.validating}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-label="Path"
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        aria-invalid={state.invalid !== null || undefined}
        onChange={(e) => dispatch({ type: "input", text: e.target.value })}
        onKeyDown={onKeyDown}
        onBlur={() => cancel()}
        className={cn("font-mono", state.invalid && "text-destructive")}
      />
      <FloatingSurface
        open={showPanel}
        anchor={anchor}
        width="anchor"
        maxHeight="md"
      >
        {state.invalid && (
          <Text
            as="div"
            role="alert"
            variant="caption"
            tone="destructive"
            className="px-xs py-2xs"
          >
            {state.invalid.reason}
          </Text>
        )}
        {state.suggestions.kind === "failed" && (
          <Text
            as="div"
            variant="caption"
            tone="muted"
            className="px-xs py-2xs"
          >
            No suggestions: {state.suggestions.message}
          </Text>
        )}
        {items.length > 0 && (
          <Stack gap="none" role="listbox" id={listId} aria-label="Suggestions">
            {items.map((item, i) => {
              const parts = splitSuggestion(item, state.text, separator);
              const active = i === state.highlighted;
              return (
                <button
                  key={item}
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  // Keep the field focused: a blur would revert the edit
                  // before the click lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(item);
                  }}
                  className={cn(
                    "block w-full truncate rounded-md px-xs py-2xs text-left font-mono text-caption",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted",
                  )}
                >
                  <span className="text-muted-foreground">{parts.parent}</span>
                  <b className="font-semibold">{parts.match}</b>
                  {parts.rest}
                </button>
              );
            })}
          </Stack>
        )}
      </FloatingSurface>
    </div>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
