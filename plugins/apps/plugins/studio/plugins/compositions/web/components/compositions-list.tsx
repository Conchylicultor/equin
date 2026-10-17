import { useMemo, type ReactElement } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  useCompositionData,
  useManifestItems,
  useManifestActions,
} from "@plugins/plugin-meta/plugins/composition/web";
import {
  asNamespace,
  namespaceHost,
  namespaceUrl,
  MAIN_COMPOSITION_ID,
} from "@plugins/infra/plugins/namespace/core";
import {
  isServableCompositionId,
  isServed,
  serveModeLabel,
  SERVE_MODE_OPTIONS,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";
import { useServeComposition } from "@plugins/build/plugins/serve-composition/web";
import { compositionDetailPane, comparePane } from "../panes";
import { CompositionItemActions } from "./composition-item-actions";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const compareIcon = symbol("compare");

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**. The
// views config is authored at
// `config/apps/studio/compositions/studio.compositions.jsonc` (groupBy category).
const COMPOSITIONS_VIEW = defineDataView("studio.compositions");

/**
 * The compositions list pane's body: the list-scoped action row (New / Compare)
 * above the DataView. The actions live here rather than in PaneChrome's header
 * because they act on the whole set rather than on the selected composition.
 */
export function CompositionsList(): ReactElement {
  const { data } = useCompositionData();
  const items = useManifestItems();
  const { save } = useManifestActions();
  const { setMode } = useServeComposition();
  const openPane = useOpenPane();
  // The URL is the selection — there is no local `editingId` state to drift.
  const selectedId = compositionDetailPane.useRouteEntry()?.params.id;

  // "New" writes the row first, then navigates to the id the write minted, so
  // the detail pane is always backed by a real config item.
  function newComposition(): void {
    const newId = save({
      name: "Untitled composition",
      entryPoints: [],
      selectedContributors: [],
    });
    openPane(
      compositionDetailPane,
      { id: newId },
      { mode: "push", side: "right" },
    );
  }

  return (
    <Inset pad="md">
      <Stack gap="lg">
        <Stack direction="row" align="center" gap="xs">
          <Button variant="outline" onClick={newComposition}>
            <Icon icon={addIcon} />
            New
          </Button>
          <Button
            variant="ghost"
            {...openPane.link(comparePane, {}, { mode: "push", side: "right" })}
          >
            <Icon icon={compareIcon} />
            Compare
          </Button>
        </Stack>

        {data.status === "loading" ? (
          <Loading variant="text" />
        ) : data.status === "error" ? (
          <ResourceErrorInline
            variant="block"
            subject="the composition graph"
            error={data.error}
            refetch={data.refetch}
          />
        ) : (
          <CompositionsDataView
            items={items}
            selectedId={selectedId ?? null}
            onSetMode={setMode}
            linkTo={(item) =>
              openPane.to(
                compositionDetailPane,
                { id: item.id },
                { mode: "push", side: "right" },
              )
            }
          />
        )}
      </Stack>
    </Inset>
  );
}

/**
 * The named compositions as a DataView `list`, grouped by `category` (the group
 * order — Profiles / Apps / Subsystems / Packs / Other — is the enum field's
 * `options` order; the section engine renders enum groups in options order). Each
 * row opens the composition's detail pane (`rowActivation`, a link); the entry /
 * contributor / extends counts are typed `int` fields (trailing chips, replacing
 * the old summary badge) so they come with sort / filter for free. A per-row
 * Delete lives in the hover-trailing item-actions slot; the `category` field is a
 * pure group/filter dimension kept out of the row body via the config's
 * `properties`. GroupBy + properties are authored in
 * `config/apps/studio/compositions/studio.compositions.jsonc`.
 */
function CompositionsDataView({
  items,
  selectedId,
  linkTo,
  onSetMode,
}: {
  items: CompositionManifestItem[];
  selectedId: string | null;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (item: CompositionManifestItem) => LinkTarget;
  onSetMode: (id: string, mode: string) => void;
}) {
  const fields = useMemo<FieldDef<CompositionManifestItem>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        type: "text",
        value: (it) => it.name,
        primary: true,
        sortable: true,
      },
      {
        id: "category",
        label: "Category",
        type: "enum",
        value: (it) => it.category,
        // Options order is the group display order (profile / app / subsystem /
        // pack, then any other); `other` catches categories outside the taxonomy.
        options: [
          { value: "profile", label: "Profiles" },
          { value: "app", label: "Apps" },
          { value: "subsystem", label: "Subsystems" },
          { value: "pack", label: "Packs" },
          { value: "other", label: "Other" },
        ],
        sortable: true,
        filterable: true,
      },
      {
        // The app bare `/` lands on when this composition is deployed — edited
        // in the detail pane's Home app section.
        id: "home",
        label: "Home",
        type: "text",
        value: (it) => it.home,
        cell: (it) =>
          it.home ? (
            <span className="text-muted-foreground">{it.home}</span>
          ) : null,
        sortable: true,
      },
      {
        id: "entryCount",
        label: "Entry points",
        type: "int",
        value: (it) => it.entryPoints.length,
        cell: (it) => (
          <span className="tabular-nums text-muted-foreground">
            {it.entryPoints.length} entry
          </span>
        ),
        align: "end",
        sortable: true,
      },
      {
        id: "contributorCount",
        label: "Contributors",
        type: "int",
        value: (it) => it.selectedContributors.length,
        cell: (it) => (
          <span className="tabular-nums text-muted-foreground">
            {it.selectedContributors.length} sel
          </span>
        ),
        align: "end",
        sortable: true,
      },
      {
        id: "extendsCount",
        label: "Extends",
        type: "int",
        value: (it) => it.extends.length,
        cell: (it) =>
          it.extends.length > 0 ? (
            <span className="tabular-nums text-muted-foreground">
              {it.extends.length} ext
            </span>
          ) : null,
        align: "end",
        sortable: true,
      },
      {
        // The serve mode: whether the composition is meant to be live here and,
        // for the automatic modes, how often it may be rebuilt. An enum, so
        // group / filter / sort come for free. The trailing cell stays a
        // one-click switch between the two ends a list can meaningfully offer —
        // `off` and `manual`; the cadences are picked in the composition's own
        // Build & serve panel, and the chip shows the one in force.
        id: "serve",
        label: "Serve",
        type: "enum",
        value: (it) => it.serve,
        options: [...SERVE_MODE_OPTIONS],
        align: "end",
        cell: (it) => {
          // Main's row carries the mode like every other row and can never act
          // on it: no serve build may provision main's namespace, so the switch
          // would write an intent nothing reads. Rendered inert rather than
          // pressable — the same "a control that cannot succeed must not be
          // pressable" rule the Serve panel applies to its `canServe`.
          const servable = isServableCompositionId(it.id);
          const served = isServed(it.serve);
          // Off and `manual` are the two states this chip can WRITE, so they
          // read as the plain switch they are. Any other mode is one the chip
          // cannot produce — name it, rather than flattening the cadences into
          // a single "Serving".
          const label = !served
            ? "Serve"
            : it.serve === "manual"
              ? "Serving"
              : serveModeLabel(it.serve);
          return (
            <ToggleChip
              active={served}
              disabled={!servable}
              tooltip={
                !servable
                  ? "The main app is built by ./singularity build — it is never served as a composition."
                  : served
                    ? `${serveModeLabel(it.serve)} — click to stop serving`
                    : `Click to build & serve this composition at ${namespaceUrl(asNamespace(it.id))}`
              }
              onClick={(e: { stopPropagation: () => void }) => {
                e.stopPropagation();
                // Writing `manual` rather than restoring whatever cadence the
                // row last had: this chip only ever wrote one "on", and the
                // mode a cadence row comes back to is a decision that belongs
                // on the panel that can show it.
                onSetMode(it.id, served ? "off" : "manual");
              }}
            >
              {label}
            </ToggleChip>
          );
        },
        sortable: true,
        filterable: true,
      },
      {
        // Live serve URL — see `serveHost` for why main's is not keyed on
        // `serve`. Namespace name == composition id, served by the gateway
        // at that subdomain.
        id: "serveUrl",
        label: "Serve URL",
        type: "text",
        value: (it) => serveHost(it) ?? "",
        cell: (it) => {
          const host = serveHost(it);
          return host ? (
            <LinkChip
              mono
              tooltip={`Open http://${host}`}
              activation={() => {
                window.open(`http://${host}`, "_blank", "noopener");
              }}
            >
              {host}
            </LinkChip>
          ) : null;
        },
        align: "end",
      },
    ],
    [onSetMode],
  );

  return (
    <DataView<CompositionManifestItem>
      rows={items}
      fields={fields}
      rowKey={(it) => it.id}
      views={["list"]}
      storageKey={COMPOSITIONS_VIEW}
      selectedRowId={selectedId ?? undefined}
      rowActivation={linkTo}
      itemActions={CompositionItemActions}
      emptyState={<>No named compositions yet. Create one with New.</>}
    />
  );
}

/**
 * The host a composition is reachable at, or `null` when nothing is served for
 * it.
 *
 * Main is the one row deliberately NOT keyed on `serve`. Its namespace is
 * where `./singularity build` deploys the repo's own app, so the address is a
 * standing fact of the setup rather than a consequence of a mode on this row —
 * keying it on `serve` would tie a URL that is already live to a control that
 * can never move. Every other composition is only reachable once its serve mode
 * is anything but `off`.
 *
 * `serve` remains intent rather than liveness here, exactly as before: the
 * composition's own Serve panel reads the `composition.json` marker for the
 * honest answer.
 */
function serveHost(it: CompositionManifestItem): string | null {
  // THE MAIN-CHECKOUT SPELLING, and knowingly so. A composition is served from
  // whichever checkout built it, so its real namespace is
  // `<id>.<checkout>` — which only the SERVER can resolve (the browser knows the
  // namespace it is talking to, and that does not decompose back into a pair).
  // This column is a list-wide, intent-derived hint and cannot afford a
  // per-row round-trip; the composition's own Serve panel asks
  // `serveStatusEndpoint` and shows the resolved host, which is the surface to
  // trust. Giving this column the true answer means a batched resolve — filed
  // as its own change rather than faked here.
  if (it.id === MAIN_COMPOSITION_ID)
    return namespaceHost(asNamespace(MAIN_COMPOSITION_ID));
  return isServed(it.serve) ? namespaceHost(asNamespace(it.id)) : null;
}
