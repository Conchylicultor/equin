import { useMemo, type ReactElement } from "react";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/web";
import { SECRETS_DIR_DISPLAY } from "@plugins/infra/plugins/paths/plugins/display/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  PaneChrome,
  usePaneMatch,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import {
  asNamespace,
  namespaceUrl,
  MAIN_COMPOSITION_ID,
} from "@plugins/infra/plugins/namespace/core";
import { Auth, type IntegrationStatus } from "../slots";
import { useAuthState } from "../hooks";
import { accountsPane, accountPane } from "../panes";
import { useProviderStatus } from "./provider-status";
import { IntegrationStatusBadge } from "./integration-presentation";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const ACCOUNTS_VIEW = defineDataView("auth.accounts");

/** The main app — where the shared token store lives. */
const ACCOUNT_PLACE = {
  icon: "lead",
  summary: "line2",
  status: "edge",
} as const;

const MAIN_URL = namespaceUrl(asNamespace(MAIN_COMPOSITION_ID));

/**
 * One Accounts row: an auth provider or an integration, presented alike. Every
 * row opens the same account pane to the right of the list, which renders its
 * status, account and setup — so there is one way in to each of them.
 */
interface AccountRow {
  id: string;
  name: string;
  icon: IconRef;
  service: string;
  description: string;
  useStatus: Hook<
    () => ResourceResult<IntegrationStatus> | ResourceUnavailable
  >;
}

export function AccountsPane(): ReactElement {
  const authState = useAuthState();
  const providers = Auth.Provider.useContributions();
  const integrations = Auth.Integration.useContributions();
  const openPane = useOpenPane();
  const match = usePaneMatch();

  const rows = useMemo<AccountRow[]>(
    () => [
      ...providers.map((p) => ({
        id: p.id,
        name: p.name,
        icon: p.icon,
        service: p.service ?? p.name,
        description: p.description ?? "",
        useStatus: () => useProviderStatus(p.id),
      })),
      ...integrations.map((i) => ({
        id: i.id,
        name: i.name,
        icon: i.icon,
        service: i.service,
        description: i.description,
        useStatus: i.useStatus,
      })),
    ],
    [providers, integrations],
  );

  // The selected row is the one whose pane sits right of the list.
  const panes = match?.panes ?? [];
  const child =
    panes[panes.findIndex((e) => e.pane.id === accountsPane.id) + 1];
  const selectedId =
    child?.pane.id === accountPane.id ? child.params.accountId : undefined;

  const fields = useMemo<FieldDef<AccountRow>[]>(() => {
    const services = [...new Set(rows.map((r) => r.service))].sort();
    return [
      {
        id: "name",
        label: "Name",
        type: "text",
        primary: true,
        value: (r) => r.name,
        sortable: true,
      },
      {
        id: "icon",
        label: "Icon",
        type: "text",
        value: (r) => r.id,
        cell: (r) => <Icon icon={r.icon} />,
        filterable: false,
      },
      {
        id: "summary",
        label: "Account",
        type: "multiline-text",
        // Who is signed in (or what it unlocks): the row's live status line.
        value: (r) => r.description,
        cell: (r) => <AccountSummary row={r} />,
        filterable: false,
      },
      {
        id: "status",
        label: "Status",
        type: "text",
        value: (r) => r.id,
        cell: (r) => <AccountStatus row={r} />,
        filterable: false,
      },
      {
        id: "service",
        label: "Service",
        type: "enum",
        value: (r) => r.service,
        options: services.map((s) => ({ value: s, label: s })),
        filterable: true,
        groupable: true,
        sortable: true,
        visible: false,
      },
      {
        id: "description",
        label: "What it unlocks",
        type: "text",
        value: (r) => r.description,
        visible: false,
      },
    ];
  }, [rows]);

  return (
    <PaneChrome pane={accountsPane}>
      <Stack gap="md" className="rail-lg">
        <Text as="p" variant="caption" tone="muted" className="px-md">
          Tokens and keys are stored encrypted in
          {/* eslint-disable-next-line spacing/no-adhoc-spacing -- inline-code chip needs horizontal breathing room in flowing prose */}
          <code className="mx-1">{SECRETS_DIR_DISPLAY}/</code>
          on the main app and shared with all worktrees.
        </Text>

        {authState.status === "ready" && authState.data.mainOffline ? (
          <Text
            as="div"
            variant="body"
            className="rounded-md border border-warning/50 bg-warning/10 p-md text-warning"
          >
            The main app is offline. Worktrees can&apos;t read tokens until it
            comes back. Visit{" "}
            <a
              className="underline"
              href={MAIN_URL}
              target="_blank"
              rel="noreferrer"
            >
              {MAIN_URL}
            </a>{" "}
            to start it.
          </Text>
        ) : null}

        {authState.status === "error" ? (
          <ResourceErrorInline
            variant="inline"
            subject="the auth state"
            error={authState.error}
            refetch={authState.refetch}
          />
        ) : null}

        <DataView<AccountRow>
          rows={rows}
          fields={fields}
          rowKey={(r) => r.id}
          views={["list"]}
          storageKey={ACCOUNTS_VIEW}
          selectedRowId={selectedId}
          rowActivation={(r) =>
            openPane.to(accountPane, { accountId: r.id }, { mode: "push" })
          }
          searchAccessor={(r) => `${r.name} ${r.service} ${r.description}`}
          searchPlaceholder="Search accounts…"
          place={ACCOUNT_PLACE}
          emptyState={<>No account or integration plugin is installed.</>}
        />
      </Stack>
    </PaneChrome>
  );
}

/** Who is signed in (or what it unlocks) — the row's second line. */
function AccountSummary({ row }: { row: AccountRow }): ReactElement {
  const status = row.useStatus();
  const summary =
    status.status === "ready" && status.data.summary
      ? status.data.summary
      : row.description;
  return (
    <Text variant="caption" tone="muted" className="truncate">
      {summary}
    </Text>
  );
}

/** The row's connection status badge. */
function AccountStatus({ row }: { row: AccountRow }): ReactElement {
  return <IntegrationStatusBadge result={row.useStatus()} />;
}
