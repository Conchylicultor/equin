import {
  createContext,
  useCallback,
  useContext,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";

/**
 * One place a crumb's menu offers: a page beside the crumb's own, or one inside
 * it (a submenu).
 */
export interface BreadcrumbPlace {
  key: string;
  label: ReactNode;
  /** Where choosing it goes — omit it and the row is shown but inert. */
  activation?: Activation;
  /**
   * The place is on the trail: the crumb's own page, or the one the trail goes
   * through below it. Listed first and marked, so the menu opens on where you
   * are.
   */
  onTrail?: boolean;
  /**
   * What is inside this place, as the element that reads and lists it (a
   * `<BreadcrumbPlaces>`): mounted only when its submenu opens, so a menu reads
   * one level at a time. Omit it for a place with nothing inside.
   */
  inside?: ReactElement;
}

export interface BreadcrumbPlacesProps {
  /** The places of one level, in their own order — or still being read. */
  places: readonly BreadcrumbPlace[] | "loading";
  /**
   * More places exist past the ones listed: the menu's last row reads them.
   * `growing` while that read is in flight.
   */
  more?: { load: () => void; growing: boolean };
  /**
   * What the menu says when the level holds no places (none loaded and no
   * more to read). Default "Nothing inside"; a level that lists only some
   * kind of place says which ("No folders" — the folder may hold files).
   */
  empty?: ReactNode;
}

/** Closes the whole menu tree once a place is chosen. */
const CloseMenu = createContext<() => void>(() => {
  throw new Error("BreadcrumbPlaces rendered outside a crumb's menu");
});

/** Hover intent: long enough that sweeping across the header opens nothing. */
const OPEN_DELAY_MS = 280;
/** Grace to cross the gap between the crumb and its menu. */
const CLOSE_DELAY_MS = 220;

/**
 * A crumb that opens its places on hover: resting on it lists the pages beside
 * it, while a click still goes to the crumb's own page — so the parent stays
 * one click away and a sibling one hover away.
 *
 * Controlled, so a press on a crumb that navigates never opens the menu (the
 * press is the navigation), and choosing a place closes the whole tree even
 * when the trail it lands on keeps this crumb.
 */
export function CrumbPlacesMenu({
  trigger,
  places,
  press,
  nativeButton,
}: {
  /** The crumb itself, rendered as the menu's trigger. */
  trigger: ReactElement;
  /** The crumb's menu content (a `<BreadcrumbPlaces>`), mounted while open. */
  places: ReactElement;
  /**
   * What a press on the crumb does: `navigate` goes to the crumb's own page
   * (an ancestor), so only hover opens the menu; `open` opens it too (the
   * leaf, which goes nowhere; the overflow crumb, whose press is its menu).
   */
  press: "navigate" | "open";
  /** Whether the trigger is a `<button>` (an ancestor, the overflow crumb) or text (the leaf). */
  nativeButton: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next, details) => {
        if (next && press === "navigate" && details.reason === "trigger-press")
          return;
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger
        openOnHover
        delay={OPEN_DELAY_MS}
        closeDelay={CLOSE_DELAY_MS}
        nativeButton={nativeButton}
        render={trigger}
      />
      <DropdownMenuContent align="start" maxHeight="xl">
        <CloseMenu.Provider value={close}>{places}</CloseMenu.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The on-trail place first (Notion's order), the rest in their own order. */
function onTrailFirst(
  places: readonly BreadcrumbPlace[],
): readonly BreadcrumbPlace[] {
  const here = places.findIndex((p) => p.onTrail === true);
  if (here <= 0) return places;
  return [
    places[here] as BreadcrumbPlace,
    ...places.slice(0, here),
    ...places.slice(here + 1),
  ];
}

/**
 * One level of a crumb's menu: its places as rows, the on-trail one first and
 * marked; a place with something inside opens it as a submenu on hover, while
 * a click on it still goes there. The menu scrolls past its height cap.
 */
export function BreadcrumbPlaces({
  places,
  more,
  empty = "Nothing inside",
}: BreadcrumbPlacesProps) {
  const close = useContext(CloseMenu);
  if (places === "loading") return <Loading variant="rows" count={3} />;
  // Empty only when nothing is left to read: a window with no places yet but
  // more past it (a page of files before the next folder) offers its More.
  if (places.length === 0 && more === undefined) {
    return (
      <DropdownMenuItem disabled className="text-muted-foreground">
        {empty}
      </DropdownMenuItem>
    );
  }
  const choose = (place: BreadcrumbPlace) => {
    const props = activationProps(place.activation);
    return {
      ...props,
      onClick(e: MouseEvent<HTMLElement>) {
        props.onClick?.(e);
        close();
      },
    };
  };
  return (
    <>
      {onTrailFirst(places).map((place) => {
        // Marked as the menu marks its chosen row (semibold), so where you are
        // reads the same here as in every picker.
        const trail =
          place.onTrail === true ? { "data-selected": "" } : undefined;
        if (place.inside === undefined) {
          return (
            <DropdownMenuItem
              key={place.key}
              disabled={place.activation === undefined}
              {...trail}
              {...choose(place)}
            >
              {place.label}
            </DropdownMenuItem>
          );
        }
        return (
          <DropdownMenuSub key={place.key}>
            <DropdownMenuSubTrigger
              disabled={place.activation === undefined}
              {...trail}
              {...choose(place)}
            >
              {place.label}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent maxHeight="xl">
              {place.inside}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
      {more && (
        <DropdownMenuItem
          closeOnClick={false}
          disabled={more.growing}
          className="text-muted-foreground"
          onClick={more.load}
        >
          {more.growing ? "Loading…" : "More"}
        </DropdownMenuItem>
      )}
    </>
  );
}
