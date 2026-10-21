import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
  type FieldOption,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import type { HostedToolbar } from "@plugins/primitives/plugins/data-view/core";
import type { HostedToolbarParts } from "@plugins/primitives/plugins/data-view/core";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { useRevealOnActive } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { subThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { appLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { conversationRoute } from "@plugins/conversations/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import type {
  OptionPicks,
  PrototypeHistory,
  PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { PrototypeVersionActions } from "../slots";
import { declaresVariant } from "../internal/version-steps";
import { frameChipsTheme, versionRowsTheme } from "../internal/sub-themes";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const libraryAddIcon = symbol("library-add");
const filterIcon = symbol("filter-list");

const VERSIONS_VIEW = defineDataView("prototypes.versions");

/**
 * What a row action may do to the frame whose list it sits in: the version that
 * frame shows (its sha, `undefined` on the unsaved stop), and — when the list
 * belongs to a canvas frame — `compare`, which opens a version in a new frame
 * beside it.
 */
export interface VersionListFrame {
  shownSha: string | undefined;
  compare: ((version: PrototypeVersion) => void) | undefined;
}

export const VersionListFrameContext = createContext<VersionListFrame>({
  shownSha: undefined,
  compare: undefined,
});

/**
 * How each kind of version reads. Keyed by the store's closed kind set, so a
 * kind added there is a type error here until it is given a label.
 */
const KIND_LABELS: Record<PrototypeVersion["kind"], FieldOption> = {
  baseline: { value: "baseline", label: "Baseline", variant: "muted" },
  turn: { value: "turn", label: "Agent turn", variant: "muted" },
  restore: { value: "restore", label: "Restore", variant: "info" },
  manual: { value: "manual", label: "Checkpoint", variant: "primary" },
};

// The fields search, filter and sort read. Each row draws itself
// (`VersionRow`: number · request · when), so their order here is only the
// order the view's settings list them in.
const FIELDS: FieldDef<PrototypeVersion>[] = [
  {
    id: "subject",
    label: "Request",
    type: "text",
    primary: true,
    value: (v) => v.subject,
  },
  {
    id: "n",
    label: "Version",
    type: "int",
    value: (v) => v.n,
    cell: (v) => `v${v.n}`,
  },
  {
    id: "kind",
    label: "Kind",
    type: "enum",
    value: (v) => v.kind,
    options: Object.values(KIND_LABELS),
  },
  {
    id: "at",
    label: "When",
    type: "date",
    value: (v) => new Date(v.at),
    cell: (v) => <RelativeTime date={new Date(v.at)} />,
    align: "end",
  },
];

/**
 * What the list's header shows and toggles — read by the hosted frame, which is
 * a module-scope component and so takes no props of its own.
 */
interface VersionListHeader {
  /** "25 versions", or "12 of 25 versions" while the filter hides some. */
  count: string;
  /** The "This variant" filter, when the frame has a variant to filter by. */
  filter: { on: boolean; toggle: () => void } | null;
}

const VersionListHeaderContext = createContext<VersionListHeader | null>(null);

/**
 * Every recorded version of one prototype, as a list (newest first, by its
 * config's sort). Picking a row shows that version; `selected` is the one on
 * screen, when it is a recorded one (the "unsaved changes" stop is not a
 * version, so nothing is highlighted there).
 *
 * **This variant** (on by default, offered only when `picks` holds a pick):
 * keeps the versions whose own page declares every value the frame picked —
 * the versions this frame can step onto and still show the variant it shows.
 * A version that lacks one of them would open it at that option's default (or
 * without the option at all), so it is a different variant. A frame on every
 * default has no variant to filter by: every version shows its defaults.
 */
export function VersionList({
  history,
  picks,
  selected,
  onPick,
}: {
  history: PrototypeHistory;
  /** The frame's picks (defaults left out) — what "This variant" keeps. */
  picks: OptionPicks | undefined;
  selected: string | undefined;
  onPick: (version: PrototypeVersion) => void;
}): ReactElement {
  const [variantOnly, setVariantOnly] = useState(true);
  const filterable = picks !== undefined && Object.keys(picks).length > 0;
  const filtering = filterable && variantOnly;
  const rows = filtering
    ? history.versions.filter((v) => declaresVariant(v.options, picks))
    : history.versions;
  const total = history.versions.length;
  const noun = total === 1 ? "version" : "versions";
  const count =
    rows.length === total
      ? `${String(total)} ${noun}`
      : `${String(rows.length)} of ${String(total)} ${noun}`;
  const header = useMemo<VersionListHeader>(
    () => ({
      count,
      filter: filterable
        ? { on: variantOnly, toggle: () => setVariantOnly((on) => !on) }
        : null,
    }),
    [count, filterable, variantOnly],
  );
  const newestSha = history.versions.at(-1)?.sha;
  return (
    <VersionListHeaderContext value={header}>
      <Theme name={subThemeScope(versionRowsTheme)} surface="none">
        <DataView<PrototypeVersion>
          storageKey={VERSIONS_VIEW}
          toolbar={VERSIONS_TOOLBAR}
          rows={rows}
          fields={FIELDS}
          rowKey={(v) => v.sha}
          views={["list"]}
          defaultView="all"
          density="compact"
          selectedRowId={selected}
          onRowActivate={onPick}
          itemActions={PrototypeVersionActions}
          searchAccessor={(v) => `v${v.n} ${v.subject}`}
          emptyState="No version matches."
          viewOptions={{
            list: {
              size: "md",
              renderRow: (v: PrototypeVersion) => (
                <VersionRow
                  version={v}
                  current={v.sha === selected}
                  newest={v.sha === newestSha}
                />
              ),
            },
          }}
        />
      </Theme>
    </VersionListHeaderContext>
  );
}

/**
 * The list's header — `25 versions`, the search behind its hover-revealed
 * options trigger, and the This variant chip — over the rows, which scroll
 * under it from 340px.
 */
function VersionsFrame({ options, body }: HostedToolbarParts): ReactElement {
  const header = useContext(VersionListHeaderContext);
  if (header === null) {
    throw new Error("VersionsFrame renders inside VersionList");
  }
  return (
    <Stack gap="none">
      {/* `p-row`: the rows' own inset (8px 10px), so the count sits on their text. */}
      <Line className="gap-sm p-row">
        <Fill>
          <Text as="h5" variant="group" tone="muted">
            {header.count}
          </Text>
        </Fill>
        {options}
        {header.filter !== null ? (
          <VariantFilterChip
            on={header.filter.on}
            toggle={header.filter.toggle}
          />
        ) : null}
      </Line>
      <Scroll className="max-h-[340px]">{body}</Scroll>
    </Stack>
  );
}

const VERSIONS_TOOLBAR: HostedToolbar = {
  kind: "hosted",
  frame: VersionsFrame,
};

/** `This variant`: a 22px chip, tinted while on. */
function VariantFilterChip({
  on,
  toggle,
}: {
  on: boolean;
  toggle: () => void;
}): ReactElement {
  return (
    <Theme name={subThemeScope(frameChipsTheme)} surface="none">
      <ControlSizeProvider size="sm">
        <Button
          variant="frame"
          aria-pressed={on}
          onClick={toggle}
          className={cn(
            "text-muted-foreground",
            on && "border-primary/45 bg-primary/14 text-foreground",
          )}
        >
          <Icon icon={filterIcon} className="size-3" />
          <Text variant="tag">This variant</Text>
        </Button>
      </ControlSizeProvider>
    </Theme>
  );
}

/**
 * One version: `v12` (the accent on the one on screen), the request that made
 * it (muted unless it is the one on screen), and when — `latest` for the
 * newest. A kind other than a turn tags the request (Baseline, Restore,
 * Checkpoint).
 */
function VersionRow({
  version,
  current,
  newest,
}: {
  version: PrototypeVersion;
  current: boolean;
  newest: boolean;
}): ReactElement {
  return (
    <>
      <Text
        variant="code"
        tone={current ? "primary" : "faint"}
        className={cn(rigidClass(), "w-9 font-medium")}
      >
        {`v${String(version.n)}`}
      </Text>
      <Fill>
        <Text variant="body" tone={current ? "default" : "muted"}>
          {version.subject}
        </Text>
      </Fill>
      {version.kind === "turn" ? null : (
        <span
          className={cn(
            rigidClass(),
            "rounded-sm border border-border/64 px-xs text-3xs text-faint-foreground",
          )}
        >
          {KIND_LABELS[version.kind].label}
        </span>
      )}
      <span
        className={cn(rigidClass(), "font-mono text-2xs text-faint-foreground")}
      >
        {newest ? (
          "latest"
        ) : (
          <RelativeTime date={new Date(version.at)} format="short" />
        )}
      </span>
      {current ? <RevealOnMount /> : null}
    </>
  );
}

/**
 * Scrolls the row it sits in into view when it mounts — the current version,
 * each time the list opens (the popover unmounts it on close). Only the list
 * scrolls, never the page under the popover.
 */
function RevealOnMount(): ReactElement {
  const ref = useRevealOnActive(true, {
    revealOnMount: true,
    block: "nearest",
    scope: "nearest",
  });
  return <span aria-hidden ref={ref} />;
}

/**
 * The version list's one shipped row action: open the conversation whose turn
 * recorded this version. Nothing for a version no conversation made (the
 * baseline, a hand checkpoint, a restore from the CLI). A link, so ⌘-click opens
 * it in a new browser tab and leaves the prototype where it is.
 */
export function OpenVersionConversation({
  row,
}: ItemActionProps<PrototypeVersion>) {
  const convId = row.conversationId;
  if (convId === null) return null;
  return (
    <IconButton
      icon={navIcons.expand}
      label="Open the conversation that made it"
      {...appLinkProps(conversationRoute.link(agentManagerApp, { convId }))}
    />
  );
}

/**
 * Open this version in a new frame beside the one whose list it is — same
 * picks, this version — so an older design sits next to the current one. Not
 * offered on the version the frame already shows.
 */
export function CompareVersionAction({
  row,
}: ItemActionProps<PrototypeVersion>) {
  const { shownSha, compare } = useContext(VersionListFrameContext);
  if (compare === undefined || row.sha === shownSha) return null;
  return (
    <IconButton
      icon={libraryAddIcon}
      label={`Compare v${row.n} in a new frame`}
      onClick={() => compare(row)}
    />
  );
}
