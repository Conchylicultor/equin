import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  cn,
  ControlSizeProvider,
  Input,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";

import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");
const searchIcon = symbol("search");

/**
 * How the field is drawn.
 *
 * - `field` (default) — a bordered input box with a leading search icon: the
 *   standalone search field of a toolbar or panel.
 * - `bare` — no box of its own: it fills the cell it is placed in (a pill that
 *   already draws the border) with a leading icon, a borderless input and a
 *   trailing `/` key hint, its icon and placeholder in the faint text tier.
 *   Escape clears the query and leaves the field.
 * - `filled` — the `field` box drawn as a quiet grey well: the muted fill, no
 *   visible border, the theme radius, its icon and placeholder in the faint
 *   tier. Focus lifts it onto the surface colour with the fields' quiet border instead
 *   of the halo — a toolbar filter that should recede until it is used.
 * - `menu` — the search row leading a menu or picker panel, drawn as the
 *   panel's first row rather than a separate control: a row's height, corners,
 *   label text and inline geometry (box as wide as a row's fill, glyph in the
 *   rows' icon column, text on their label rail). Its fill and
 *   outline are the surface's field paint (inside a popover, the theme's
 *   `popoverField` / `popoverFieldBorder`).
 */
export type SearchInputAppearance = "field" | "bare" | "filled" | "menu";

/** What `filled` changes on the `field` box: the well, and how focus shows. */
const FILLED_INPUT =
  "border-transparent bg-muted dark:bg-muted placeholder:text-faint-foreground focus:bg-background dark:focus:bg-background focus-visible:ring-0";

/** The `menu` field's box: a panel row's height, corners and label text
 * (its inline geometry is the `menu-field` utility's). */
const MENU_INPUT = "h-(--panel-row-h) rounded-panel-row text-label font-normal";

// The `field` appearance is a compact field by construction: it declares the
// `sm` control size itself (as `Bar` does), so its height still follows the
// density preset's `control-sm` token while staying quieter than the content it
// filters. `bare` fills its host cell instead.
export type SearchInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "size"
> &
  DensityControlled & {
    wrapperClassName?: ClassName;
    appearance?: SearchInputAppearance;
    /** The `<input>` element — lets a host focus the field (e.g. on `/`). */
    ref?: React.Ref<HTMLInputElement>;
    /** Draw the field through an input that owns the query itself (a headless
     * library's search input, e.g. frimousse's), keeping this field's chrome.
     * Not for `bare`. */
    render?: React.ReactElement;
  };

export function SearchInput({
  className,
  wrapperClassName,
  appearance = "field",
  ...props
}: SearchInputProps) {
  const hasValue = typeof props.value === "string" && props.value.length > 0;

  const handleClear = () => {
    props.onChange?.({
      target: { value: "" },
    } as React.ChangeEvent<HTMLInputElement>);
  };

  if (appearance === "bare") {
    const { onKeyDown, ...inputProps } = props;
    return (
      <Line
        className={cn(
          "h-full gap-sm px-sm text-faint-foreground",
          wrapperClassName,
        )}
      >
        <Icon
          icon={searchIcon}
          className={cn("size-5", rigidClass())}
          aria-hidden
        />
        <Fill>
          <Input
            className={cn(
              "h-full rounded-none border-0 bg-transparent px-none text-body text-foreground shadow-none placeholder:text-faint-foreground focus-visible:ring-0 dark:bg-transparent",
              className,
            )}
            {...inputProps}
            onKeyDown={(e) => {
              onKeyDown?.(e);
              if (e.defaultPrevented || e.key !== "Escape") return;
              e.preventDefault();
              if (hasValue) handleClear();
              e.currentTarget.blur();
            }}
          />
        </Fill>
        {hasValue ? (
          <button
            type="button"
            onClick={handleClear}
            className={cn(
              "rounded-sm p-2xs text-muted-foreground hover:text-foreground focus:outline-none",
              rigidClass(),
            )}
            tabIndex={-1}
            aria-label="Clear filter"
          >
            <Icon icon={closeIcon} className="size-4" />
          </button>
        ) : (
          <Kbd className={rigidClass()}>/</Kbd>
        )}
      </Line>
    );
  }

  if (appearance === "menu") {
    // A row's geometry, not a field's: `menu-field` bleeds the box to a row's
    // fill and places the glyph, the text and the clear button on the rows'
    // icon column and label rail (see app.css).
    return (
      <div className={cn("menu-field", wrapperClassName)}>
        <span data-menu-field-glyph="" className="text-faint-foreground">
          <Icon icon={searchIcon} className="icon-auto" aria-hidden />
        </span>
        <Input className={cn(MENU_INPUT, className)} {...props} />
        {hasValue && (
          <span data-menu-field-clear="">
            <button
              type="button"
              onClick={handleClear}
              className="rounded-sm text-faint-foreground hover:text-foreground focus:outline-none"
              tabIndex={-1}
              aria-label="Clear filter"
            >
              <Icon icon={closeIcon} className="icon-auto" />
            </button>
          </span>
        )}
      </div>
    );
  }

  const filled = appearance === "filled";
  return (
    <div className={cn("relative", wrapperClassName)}>
      {/* off-ramp inset: left-2 (0.5rem) is not on the semantic spacing ramp */}
      <Pin
        to="left"
        decorative
        style={{ left: "0.5rem" }}
        className={filled ? "text-faint-foreground" : "text-muted-foreground"}
      >
        <Icon icon={searchIcon} className="size-3.5" />
      </Pin>
      <ControlSizeProvider size="sm">
        <Input
          className={cn(
            "pl-xl",
            hasValue && "pr-xl",
            filled && FILLED_INPUT,
            className,
          )}
          {...props}
        />
      </ControlSizeProvider>
      {hasValue && (
        // off-ramp inset: right-1.5 (0.375rem) is not on the semantic spacing ramp
        <Pin to="right" style={{ right: "0.375rem" }}>
          <button
            type="button"
            onClick={handleClear}
            className="rounded-sm p-2xs text-muted-foreground hover:text-foreground focus:outline-none"
            tabIndex={-1}
            aria-label="Clear filter"
          >
            <Icon icon={closeIcon} className="size-3" />
          </button>
        </Pin>
      )}
    </div>
  );
}
