import type { ReactElement, ReactNode } from "react";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
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
 * The detail pane: the prototype's canvas of frames, running edge to edge under
 * its header — drawn as a floating card over the canvas's top-left corner
 * (`PaneChrome header="card"`). The header's controls (copy id, pin, Done)
 * are NOT rendered here — they are contributions to
 * `prototypeDetailPane.Actions`, so any plugin can add to the header. The state
 * they share lives in {@link PrototypeDetailProvider}, which wraps `PaneChrome`
 * so the header renders inside it. The canvas is remembered for this pane
 * instance, so a reload reopens it as it was.
 */
export function PrototypeDetail(): ReactElement {
  const { name } = prototypeDetailPane.useParams();
  const instance = prototypeDetailPane.useRouteEntry()?.uuid;
  return (
    <PrototypeDetailProvider name={name} remember={instance}>
      <PaneChrome pane={prototypeDetailPane} header="card">
        <PrototypeCanvas />
      </PaneChrome>
    </PrototypeDetailProvider>
  );
}

/**
 * The pane's header name, as a trail: `Prototypes / <title>` — the app in the
 * faint ink, a fainter `/`, then the prototype's own `<title>` at the title's
 * weight, the one part that ellipsizes. The app and the `/` step aside on a
 * narrow window (the title keeps the room). Never `name`, a minted id that says
 * nothing to a person: loading while the list is unknown, and the id,
 * monospaced, only when there is no such folder (the one case it is the only
 * true thing left to say).
 */
export function PrototypeTitle(): ReactNode {
  const { name } = prototypeDetailPane.useParams();
  const result = useLive(prototypesList);
  const unknown = <span className="font-mono">{name}</span>;
  return (
    <Stack
      direction="row"
      gap="sm"
      align="center"
      className={cn(yieldClass("x"), "px-xs")}
    >
      <span className="font-normal text-faint-foreground max-[1150px]:hidden">
        Prototypes
      </span>
      <span
        aria-hidden
        className="font-normal text-faint-foreground/55 max-[1150px]:hidden"
      >
        /
      </span>
      <Text>
        {matchResource(result, {
          loading: () => <Loading variant="text" />,
          error: () => unknown,
          ready: (rows) => {
            const meta = rows.find((p) => p.name === name);
            return meta ? meta.title : unknown;
          },
        })}
      </Text>
    </Stack>
  );
}

/**
 * The pane body. Each meta carries its `rev`, the live frames' cache-bust.
 */
function PrototypeCanvas(): ReactNode {
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
        // positioning host for the problem card floated over the canvas's corner
        <div className="relative h-full">
          <Canvas meta={meta} />
          <ProblemBanner meta={meta} />
        </div>
      );
    },
  });
}

/**
 * What is wrong with this prototype's folder, floated over the canvas's
 * bottom-left corner (the header card holds the top). Prototypes are user
 * content, not code, so the self-contained contract is enforced when the
 * folder is read and reported here — in front of the person who just wrote it.
 */
function ProblemBanner({ meta }: { meta: PrototypeMeta }): ReactElement | null {
  if (meta.problems.length === 0) return null;
  return (
    <Pin to="bottom-left" offset="md">
      <Surface level="float">
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
      </Surface>
    </Pin>
  );
}
