import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { useMemo, useCallback, useState } from "react";

import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  matchResource,
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useConfigRegistrations } from "@plugins/config_v2/web";
import {
  configRawFile,
  configValues,
  removeDescriptorScope,
} from "@plugins/config_v2/core";
import type {
  ConfigV2ConflictEntry,
  ConfigV2ConflictLocations,
  ConfigV2Tiers,
  ConfigV2Values,
} from "@plugins/config_v2/core";
import { ControlPanelPane } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { HighlightedCode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { acknowledgeConflict, deleteOverride, mergeConflict } from "../../core";
import { configDetailPane } from "../internal/panes";
import { buildConflictContext } from "../internal/conflict-context";
import { conflictScopes } from "../internal/conflict-locations";
import { useScopeDisplay } from "../internal/scope-label";
import { useConflict, useConflictLocationsOf } from "../internal/use-conflicts";
import { useTiers } from "../internal/use-tiers";
import { ConfigDetailSlots } from "../slots";
import type { ConfigConflictContext } from "../slots";
import { ConfigField } from "./config-field";
import { ConflictDiff } from "./conflict-diff";
import { InvalidDiff } from "./invalid-diff";
import { ScopeTabs } from "./scope-tabs";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const warningIcon = symbol("warning");
const codeIcon = symbol("code");
const tuneIcon = symbol("tune");
const undoIcon = symbol("undo");
const differenceIcon = symbol("difference");
const mergeIcon = symbol("merge");
const layersClearIcon = symbol("layers-clear");

// The two banners' button tints, written once. Every action inside a banner —
// this file's own resolutions and the contributed ones alike — reads its tint
// from here, so a contributed button can't drift out of its banner's palette.
const WARNING_ACTION_CLASS = cn("bg-warning/20 hover:bg-warning/30");
const DESTRUCTIVE_ACTION_CLASS = cn(
  "bg-destructive/20 hover:bg-destructive/30",
);

// The contributed half of a conflict banner's action row — rendered leftmost, as
// the "get help with this" affordance ahead of the decisive resolutions. A
// component (rather than the render-prop inline at both call sites) so the two
// banners share one spelling and neither needs a non-null assertion.
function ConflictActions({ conflict }: { conflict: ConfigConflictContext }) {
  return (
    <ConfigDetailSlots.ConflictAction.Render>
      {(item) => <item.component conflict={conflict} />}
    </ConfigDetailSlots.ConflictAction.Render>
  );
}

// Walks a structured zod issue path (["items", 6]) into the stored document to
// recover the offending value, so the invalid banner can show exactly what's
// wrong. Returns MISSING when the path doesn't resolve (e.g. a required-but-absent
// key), which renders as "(value missing)" rather than a misleading `undefined`.
const MISSING = Symbol("missing");
function drillPath(root: unknown, path: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return MISSING;
    cur = (cur as Record<string | number, unknown>)[seg];
    if (cur === undefined) return MISSING;
  }
  return cur;
}

export function ConfigDetail() {
  const configPath = configDetailPane.useRouteEntry()?.params.configPath;
  const registrations = useConfigRegistrations();

  const registration = registrations.find(
    (r) => encodeURIComponent(r.storePath) === configPath,
  );

  if (!registration) {
    return <Placeholder>Config not found</Placeholder>;
  }

  // key on storePath so ConfigDetailInner remounts (and scopeId re-inits to Base)
  // whenever a different descriptor opens — no props-to-state mirror effect needed.
  return (
    <ConfigDetailInner
      key={registration.storePath}
      registration={registration}
    />
  );
}

// All-or-nothing gate over values + conflicts + tiers — none is boot-hydrated
// for an arbitrary scope, so all render loading on first paint. Gating the whole
// body avoids a flash of wrong tier badges or a transiently-absent conflict
// banner. The selected scope (undefined = Base) is local state owned here, above
// the gate, so a tab switch re-keys every read and re-gates atomically. We read
// values directly via the resource (not useConfig) so the body always reflects
// the SELECTED scope — useConfig's base-oriented gating (forked || committed)
// wouldn't fire for a fresh per-descriptor scope.
function ConfigDetailInner({
  registration,
}: {
  registration: ReturnType<typeof useConfigRegistrations>[number];
}) {
  const [scopeId, setScopeId] = useState<string | undefined>(undefined);

  // WHERE this descriptor conflicts — read alongside the selected scope's own
  // conflict, because the two answer different questions. The banner below the
  // tabs is the selected scope's; this is every scope's, and it is what turns a
  // row the nav flagged into a tab the user can actually get to.
  const conflictLocationsOf = useConflictLocationsOf();
  const locations = conflictLocationsOf(registration.storePath);

  const valuesRes = useLive(configValues, {
    path: registration.storePath,
    scopeId,
  });
  const conflictRes = useConflict(registration.storePath, scopeId);
  const tiersRes = useTiers(registration.storePath, scopeId);
  const gated = useCombinedResources({
    values: valuesRes,
    conflict: conflictRes,
    tiers: tiersRes,
  });

  return (
    <Stack gap="xs" className="p-md">
      <ScopeTabs
        storePath={registration.storePath}
        scopeId={scopeId}
        conflict={locations}
        onSelect={setScopeId}
      />
      <ConflictElsewhereBanner
        locations={locations}
        scopeId={scopeId}
        onSelectScope={setScopeId}
      />
      {/* A failed read renders the default block error with Retry. */}
      {matchResource(gated, {
        loading: () => <Loading />,
        ready: ({ values, conflict, tiers }) => (
          <ConfigDetailBody
            // Re-key on path+scope so the body remounts (transient UI flags re-init
            // to false) on a fresh editing context — no props-to-state mirror effect.
            key={registration.storePath + ":" + (scopeId ?? "")}
            registration={registration}
            scopeId={scopeId}
            onSelectScope={setScopeId}
            values={values}
            conflict={conflict}
            tiers={tiers}
          />
        ),
      })}
    </Stack>
  );
}

// The half of a conflict warning that used to have nowhere to go.
//
// A descriptor can conflict under an app scope while its base document is clean.
// The nav row flags it, the user clicks through — and the detail pane opens on
// Base, whose banner correctly says nothing. So this says where the conflict
// actually is, and takes them there. It renders only for scopes OTHER than the
// selected one: the selected scope's own conflict already has a banner below.
function ConflictElsewhereBanner({
  locations,
  scopeId,
  onSelectScope,
}: {
  locations: ConfigV2ConflictLocations | undefined;
  scopeId: string | undefined;
  onSelectScope: (scopeId: string | undefined) => void;
}) {
  const scopeDisplay = useScopeDisplay();
  const elsewhere = locations
    ? conflictScopes(locations).filter((sid) => sid !== scopeId)
    : [];
  if (elsewhere.length === 0) return null;

  return (
    <Text
      as="div"
      variant="body"
      // eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the pointer banner from the fields below (no named margin utility)
      className="mb-2 rounded-md border border-warning/30 bg-warning/10 px-md py-sm text-warning"
    >
      <Stack direction="row" gap="sm" align="center" wrap>
        <Icon icon={warningIcon} className={cn("size-4", rigidClass())} />
        <Fill as="span">
          {elsewhere.length === 1
            ? "This config has an unresolved conflict under another tab"
            : "This config has unresolved conflicts under other tabs"}
        </Fill>
        {elsewhere.map((sid) => (
          <Button
            key={sid ?? ""}
            variant="ghost"
            onClick={() => onSelectScope(sid)}
            className={WARNING_ACTION_CLASS}
          >
            Go to {scopeDisplay(sid).label}
          </Button>
        ))}
      </Stack>
    </Text>
  );
}

function ConfigDetailBody({
  registration,
  scopeId,
  onSelectScope,
  values,
  conflict,
  tiers,
}: {
  registration: ReturnType<typeof useConfigRegistrations>[number];
  scopeId: string | undefined;
  onSelectScope: (scopeId: string | undefined) => void;
  values: ConfigV2Values;
  conflict: ConfigV2ConflictEntry | null;
  tiers: ConfigV2Tiers;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const conflictEntry = conflict;

  // WHICH LAYER SUPPLIED EACH FIELD — the server's answer, read here rather than
  // re-derived. `tiers` is a record, so an indexed read is `| undefined`; the
  // server emits an entry for every field of the descriptor, so a miss is a bug,
  // not a "not modified". Answering `"default"` for it would be exactly the
  // unknown-renders-as-a-value collapse this plugin's read hooks exist to prevent.
  const tierFor = useCallback(
    (key: string): "default" | "git" | "user" => {
      const tier = tiers[key];
      if (!tier) {
        throw new Error(
          `[config-v2] no tier for field "${key}" of "${registration.storePath}"`,
        );
      }
      return tier;
    },
    [tiers, registration.storePath],
  );

  // During a conflict the app resolves config to the origin (origin takes
  // precedence until reconciled), so `useConfig` returns the origin values.
  // The editor must instead surface the user's override document so they can
  // see and fix what they configured. Fall back to the resolved value for keys
  // absent from a partial override.
  const valueFor = useCallback(
    (key: string): unknown => {
      // Only a hash conflict resolves the app to origin while the editor shows
      // the override. An "invalid" conflict resolves to defaults (= `values`)
      // and its override holds unparseable data, so bind fields to `values`.
      if (conflictEntry?.kind === "hash") {
        const override = conflictEntry.overrideValues;
        if (override && key in override) return override[key];
      }
      return values[key];
    },
    [conflictEntry, values],
  );

  const isSoftConflict = useMemo(() => {
    if (!conflictEntry) return false;
    for (const key of Object.keys(registration.descriptor.fields)) {
      if (
        JSON.stringify(valueFor(key)) !==
        JSON.stringify(conflictEntry.originValues[key])
      ) {
        return false;
      }
    }
    return true;
  }, [conflictEntry, valueFor, registration.descriptor.fields]);

  // "Reset all" deletes the user override document, so it is offered exactly when
  // that document still says something — i.e. when some field came from the user
  // layer. A field the repo commits (tier "git") is not something to reset.
  const hasAnyModified = useMemo(
    () =>
      Object.keys(registration.descriptor.fields).some(
        (key) => tierFor(key) === "user",
      ),
    [tierFor, registration.descriptor.fields],
  );

  // useEndpointMutation (not void fetchEndpoint) so a failed reset/dismiss
  // surfaces via the global error toast instead of escaping as an unhandled
  // rejection. The config view refreshes via its live-state resource on success.
  // Every reconcile body carries the selected `scopeId` (undefined = Base) so it
  // targets the scope the user is editing.
  //
  // `isPending` is threaded onto each button's `loading` prop. `Button` auto-pends
  // only when its onClick RETURNS a promise; these handlers use `mutate` (which
  // returns void so a rejection stays inside the mutation and reaches the global
  // toast, never an unhandled rejection), so the pending state has to be passed
  // explicitly — same shape as ServerDeleteAction. Without it a resolution that
  // works is indistinguishable from a dead button.
  const acknowledgeM = useEndpointMutation(acknowledgeConflict);
  const resetOverrideM = useEndpointMutation(deleteOverride);
  const removeScopeM = useEndpointMutation(removeDescriptorScope);
  // Merge is the one resolution whose success can leave the banner standing: when
  // fields conflict on both sides it keeps the stale hash on purpose so the
  // conflict stays surfaced. A spinner alone would read as "nothing happened", so
  // report the outcome — how many fields it settled, and how many still need the
  // user — from the response the endpoint already returns.
  const mergeM = useEndpointMutation(mergeConflict, {
    onSuccess: ({ resolved, conflictKeys }) => {
      showToast(
        resolved
          ? { description: "Merged — conflict resolved", variant: "success" }
          : {
              title: `${conflictKeys.length} field${conflictKeys.length === 1 ? "" : "s"} still need${conflictKeys.length === 1 ? "s" : ""} your attention`,
              description: `Merged the rest. Resolve ${conflictKeys.join(", ")} below, then merge again.`,
              variant: "warning",
            },
      );
    },
  });
  const { mutate: acknowledge } = acknowledgeM;
  const { mutate: resetOverride } = resetOverrideM;
  const { mutate: merge } = mergeM;
  const { mutate: removeScope } = removeScopeM;

  const handleDismiss = useCallback(() => {
    acknowledge({ body: { storePath: registration.storePath, scopeId } });
  }, [acknowledge, registration.storePath, scopeId]);

  const handleAcceptAll = useCallback(() => {
    resetOverride({ body: { storePath: registration.storePath, scopeId } });
  }, [resetOverride, registration.storePath, scopeId]);

  const handleMerge = useCallback(() => {
    merge({ body: { storePath: registration.storePath, scopeId } });
  }, [merge, registration.storePath, scopeId]);

  // A three-way merge is offered only when propagate captured an ancestor
  // snapshot (trueConflictKeys present). Its length is the count of fields the
  // user and upstream both changed differently — the ones needing attention.
  const trueConflictKeys =
    conflictEntry?.kind === "hash" ? conflictEntry.trueConflictKeys : undefined;
  const canMerge = trueConflictKeys !== undefined;

  // The conflict as data, for the contributed banner actions. Built here (not in
  // each contribution) so an action describes exactly what the user is looking
  // at — same `valueFor` the field rows bind to, same issue-path spelling the
  // banner prints. `null` whenever there is no conflict, so the two banners can
  // pass it through non-null.
  const conflictContext = useMemo(
    () =>
      conflictEntry
        ? buildConflictContext({
            storePath: registration.storePath,
            name: registration.pluginName,
            scopeId,
            conflict: conflictEntry,
            fields: registration.descriptor.fields,
            valueFor,
            actionClassName:
              conflictEntry.kind === "invalid"
                ? DESTRUCTIVE_ACTION_CLASS
                : WARNING_ACTION_CLASS,
          })
        : null,
    [
      conflictEntry,
      registration.storePath,
      registration.pluginName,
      registration.descriptor.fields,
      scopeId,
      valueFor,
    ],
  );

  const handleResetAll = useCallback(() => {
    resetOverride({ body: { storePath: registration.storePath, scopeId } });
    setConfirmReset(false);
  }, [resetOverride, registration.storePath, scopeId]);

  // "Stop customizing" — drops this descriptor's whole per-app customization
  // (distinct from "Reset all", which only reverts edits to the scoped origin).
  // The tab disappears via the live scopes resource, so fall back to Base.
  const handleStopCustomizing = useCallback(() => {
    if (!scopeId) return;
    removeScope({ body: { storePath: registration.storePath, scopeId } });
    onSelectScope(undefined);
  }, [removeScope, registration.storePath, scopeId, onSelectScope]);

  const toggleIcon = showRaw ? (
    <Icon icon={tuneIcon} className="size-3.5" />
  ) : (
    <Icon icon={codeIcon} className="size-3.5" />
  );

  return (
    <>
      <Stack
        direction="row"
        align="center"
        justify="end"
        gap="sm"
        // eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the action toolbar from the fields below (no named margin utility)
        className="mb-1"
      >
        {scopeId && !showRaw && (
          <Button
            variant="ghost"
            loading={removeScopeM.isPending}
            onClick={handleStopCustomizing}
          >
            <Icon icon={layersClearIcon} className="size-3.5" />
            Stop customizing
          </Button>
        )}
        {hasAnyModified &&
          !showRaw &&
          (confirmReset ? (
            <Stack direction="row" align="center" gap="xs">
              <Text variant="caption" tone="muted">
                Reset all fields?
              </Text>
              <Button
                variant="ghost"
                loading={resetOverrideM.isPending}
                onClick={handleResetAll}
                className="bg-destructive/20 text-destructive hover:bg-destructive/30"
              >
                Reset
              </Button>
              <Button variant="ghost" onClick={() => setConfirmReset(false)}>
                Cancel
              </Button>
            </Stack>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmReset(true)}>
              <Icon icon={undoIcon} className="size-3.5" />
              Reset all
            </Button>
          ))}
        <Button variant="ghost" onClick={() => setShowRaw((v) => !v)}>
          {toggleIcon}
          {showRaw ? "Fields" : "Raw file"}
        </Button>
      </Stack>
      {showRaw ? (
        <RawFileView storePath={registration.storePath} scopeId={scopeId} />
      ) : (
        <>
          {conflictEntry &&
            (conflictEntry.kind === "invalid" ? (
              <>
                <Text
                  as="div"
                  variant="body"
                  // eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the invalid banner from the fields below (no named margin utility)
                  className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-md py-sm text-destructive"
                >
                  <Stack gap="xs">
                    <Stack direction="row" gap="sm" align="center">
                      <Icon
                        icon={warningIcon}
                        className={cn("size-4", rigidClass())}
                      />
                      <Fill as="span">
                        Stored config is invalid for the current schema
                      </Fill>
                    </Stack>
                    <Stack direction="row" gap="xs" wrap justify="end">
                      {conflictContext && (
                        <ConflictActions conflict={conflictContext} />
                      )}
                      <Button
                        variant="ghost"
                        onClick={() => setShowDiff((v) => !v)}
                        className={DESTRUCTIVE_ACTION_CLASS}
                      >
                        <Icon icon={differenceIcon} className="size-3.5" />
                        {showDiff ? "Hide diff" : "View diff"}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setShowRaw(true)}
                        className={DESTRUCTIVE_ACTION_CLASS}
                      >
                        View raw
                      </Button>
                      <Button
                        variant="ghost"
                        loading={resetOverrideM.isPending}
                        onClick={handleAcceptAll}
                        className={DESTRUCTIVE_ACTION_CLASS}
                      >
                        Reset to defaults
                      </Button>
                    </Stack>
                    {conflictEntry.issues &&
                      conflictEntry.issues.length > 0 && (
                        // eslint-disable-next-line spacing/no-adhoc-spacing -- ml indents the issue list under the banner heading (no named margin utility)
                        <Stack gap="sm" className="ml-6">
                          {conflictEntry.issues.map((issue, i) => {
                            const value = drillPath(
                              conflictEntry.overrideValues,
                              issue.path,
                            );
                            const label =
                              issue.path.length > 0
                                ? issue.path.join(".")
                                : "(root)";
                            return (
                              <Stack key={i} gap="xs">
                                <Text
                                  as="div"
                                  variant="caption"
                                  className="text-destructive/90"
                                >
                                  <code className="rounded-sm bg-destructive/15 px-xs font-medium">
                                    {label}
                                  </code>
                                  {" — "}
                                  {issue.message}
                                </Text>
                                {value === MISSING ? (
                                  <Text as="div" variant="caption" tone="muted">
                                    (value missing)
                                  </Text>
                                ) : (
                                  <HighlightedCode
                                    code={JSON.stringify(value, null, 2)}
                                    lang="json"
                                  />
                                )}
                              </Stack>
                            );
                          })}
                        </Stack>
                      )}
                  </Stack>
                </Text>
                {showDiff && (
                  <InvalidDiff
                    storePath={registration.storePath}
                    scopeId={scopeId}
                  />
                )}
              </>
            ) : isSoftConflict ? (
              <Text
                as="div"
                variant="body"
                // eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the soft-conflict banner from the fields below (no named margin utility)
                className="mb-2 rounded-md border border-warning/30 bg-warning/10 px-md py-sm text-warning"
              >
                <Stack
                  direction="row"
                  gap="sm"
                  align="center"
                  justify="between"
                >
                  <span>Defaults updated — no conflicts</span>
                  <Button
                    variant="ghost"
                    loading={acknowledgeM.isPending}
                    onClick={handleDismiss}
                    className={cn(WARNING_ACTION_CLASS, rigidClass())}
                  >
                    Dismiss
                  </Button>
                </Stack>
              </Text>
            ) : (
              <>
                <Text
                  as="div"
                  variant="body"
                  // eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the hash-conflict banner from the fields below (no named margin utility)
                  className="mb-2 rounded-md border border-warning/30 bg-warning/10 px-md py-sm text-warning"
                >
                  <Stack gap="xs">
                    <Stack direction="row" gap="sm" align="center">
                      <Icon
                        icon={warningIcon}
                        className={cn("size-4", rigidClass())}
                      />
                      <Fill as="span">
                        {canMerge && trueConflictKeys!.length > 0
                          ? `Upstream defaults changed — ${trueConflictKeys!.length} field${trueConflictKeys!.length === 1 ? "" : "s"} need${trueConflictKeys!.length === 1 ? "s" : ""} your attention`
                          : canMerge
                            ? "Upstream defaults changed — ready to merge cleanly"
                            : "Upstream defaults changed"}
                      </Fill>
                    </Stack>
                    <Stack direction="row" gap="xs" wrap justify="end">
                      {conflictContext && (
                        <ConflictActions conflict={conflictContext} />
                      )}
                      <Button
                        variant="ghost"
                        onClick={() => setShowDiff((v) => !v)}
                        className={WARNING_ACTION_CLASS}
                      >
                        <Icon icon={differenceIcon} className="size-3.5" />
                        {showDiff ? "Hide diff" : "View diff"}
                      </Button>
                      {canMerge && (
                        <Button
                          variant="ghost"
                          loading={mergeM.isPending}
                          onClick={handleMerge}
                          className={WARNING_ACTION_CLASS}
                        >
                          <Icon icon={mergeIcon} className="size-3.5" />
                          Merge
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        loading={resetOverrideM.isPending}
                        onClick={handleAcceptAll}
                        className={WARNING_ACTION_CLASS}
                      >
                        Accept all new defaults
                      </Button>
                      <Button
                        variant="ghost"
                        loading={acknowledgeM.isPending}
                        onClick={handleDismiss}
                        className={WARNING_ACTION_CLASS}
                      >
                        Keep my values
                      </Button>
                    </Stack>
                  </Stack>
                </Text>
                {showDiff && (
                  <ConflictDiff
                    storePath={registration.storePath}
                    scopeId={scopeId}
                  />
                )}
              </>
            ))}
          {/* The fields — and ONLY the fields — are the panel body. Everything
              above is pane chrome and stays outside it: the scope tabs, the
              three conflict banners, the Reset all / Stop customizing / Raw file
              toolbar, and the raw + diff views. The panel publishes the rail,
              the row height and the hairlines between bands; it owns neither the
              scroll (PaneChrome's is already the scroller) nor the width (the
              pane's own role). */}
          <ControlPanelPane>
            {Object.entries(registration.descriptor.fields).map(
              ([key, field]) => (
                <ConfigField
                  key={key}
                  fieldKey={key}
                  field={field}
                  value={valueFor(key)}
                  storePath={registration.storePath}
                  scopeId={scopeId}
                  originValue={conflictEntry?.originValues[key]}
                  trueConflictKeys={trueConflictKeys}
                  tier={tierFor(key)}
                />
              ),
            )}
          </ControlPanelPane>
        </>
      )}
    </>
  );
}

function RawFileView({
  storePath,
  scopeId,
}: {
  storePath: string;
  scopeId: string | undefined;
}) {
  const raw = useLive(configRawFile, { path: storePath, scopeId });

  if (raw.status === "loading") return <Loading />;
  if (raw.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the raw files"
        error={raw.error}
        refetch={raw.refetch}
      />
    );
  }
  // The files are the desktop's: a host without the computer says so.
  if (raw.status === "unavailable")
    return <Placeholder tone="muted">{raw.message}</Placeholder>;
  const data = raw.data;

  // The running app resolves to the user-layer origin (the propagated git config).
  // It normally equals the git origin; when it diverges a build/propagation is
  // pending, and that file is the one the app actually reads — worth surfacing.
  const showResolved = data.origin !== null && data.origin !== data.gitOrigin;

  return (
    <Stack gap="md">
      <RawSection
        label="User override"
        path={data.overridePath}
        code={data.override}
      />
      <RawSection
        label="Git override"
        path={data.gitOverridePath}
        code={data.gitOverride}
      />
      <RawSection
        label="Origin (defaults)"
        path={data.gitOriginPath}
        code={data.gitOrigin}
      />
      {showResolved && (
        <RawSection
          label="Resolved origin (app reads — build pending)"
          path={data.originPath}
          code={data.origin}
        />
      )}
    </Stack>
  );
}

function RawSection({
  label,
  path,
  code,
}: {
  label: string;
  path: string;
  code: string | null;
}) {
  return (
    <section>
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the section label from the code block below (no named margin utility) */}
      <Text as="div" variant="caption" tone="muted" className="mb-1">
        <Stack direction="row" gap="sm" align="baseline">
          <span className={cn("whitespace-nowrap font-medium", rigidClass())}>
            {label}
          </span>
          <Fill
            as="span"
            className="truncate font-mono opacity-70"
            title={path}
          >
            {path}
          </Fill>
        </Stack>
      </Text>
      {code !== null ? (
        <HighlightedCode code={code} lang="json" />
      ) : (
        <Placeholder>not set</Placeholder>
      )}
    </section>
  );
}
