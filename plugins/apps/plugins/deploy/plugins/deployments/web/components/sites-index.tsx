import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  type CreateOption,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  matchResource,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  NEW_SERVER_ID,
  serverDetailPane,
  servers,
  type ServerListRow,
} from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  deployments,
  deployRuns,
  type Deployment,
  type DeployRun,
} from "../../core";
import { useSiteStatuses, type SiteStatusOf } from "../internal/site-status";
import { sitePane } from "../panes";
import { AddDeploymentDialog } from "./add-deployment-dialog";
import { SITE_STATUS_OPTIONS, SiteStatusPill } from "./site-status-dot";
import { SiteMark, siteName } from "./site-page";
import type { GalleryViewOptions } from "@plugins/primitives/plugins/data-view/plugins/gallery/web";

const addIcon = symbol("add");
const commitIcon = symbol("commit");
const deployedIcon = symbol("schedule");

/**
 * The cards are panels (`GalleryViewOptions.card`): a site has no picture, so
 * its card is the mark, the hostname with its status pill, "composition ·
 * server", and a footer of the running commit and when it last deployed.
 */
const SITE_VIEW_OPTIONS = {
  gallery: { card: "panel" } satisfies GalleryViewOptions,
};

/**
 * Where the site card draws each field: the mark leads, the status pill ends
 * the title line, composition · server is the subtitle, and the footer is the
 * commit with the last deploy at its far end.
 */
const SITE_PLACE = {
  mark: "lead",
  status: "afterTitle",
  composition: "line2",
  server: "line2",
  commit: "trail",
  lastDeploy: "edge",
} as const;

/** The not-yet-loaded body renders no rows, so no status is ever asked. */
const NO_STATUS: SiteStatusOf = (id) => {
  throw new Error(`site status read before the run map loaded: ${id}`);
};

const SITES_VIEW = defineDataView("deploy.sites");

// `serverId` is the collection's one listed field; the index shows the
// server's NAME instead (its own `server` field below), so the raw id hides.
const SITE_OVERRIDES = fieldOverrides(deployments, {
  serverId: { visible: false, filterable: false, groupable: false },
});

/**
 * The app's landing page: every site — every deployment, across servers — with
 * where it is served, on which server, and how its last run went. A row opens
 * the site's page.
 *
 * The rows, the run map and the server registry are gated together
 * (`useCombinedResources`), so a status or a server name never renders from a
 * half-loaded snapshot.
 */
export function SitesIndex(): ReactNode {
  const loaded = useCombinedResources({
    rows: useLive(deployments),
    runs: useLive(deployRuns),
    statusOf: useSiteStatuses(),
    servers: useLive(servers),
  });
  return matchResource(loaded, {
    loading: () => (
      <SitesBody
        rows={[]}
        runs={{}}
        statusOf={NO_STATUS}
        servers={[]}
        readiness={loaded}
      />
    ),
    error: () => (
      <SitesBody
        rows={[]}
        runs={{}}
        statusOf={NO_STATUS}
        servers={[]}
        readiness={loaded}
      />
    ),
    ready: ({ rows, runs, statusOf, servers: serverRows }) => (
      <SitesBody
        rows={rows}
        runs={runs}
        statusOf={statusOf}
        servers={serverRows}
        readiness={loaded}
      />
    ),
  });
}

function SitesBody({
  rows,
  runs,
  statusOf,
  servers: serverRows,
  readiness,
}: {
  rows: readonly Deployment[];
  runs: Record<string, DeployRun>;
  statusOf: SiteStatusOf;
  servers: readonly ServerListRow[];
  readiness: ResourceReadiness;
}): ReactElement {
  const openPane = useOpenPane();

  const extraFields = useMemo<FieldDef<Deployment>[]>(() => {
    const serverName = new Map<string, string>(
      serverRows.map((s) => [s.id, s.name]),
    );
    return [
      {
        // The card's leading visual: the site's mark, as on its page.
        id: "mark",
        label: "Mark",
        type: "avatar",
        value: (d) => siteName(d),
        cell: (d) => <SiteMark name={siteName(d)} size="sm" />,
        sortable: false,
        filterable: false,
      },
      {
        id: "site",
        label: "Site",
        type: "text",
        primary: true,
        value: (d) => siteName(d),
      },
      {
        id: "composition",
        label: "Composition",
        type: "text",
        value: (d) => d.compositionId,
      },
      {
        id: "server",
        label: "Server",
        type: "text",
        // A deployment's server cascades on delete, so a name is always there
        // once the registry has landed; the id stands in only for a row that
        // outran the registry's own update.
        value: (d) => serverName.get(d.serverId) ?? d.serverId,
      },
      {
        id: "status",
        label: "Status",
        type: "enum",
        options: SITE_STATUS_OPTIONS,
        value: (d) => statusOf(d.id),
        cell: (d) => <SiteStatusPill status={statusOf(d.id)} />,
      },
      {
        // The commit the newest run deployed.
        id: "commit",
        label: "Commit",
        type: "uuid",
        icon: commitIcon,
        value: (d) => runs[d.id]?.commitSha?.slice(0, 7) ?? "",
        cell: (d) => (
          <span className="font-mono">
            {runs[d.id]?.commitSha?.slice(0, 7) ?? ""}
          </span>
        ),
      },
      {
        id: "lastDeploy",
        label: "Last deploy",
        type: "date",
        icon: deployedIcon,
        value: (d) => {
          const at = runs[d.id]?.finishedAt;
          return at == null ? null : new Date(at);
        },
      },
    ];
  }, [runs, statusOf, serverRows]);

  const creators: CreateOption[] = [
    {
      id: "new-site",
      label: "New site",
      icon: <Icon icon={addIcon} />,
      onSelect: () => {
        // Fire-and-forget: awaiting `openDialog` would hold the toolbar's busy
        // flag for the dialog's whole open lifetime.
        void openDialog((close) => <AddDeploymentDialog close={close} />, {
          size: "md",
        });
      },
    },
  ];

  // The newest finished run across every site, for the header's one-line recap.
  const lastDeploy = Object.values(runs)
    .map((r) => r.finishedAt)
    .filter((t): t is string => t !== null)
    .sort()
    .at(-1);

  return (
    // The page column the site page reads at: centred, at most 1180px.
    <Stack gap="none" className="mx-auto w-full max-w-[1180px] px-xl pb-2xl">
      <Inset y="lg">
        <Text as="h1" variant="title">
          Overview
        </Text>
        <Text as="p" variant="caption" tone="muted">
          {plural(rows.length, "site")} · {plural(serverRows.length, "server")}
          {lastDeploy && (
            <>
              {" · last deploy "}
              <RelativeTime date={new Date(lastDeploy)} />
            </>
          )}
        </Text>
      </Inset>
      <DataView<Deployment>
        rows={rows}
        collection={deployments}
        overrides={SITE_OVERRIDES}
        extraFields={extraFields}
        rowKey={(d) => d.id}
        views={["gallery", "list", "table"]}
        defaultView="gallery"
        viewOptions={SITE_VIEW_OPTIONS}
        place={SITE_PLACE}
        storageKey={SITES_VIEW}
        readiness={readiness}
        creators={creators}
        actions={
          <Button
            variant="outline"
            {...openPane.link(
              serverDetailPane,
              { serverId: NEW_SERVER_ID },
              { mode: "root" },
            )}
          >
            Add server
          </Button>
        }
        rowActivation={(d) =>
          openPane.to(sitePane, { deploymentId: d.id }, { mode: "root" })
        }
        emptyState="No sites yet. Add a server, then a site on it."
      />
    </Stack>
  );
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
