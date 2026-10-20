import type { ReactElement, ReactNode } from "react";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  prototypesList,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { prototypeDetailPane } from "../panes";
import { PrototypeDetailProvider, usePrototypeDetail } from "../context";
import { Canvas } from "./canvas";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const warningIcon = symbol("warning");

/**
 * The detail pane: the prototype's canvas of frames. Its header controls (copy
 * id, Done, the layout switch, the add buttons) are NOT rendered here — they
 * are contributions to `prototypeDetailPane.Actions`, so any plugin can add to
 * the header. The state they share lives in {@link PrototypeDetailProvider},
 * which wraps `PaneChrome` so the header renders inside it. The canvas is
 * remembered for this pane instance, so a reload reopens it as it was.
 */
export function PrototypeDetail(): ReactElement {
  const { name } = prototypeDetailPane.useParams();
  const instance = prototypeDetailPane.useRouteEntry()?.uuid;
  return (
    <PrototypeDetailProvider name={name} remember={instance}>
      <PaneChrome pane={prototypeDetailPane}>
        <PrototypeCanvas />
      </PaneChrome>
    </PrototypeDetailProvider>
  );
}

/**
 * The pane's header name: the prototype's own `<title>` — never `name`, a
 * minted id that says nothing to a person. Loading while the list is unknown;
 * the id, monospaced, only when there is no such folder (the one case it is the
 * only true thing left to say).
 */
export function PrototypeTitle(): ReactNode {
  const { name } = prototypeDetailPane.useParams();
  const result = useLive(prototypesList);
  const unknown = <span className="font-mono">{name}</span>;
  return matchResource(result, {
    loading: () => <Loading variant="text" />,
    error: () => unknown,
    ready: (rows) => {
      const meta = rows.find((p) => p.name === name);
      return meta ? <>{meta.title}</> : unknown;
    },
  });
}

/**
 * The pane body — also what a surface mounting its own provider draws to show
 * the whole canvas (Present's canvas page). Each meta carries its `rev`, the
 * live frames' cache-bust.
 */
export function PrototypeCanvas(): ReactNode {
  const { name } = usePrototypeDetail();
  return matchResource(useLive(prototypesList), {
    loading: () => <Loading variant="block" />,
    ready: (rows) => {
      const meta = rows.find((p) => p.name === name) ?? null;
      if (!meta) {
        return (
          <Text as="div" variant="body" tone="muted" className="p-lg">
            Prototype not found.
          </Text>
        );
      }
      return (
        <Column
          className="h-full"
          header={<ProblemBanner meta={meta} />}
          body={<Canvas meta={meta} />}
          scrollBody={false}
        />
      );
    },
  });
}

/**
 * What is wrong with this prototype's folder, above the canvas. Prototypes are
 * user content, not code, so the self-contained contract is enforced when the
 * folder is read and reported here — in front of the person who just wrote it.
 */
function ProblemBanner({ meta }: { meta: PrototypeMeta }): ReactElement | null {
  if (meta.problems.length === 0) return null;
  return (
    <Inset pad="sm">
      <Stack direction="col" gap="2xs">
        <Badge variant="warning" icon={<Icon icon={warningIcon} />}>
          {meta.problems.length === 1
            ? "1 problem with this folder"
            : `${String(meta.problems.length)} problems with this folder`}
        </Badge>
        {meta.problems.map((p) => (
          <Text
            key={`${p.path}:${p.detail}`}
            as="div"
            variant="caption"
            tone="muted"
          >
            {p.path === "" ? p.detail : `${p.path} — ${p.detail}`}
          </Text>
        ))}
      </Stack>
    </Inset>
  );
}
