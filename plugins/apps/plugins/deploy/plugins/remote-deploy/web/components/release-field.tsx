import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type {
  ClientFieldReaders,
  ClientFieldsResolverProps,
} from "@plugins/network/plugins/live/web";
import {
  useServerHealthMap,
  type ServerHealthRow,
} from "@plugins/apps/plugins/deploy/plugins/health/web";
import type { Deployment } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import type { PlatformTag } from "@plugins/release/core";
import type { releaseFields } from "../../core";
import {
  releaseStateOf,
  useReleaseInfo,
  type ReleaseInfo,
} from "../internal/use-release-info";
import { ReleaseChip } from "./release-chip";

type ReleaseFieldsRecord = NonNullable<(typeof releaseFields)["__fields"]>;

const ReleaseInfosContext = createContext<ReadonlyMap<
  string,
  ReleaseInfo
> | null>(null);

/**
 * The `Release` cell: the chip of the row's probed info, read from the infos
 * the resolver publishes around the list (a cell is handed only the field's
 * value, the state — the chip also needs the snapshot behind it).
 */
export function ReleaseCell({ row }: { row: Deployment }): ReactNode {
  const infos = useContext(ReleaseInfosContext);
  if (infos === null) {
    throw new Error("ReleaseCell rendered outside the release resolver.");
  }
  return <ReleaseChip info={infos.get(row.id)} />;
}

/**
 * Resolves the deployments list's `release` client field.
 *
 * The answer is per `(composition, platform)` — one query per row. Hooks cannot
 * be called in a loop, so each pair is asked by its own headless component and
 * folded back into one map; the values read the map synchronously, which keeps
 * filter/group/sort in agreement with the chips instead of trailing them. The
 * value is `null` while unresolved (the column never showed pending).
 */
export function ReleaseFieldResolver({
  rows,
  render,
}: ClientFieldsResolverProps<Deployment, ReleaseFieldsRecord>): ReactNode {
  const [infos, setInfos] = useState<ReadonlyMap<string, ReleaseInfo>>(
    new Map(),
  );

  const onResolve = useCallback((deploymentId: string, info: ReleaseInfo) => {
    setInfos((prev) =>
      prev.get(deploymentId) === info
        ? prev
        : new Map(prev).set(deploymentId, info),
    );
  }, []);

  // Exactly the servers these rows belong to (today, one).
  const serverIds = useMemo(
    () => Array.from(new Set(rows.map((d) => d.serverId))),
    [rows],
  );
  const health = useServerHealthMap(serverIds);

  // Not known until the servers' platforms are (there is no candidate question
  // before that): the column is pending, then each row reads its probed state
  // synchronously — null while that row's probe has not answered.
  const values = useMemo<
    ResourceResult<ClientFieldReaders<Deployment, ReleaseFieldsRecord>>
  >(
    () =>
      mapResource(health, () => ({
        release: (d: Deployment) => releaseStateOf(infos.get(d.id)),
      })),
    [health, infos],
  );

  return (
    <ReleaseInfosContext.Provider value={infos}>
      {health.status === "ready" ? (
        <CandidateProbes
          rows={rows}
          platforms={health.data}
          onResolve={onResolve}
        />
      ) : null}
      {render(values)}
    </ReleaseInfosContext.Provider>
  );
}

/**
 * One probe per row that has a platform to ask about. A server with no verified
 * platform has no candidate question at all — its rows carry no probe and their
 * cell renders nothing, the honest reading of "we have not discovered what this
 * box accepts". Until the verdicts load there is no question to ask yet either (no probe mounted).
 */
function CandidateProbes({
  rows,
  platforms,
  onResolve,
}: {
  rows: readonly Deployment[];
  platforms: ReadonlyMap<string, ServerHealthRow>;
  onResolve: (deploymentId: string, info: ReleaseInfo) => void;
}): ReactNode {
  return (
    <>
      {rows.map((d) => {
        const platform = platforms.get(d.serverId)?.platform ?? null;
        if (!platform) return null;
        return (
          <CandidateProbe
            key={d.id}
            deploymentId={d.id}
            composition={d.compositionId}
            platform={platform}
            onResolve={onResolve}
          />
        );
      })}
    </>
  );
}

/**
 * One `(composition, platform)` question, mounted as its own component so its
 * hooks are stable while the set of rows changes. Renders nothing — it holds a
 * subscription and reports its answer upward.
 */
function CandidateProbe({
  deploymentId,
  composition,
  platform,
  onResolve,
}: {
  deploymentId: string;
  composition: string;
  platform: PlatformTag;
  onResolve: (deploymentId: string, info: ReleaseInfo) => void;
}): null {
  const info = useReleaseInfo(composition, platform);
  useEffect(() => {
    onResolve(deploymentId, info);
  }, [deploymentId, info, onResolve]);
  return null;
}
