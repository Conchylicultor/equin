import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import {
  Button,
  cn,
  useControlSize,
  type ControlSize,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  pagesTree,
  pageData,
  pageKindOf,
  setPageKind,
  type PageKind,
} from "@plugins/page/plugins/editor/core";
import { pageDetailPane } from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";

const flareIcon = symbol("flare");
const descriptionIcon = symbol("description");
const menuBookIcon = symbol("menu-book");
const arrowDownIcon = symbol("keyboard-arrow-down");

/**
 * The box the labelled pill occupies at each density — the control's height and
 * about the width of "Page ▾" — so the placeholder holds the pill's place in the
 * strip and nothing jumps when it arrives. Spelled out per density because
 * Tailwind only emits class names it can see as literals (a
 * `control-${size}` template would compile to nothing).
 */
const PILL_BOX: Record<ControlSize, string> = {
  xs: "control-xs w-16",
  sm: "control-sm w-20",
  md: "control-md w-20",
  lg: "control-lg w-24",
};

/** How the control shows each kind: its icon, its name, and its pressed tint. */
const KIND_LOOK: Record<
  PageKind["kind"],
  {
    icon: IconRef;
    label: string;
    hint: string;
    tint: string | null;
  }
> = {
  page: {
    icon: descriptionIcon,
    label: "Page",
    hint: "Agents can read it and add notes in their own cards. Your text stays yours.",
    tint: null,
  },
  "agent-page": {
    icon: flareIcon,
    label: "Agent page",
    hint: "Agents may write anywhere on it.",
    // The `info` wash agent notes wear.
    tint: "border-info/20 bg-info/10 text-info hover:bg-info/20 hover:text-info",
  },
  instructions: {
    icon: menuBookIcon,
    label: "Instructions",
    hint: "Standing instructions for every agent working under the parent page.",
    // The `primary` wash the inline `<instructions>` card wears.
    tint: "border-primary/35 bg-primary/10 text-primary-text hover:bg-primary/20 hover:text-primary-text",
  },
};

const KIND_ORDER: readonly PageKind["kind"][] = [
  "page",
  "agent-page",
  "instructions",
];

/**
 * Each kind's glyph in the menu wears the tone its pill does: muted for an
 * ordinary page, the `info` blue for an agent page, `primary` for
 * instructions.
 */
const MENU_ICON_TONE: Record<PageKind["kind"], string> = {
  page: "text-muted-foreground",
  "agent-page": "text-info",
  instructions: "text-primary-text",
};

/** The kind a radio row selects — a fresh instructions page starts non-global. */
function kindFor(k: PageKind["kind"]): PageKind {
  return k === "instructions"
    ? { kind: "instructions", global: false }
    : { kind: k };
}

/**
 * The page-kind control contributed to `pageDetailPane.Actions` — by the
 * user's choice, the ONLY thing on the open page that says what kind of page it
 * is: an ordinary page, an agent page (agents may write all of it), or an
 * instructions page (the human's standing instructions to agents working under
 * the parent page), with a Global switch that hands those instructions to every
 * conversation at its start.
 *
 * One labelled outlined pill — the kind's icon, its name, a chevron — tinted when
 * it is not an ordinary page, opening a small panel headed "Agents on this
 * page" of three radio rows — the kind's glyph, its name, its meaning as a
 * visible line (the kind IS a policy, so it is read before it is picked) and a
 * trailing tick — plus the switch. A
 * choice asks the server to change the page's kind (`setPageKind`, the one way a
 * kind changes after a page is born). It is deliberately not optimistic: the
 * trigger changes when the live `pagesTree` push of this page's row lands — the
 * same row that re-tints the parent page's row and the sidebar.
 *
 * While the page row is still loading it renders a placeholder the size of the
 * pill, never the pill: that would claim a kind before anything is known.
 */
export function PageKindControl() {
  const { pageId } = pageDetailPane.useParams();
  const size = useControlSize();
  const result = useLiveRow(pagesTree, pageId);
  const { mutateAsync } = useEndpointMutation(setPageKind);

  if (result.status === "loading") {
    return <Loading variant="block" className={PILL_BOX[size]} />;
  }
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={descriptionIcon}
        subject="the page kind"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  if (!result.found) return null;
  const kind = pageKindOf(pageData(result.row));
  const look = KIND_LOOK[kind.kind];

  const choose = async (next: PageKind) => {
    await mutateAsync({ params: { id: pageId }, body: { kind: next } });
  };

  return (
    <ControlPanelPopover
      // `described`: every row carries its meaning as a visible line, and the
      // role's width decides how many lines that wraps to.
      align="end"
      label="Page kind"
      trigger={
        // No tooltip: the label names the kind, and the panel it opens reads
        // out what each kind means.
        // An outlined pill (`frame`: the hairline and no fill of its own) at
        // the bar's height, its label in the caption role: the kind is a
        // setting of the page, quieter than the title beside it. Both glyphs
        // are 14px; the chevron sits a tier fainter than the label.
        <Button
          variant="frame"
          aria-label={`Page kind: ${look.label}`}
          aria-pressed={kind.kind !== "page"}
          // `px-sm`: the pill's own inset, tighter than a frame button's;
          // the margin sets it 4px further off the icon actions after it.
          className={cn(
            "px-sm text-caption font-medium text-muted-foreground hover:text-strong-foreground aria-expanded:text-strong-foreground",
            look.tint,
          )}
          style={{ marginRight: "var(--space-xs)" }}
        >
          <Icon icon={look.icon} className="size-3.5" />
          {look.label}
          <Icon
            icon={arrowDownIcon}
            className="size-3.5 text-faint-foreground"
          />
        </Button>
      }
    >
      <ControlPanel.Section label="Agents on this page">
        {KIND_ORDER.map((k) => (
          <ControlPanel.Row
            key={k}
            select="radio"
            checked={kind.kind === k}
            // The kind's own glyph leads the row, so the tick moves to its end.
            indicator="trailing"
            icon={
              <Icon icon={KIND_LOOK[k].icon} className={MENU_ICON_TONE[k]} />
            }
            description={KIND_LOOK[k].hint}
            onSelect={() => {
              if (kind.kind !== k) void choose(kindFor(k));
            }}
          >
            {KIND_LOOK[k].label}
          </ControlPanel.Row>
        ))}
      </ControlPanel.Section>
      {kind.kind === "instructions" && (
        <ControlPanel.Section>
          <ControlPanel.Row
            select="switch"
            checked={kind.global}
            description="Point every conversation at this page"
            onSelect={() => {
              void choose({ kind: "instructions", global: !kind.global });
            }}
          >
            Global
          </ControlPanel.Row>
        </ControlPanel.Section>
      )}
    </ControlPanelPopover>
  );
}
